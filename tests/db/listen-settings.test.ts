// Listening settings on a real Postgres (GOAL.md Phase 2: "Voice, speed and order settings
// persist per user"): voice and speed (Phase 1 core tables) and the newsletter order
// (supabase/migrations/20261124150000_listen_settings.sql), written as the signed-in user
// under RLS, the way lib/briefing/settings.ts writes them.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

describe.skipIf(!databaseUrl)("listening settings on real Postgres", () => {
  let db: TestDatabase;
  const A = randomUUID();
  const B = randomUUID();
  const feeds: Record<string, string[]> = {};

  const q = (sql: string, params?: unknown[]) => db.admin.query(sql, params);
  const row = async (id: string) =>
    (await q("select voice, speed, feed_order from public.user_settings where user_id = $1", [id])).rows[0];

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const id of [A, B]) {
      await q("insert into auth.users (id) values ($1)", [id]);
      await q("insert into public.user_settings (user_id) values ($1)", [id]);
      feeds[id] = [];
      for (const n of [1, 2, 3]) {
        const r = await q(
          "insert into public.web_feeds (user_id, feed_url, feed_format, title) values ($1, $2, 'rss', $3) returning id",
          [id, `https://feed${n}-${id.slice(0, 8)}.example/rss`, `Invented feed ${n}`],
        );
        feeds[id].push(r.rows[0].id);
      }
    }
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("new users start with no order (feeds read newest first), af_heart and 1.00x", async () => {
    expect(await row(A)).toEqual({ voice: "af_heart", speed: "1.00", feed_order: [] });
  });

  it("a signed-in user saves their own voice, speed and order, and they persist", async () => {
    const order = [feeds[A][2], feeds[A][0], feeds[A][1]];
    const r = await attempt(
      db.admin,
      { kind: "user", id: A },
      "update public.user_settings set voice = $1, speed = $2, feed_order = $3, updated_at = now() where user_id = $4",
      ["bm_daniel", 1.25, order, A],
    );
    expect(r.error).toBeNull();
    expect(r.rowCount).toBe(1);
    expect(await row(A)).toEqual({ voice: "bm_daniel", speed: "1.25", feed_order: order });
  });

  it("a user cannot change another user's listening settings", async () => {
    const before = await row(B);
    const r = await attempt(
      db.admin,
      { kind: "user", id: A },
      "update public.user_settings set voice = 'bm_daniel', speed = 2, feed_order = $1 where user_id = $2",
      [[feeds[A][0]], B],
    );
    expect(r.error).toBeNull();
    expect(r.rowCount).toBe(0);
    expect(await row(B)).toEqual(before);
  });

  it("a user reads only their own order", async () => {
    const r = await attempt(db.admin, { kind: "user", id: B }, "select user_id, feed_order from public.user_settings");
    expect(r.rows).toEqual([{ user_id: B, feed_order: [] }]);
  });

  it("anon cannot read or write listening settings", async () => {
    expect((await attempt(db.admin, { kind: "anon" }, "select feed_order from public.user_settings")).error?.code).toBe("42501");
    expect(
      (await attempt(db.admin, { kind: "anon" }, "update public.user_settings set feed_order = '{}'")).error?.code,
    ).toBe("42501");
  });

  it.each([
    ["more than 200 ids", Array.from({ length: 201 }, () => randomUUID())],
    ["a null id", [randomUUID(), null]],
  ])("the order refuses %s", async (_label, value) => {
    const r = await attempt(db.admin, { kind: "user", id: A }, "update public.user_settings set feed_order = $1 where user_id = $2", [
      value,
      A,
    ]);
    expect(r.error?.code).toBe("23514");
  });

  it("changing voice, speed or order does not touch the delivery schedule", async () => {
    const schedule = async () =>
      (await q("select * from private.pull_schedule where user_id = $1", [A])).rows[0] ?? null;
    const before = await schedule();
    await attempt(
      db.admin,
      { kind: "user", id: A },
      "update public.user_settings set voice = 'af_heart', speed = 0.75, feed_order = $1 where user_id = $2",
      [[feeds[A][1]], A],
    );
    expect(await schedule()).toEqual(before);
  });

  it("removing a feed leaves its id in the order harmlessly (the briefing ignores it)", async () => {
    await as(db.admin, { kind: "service" }, (sq) => sq("delete from public.web_feeds where id = $1", [feeds[A][1]]));
    expect((await row(A)).feed_order).toEqual([feeds[A][1]]);
  });
});
