// The render cost log on a real Postgres (GOAL.md Phase 2: "Render cost per briefing logged
// and within budget"; supabase/migrations/20261124190000_render_log.sql). Rows are written by
// the signed-in user's own client under RLS, the way lib/briefing/render-log.ts writes them.
// The generic cross-user checks are in tests/db/rls.test.ts; these cover what is particular
// to this table: the owner is always the caller, values are bounded, rows cannot be changed
// or backdated, and one user cannot flood it.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRenderLog, renderLogInput } from "../../lib/briefing/render-log";
import { attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

const DELIVERY = "2026-11-24T15:00:00.000Z";
const NO_PRIVILEGE = "42501";
const CHECK = "23514";

function row(over: Record<string, unknown> = {}) {
  const parsed = parseRenderLog(
    renderLogInput(
      {
        voice: "bm_daniel",
        speed: 1.25,
        sentences: 9,
        rendered: 7,
        cached: 2,
        characters: 1100,
        renderSeconds: 33.3,
        audioSeconds: 70,
        renderedAudioSeconds: 55,
        realTimeFactor: 33.3 / 55,
      },
      DELIVERY,
      "mobile",
    ),
  );
  if (!parsed.ok) throw new Error("fixture row is invalid");
  return { ...parsed.value, ...over };
}

/** An insert statement for a row object, the way PostgREST would send it. */
function insertSql(values: Record<string, unknown>): [string, unknown[]] {
  const cols = Object.keys(values);
  return [
    `insert into public.render_log (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning user_id`,
    cols.map((c) => values[c]),
  ];
}

describe.skipIf(!databaseUrl)("render log on real Postgres", () => {
  let db: TestDatabase;
  const A = randomUUID();
  const B = randomUUID();
  const q = (sql: string, params?: unknown[]) => db.admin.query(sql, params);

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const id of [A, B]) await q("insert into auth.users (id) values ($1)", [id]);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("a signed-in user writes one row with no user_id; the database makes it theirs", async () => {
    const r = await attempt(db.admin, { kind: "user", id: A }, ...insertSql(row()));
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([{ user_id: A }]);
    const stored = (await q("select * from public.render_log where user_id = $1", [A])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      voice: "bm_daniel",
      speed: "1.25",
      chars: 1100,
      sentences: 9,
      rendered: 7,
      cached: 2,
      audio_seconds: 70,
      rendered_audio_seconds: 55,
      render_seconds: 33.3,
      device_class: "mobile",
    });
    expect((stored[0].delivery_at as Date).toISOString()).toBe(DELIVERY);
  });

  it("holds no IP address, user agent or other fingerprint column", async () => {
    const cols = (
      await q("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'render_log' order by ordinal_position")
    ).rows.map((r) => r.column_name);
    expect(cols).toEqual([
      "id",
      "user_id",
      "delivery_at",
      "voice",
      "speed",
      "chars",
      "sentences",
      "rendered",
      "cached",
      "audio_seconds",
      "rendered_audio_seconds",
      "render_seconds",
      "device_class",
      "created_at",
    ]);
  });

  it("the second user cannot read the first user's rows, and reads their own", async () => {
    await attempt(db.admin, { kind: "user", id: B }, ...insertSql(row({ voice: "af_heart" })));
    const seenByB = await attempt(db.admin, { kind: "user", id: B }, "select user_id, voice from public.render_log");
    expect(seenByB.error).toBeNull();
    expect(seenByB.rows).toEqual([{ user_id: B, voice: "af_heart" }]);
    const aByB = await attempt(db.admin, { kind: "user", id: B }, "select id from public.render_log where user_id = $1", [A]);
    expect(aByB.rowCount).toBe(0);
  });

  it("a user cannot write a row for someone else", async () => {
    const r = await attempt(db.admin, { kind: "user", id: B }, ...insertSql(row({ user_id: A })));
    expect(r.error?.code).toBe(NO_PRIVILEGE);
  });

  it("rows cannot be backdated or given an id by the client", async () => {
    const dated = await attempt(db.admin, { kind: "user", id: A }, ...insertSql(row({ created_at: "2020-01-01T00:00:00Z" })));
    expect(dated.error?.code).toBe(NO_PRIVILEGE);
    const withId = await attempt(db.admin, { kind: "user", id: A }, ...insertSql(row({ id: randomUUID() })));
    expect(withId.error?.code).toBe(NO_PRIVILEGE);
  });

  it("the log is append-only for users: no update or delete, even of their own rows", async () => {
    const upd = await attempt(db.admin, { kind: "user", id: A }, "update public.render_log set render_seconds = 1 where user_id = $1", [A]);
    expect(upd.error?.code).toBe(NO_PRIVILEGE);
    const del = await attempt(db.admin, { kind: "user", id: A }, "delete from public.render_log where user_id = $1", [A]);
    expect(del.error?.code).toBe(NO_PRIVILEGE);
  });

  it.each([
    ["an unknown voice", { voice: "am_adam" }],
    ["a speed below 0.50", { speed: 0.45 }],
    ["a speed above 2.00", { speed: 2.05 }],
    ["negative characters", { chars: -1 }],
    ["no sentences", { sentences: 0, rendered: 0, cached: 0 }],
    ["counts that do not add up", { rendered: 1 }],
    ["nothing rendered", { rendered: 0, cached: 9 }],
    ["NaN audio", { audio_seconds: "NaN" }],
    ["infinite render time", { render_seconds: "Infinity" }],
    ["over four hours of audio", { audio_seconds: 14_401 }],
    ["negative render time", { render_seconds: -1 }],
    ["rendered audio longer than the briefing", { rendered_audio_seconds: 71 }],
    ["an unknown device class", { device_class: "iPhone 15 Pro" }],
  ])("refuses %s, even from the server", async (_label, over) => {
    const r = await attempt(db.admin, { kind: "service" }, ...insertSql(row({ user_id: A, ...over })));
    expect(r.error?.code).toBe(CHECK);
  });

  it("refuses a 101st row for one user within 24 hours (a flood guard), and counts only their own rows", async () => {
    await q("begin");
    try {
      await q(`set local role authenticated`);
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A, role: "authenticated" })]);
      const have = Number((await q("select count(*) from public.render_log")).rows[0].count);
      for (let i = have; i < 100; i++) await q(...insertSql(row()));
      await q("savepoint s");
      await expect(q(...insertSql(row()))).rejects.toMatchObject({ code: "53400" });
      await q("rollback to savepoint s");
      // Another user is not held back by A's rows.
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: B, role: "authenticated" })]);
      await expect(q(...insertSql(row()))).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await q("rollback");
    }
    // Rows older than 24 hours do not count.
    await q("begin");
    try {
      await q("insert into public.render_log (user_id, delivery_at, voice, speed, chars, sentences, rendered, cached, audio_seconds, rendered_audio_seconds, render_seconds, device_class, created_at) select $1, $2, 'af_heart', 1, 10, 1, 1, 0, 1, 1, 1, 'desktop', now() - interval '25 hours' from generate_series(1, 150)", [A, DELIVERY]);
      await q(`set local role authenticated`);
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A, role: "authenticated" })]);
      await expect(q(...insertSql(row()))).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await q("rollback");
    }
  });

  it("deleting the user deletes their render log", async () => {
    await q("begin");
    try {
      await q("delete from auth.users where id = $1", [A]);
      expect((await q("select count(*)::int as n from public.render_log where user_id = $1", [A])).rows[0].n).toBe(0);
    } finally {
      await q("rollback");
    }
  });
});
