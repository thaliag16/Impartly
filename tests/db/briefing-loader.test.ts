// The briefing loader on a real Postgres (GOAL.md Phase 2: "Briefing renders ahead of
// time"): lib/briefing/load.ts reading as the signed-in user, under RLS, with the window
// from public.delivery_due_at (supabase/migrations/20261124170000_briefing_loader.sql,
// server only), then lib/briefing/script.ts. A second user's rows never appear.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLatestBriefing, scriptFor } from "../../lib/briefing/load";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

// 08:00 in Los Angeles. A's delivery is 07:00 there (15:00Z), so with a 30-minute lead the
// window starts at 14:30Z. B has no settings row: 07:00 UTC today, window from 06:30Z.
const NOW = "2026-11-24T16:00:00Z";

describe.skipIf(!databaseUrl)("briefing loader on real Postgres", () => {
  let db: TestDatabase;
  const A = randomUUID();
  const B = randomUUID();
  const feed: Record<string, string> = {};
  const issue: Record<string, string> = {};

  const q = (sql: string, params?: unknown[]) => db.admin.query(sql, params);

  async function addFeed(key: string, user: string, title: string, included = true) {
    feed[key] = (
      await q(
        "insert into public.web_feeds (user_id, feed_url, feed_format, title, included) values ($1, $2, 'rss', $3, $4) returning id",
        [user, `https://${key.toLowerCase()}-${user.slice(0, 8)}.example/rss`, title, included],
      )
    ).rows[0].id;
  }

  async function addIssue(
    key: string,
    user: string,
    feedKey: string,
    opts: { created: string; received: string; subject: string; partial?: boolean; summaries?: [string, string][] },
  ) {
    issue[key] = (
      await q(
        `insert into public.newsletters (user_id, feed_id, provider_message_id, sender_address, subject, received_at, body_text, partial, created_at)
         values ($1, $2, $3, 'feed@feeds.example', $4, $5, 'Invented body.', $6, $7) returning id`,
        [user, feed[feedKey], key, opts.subject, opts.received, opts.partial ?? false, opts.created],
      )
    ).rows[0].id;
    for (const [length, text] of opts.summaries ?? []) {
      await q("insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, $3, $4)", [
        user,
        issue[key],
        length,
        text,
      ]);
    }
  }

  /** delivery_due_at as the server (service role) calls it. */
  async function dueAt(args: Record<string, unknown>) {
    // As PostgREST answers: a JSON string, not the Date node-postgres makes.
    return as(db.admin, { kind: "service" }, async (run) =>
      (await run("select public.delivery_due_at($1, $2, $3, $4)::text as v", [args.p_now, args.p_time, args.p_tz, args.p_lead_minutes])).rows[0].v as string,
    );
  }

  /**
   * A stand-in for the user's Supabase client: the from().select().gte().order().limit()
   * reads lib/briefing/load.ts makes, run as SQL as that user (authenticated, under RLS),
   * the way PostgREST runs them.
   */
  function userClient(user: string) {
    const ident = (v: string) => {
      if (!/^[a-z_]+$/.test(v)) throw new Error(`unexpected identifier ${v}`);
      return v;
    };
    return {
      from(table: string) {
        const q = { cols: "*", where: [] as string[], params: [] as unknown[], order: "", limit: "" };
        const builder = {
          select(cols: string) {
            q.cols = cols.split(",").map((c) => ident(c.trim())).join(", ");
            return builder;
          },
          gte(col: string, value: unknown) {
            q.params.push(value);
            q.where.push(`${ident(col)} >= $${q.params.length}`);
            return builder;
          },
          order(col: string, opts?: { ascending?: boolean }) {
            q.order = ` order by ${ident(col)} ${opts?.ascending === false ? "desc" : "asc"}`;
            return builder;
          },
          limit(n: number) {
            q.limit = ` limit ${Number(n)}`;
            return builder;
          },
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            const where = q.where.length ? ` where ${q.where.join(" and ")}` : "";
            const sql = `select ${q.cols} from public.${ident(table)}${where}${q.order}${q.limit}`;
            return attempt(db.admin, { kind: "user", id: user }, sql, q.params)
              .then((r) => ({
                data: r.error ? null : r.rows.map(jsonish),
                error: r.error ? { code: r.error.code } : null,
              }))
              .then(resolve, reject);
          },
        };
        return builder;
      },
    } as never;
  }
  /** pg gives Dates and numerics; PostgREST gives JSON strings. */
  const jsonish = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));

  const readersFor = (user: string) => ({ user: userClient(user), rpc: (_fn: string, args: Record<string, unknown>) => dueAt(args) });
  const load = (user: string, lead = 30, now = NOW) => loadLatestBriefing(readersFor(user), { leadMinutes: lead, now: new Date(now) });
  const ids = (out: Awaited<ReturnType<typeof load>>) => (out.ok ? out.value.items.map((i) => i.id) : out);

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const id of [A, B]) await q("insert into auth.users (id) values ($1)", [id]);
    await addFeed("F1", A, "Invented Weekly");
    await addFeed("F2", A, "Quarry Daily");
    await addFeed("OFF", A, "Switched Off Digest", false);
    await addFeed("FB", B, "Other User Letter");
    await q(
      "insert into public.user_settings (user_id, delivery_time, timezone, summary_length, feed_order) values ($1, '07:00', 'America/Los_Angeles', 'brief', $2)",
      [A, [feed.F2, feed.F1]],
    );

    // Stored for today's delivery (from 14:30Z), though published yesterday.
    await addIssue("old-but-new", A, "F1", {
      created: "2026-11-24T14:40:00Z",
      received: "2026-11-23T09:00:00Z",
      subject: "Larkspur raises a seed round",
      summaries: [["brief", "Larkspur Robotics raised 4 million dollars."]],
    });
    await addIssue("two-lengths", A, "F2", {
      created: "2026-11-24T14:50:00Z",
      received: "2026-11-24T13:00:00Z",
      subject: "Quarry markets wrap",
      partial: true,
      summaries: [
        ["deep", "A long invented summary that should not be chosen."],
        ["brief", "Invented markets closed higher."],
      ],
    });
    // Yesterday's delivery window: not in today's briefing.
    await addIssue("yesterday", A, "F1", {
      created: "2026-11-23T14:45:00Z",
      received: "2026-11-23T12:00:00Z",
      subject: "Yesterday's issue",
      summaries: [["brief", "Old invented news."]],
    });
    await addIssue("switched-off", A, "OFF", {
      created: "2026-11-24T14:50:00Z",
      received: "2026-11-24T14:00:00Z",
      subject: "Should not play",
      summaries: [["brief", "Invented news from a switched-off newsletter."]],
    });
    await addIssue("no-summary", A, "F2", {
      created: "2026-11-24T14:55:00Z",
      received: "2026-11-24T14:10:00Z",
      subject: "Not summarized yet",
    });
    await addIssue("other-user", B, "FB", {
      created: "2026-11-24T15:30:00Z",
      received: "2026-11-24T15:00:00Z",
      subject: "Another user's issue",
      summaries: [["brief", "Invented news for the other user."]],
    });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("returns the user's summaries of issues stored since the latest delivery's pull started, one per issue", async () => {
    const out = await load(A);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.deliveryAt).toBe("2026-11-24T15:00:00.000Z");
    expect(out.value.windowStart).toBe("2026-11-24T14:30:00.000Z");
    expect(out.value.feedOrder).toEqual([feed.F2, feed.F1]);
    // Oldest received first; yesterday's, switched-off and unsummarized issues left out.
    expect(ids(out)).toEqual([issue["old-but-new"], issue["two-lengths"]]);
    expect(out.value.items[1]).toEqual({
      id: issue["two-lengths"],
      feedId: feed.F2,
      source: "Quarry Daily",
      subject: "Quarry markets wrap",
      summary: "Invented markets closed higher.", // the user's length (brief), not the deep one
      partial: true,
      receivedAt: "2026-11-24T13:00:00.000Z",
    });
  });

  it("a second user gets only their own rows, and never the first user's", async () => {
    const outB = await load(B);
    expect(outB.ok).toBe(true);
    if (!outB.ok) return;
    // B has no settings row: 07:00 UTC, so today's window starts at 06:30Z.
    expect(outB.value.deliveryAt).toBe("2026-11-24T07:00:00.000Z");
    expect(outB.value.feedOrder).toEqual([]);
    expect(ids(outB)).toEqual([issue["other-user"]]);
    const outA = await load(A);
    expect(JSON.stringify(outA)).not.toContain(issue["other-user"]);
    expect(JSON.stringify(outA)).not.toContain("Other User Letter");
    // The reads themselves: as A, B's issue, summary and feed are not visible at all.
    for (const sql of [
      "select id from public.newsletters where user_id = $1",
      "select id from public.summaries where user_id = $1",
      "select id from public.web_feeds where user_id = $1",
    ]) {
      expect((await attempt(db.admin, { kind: "user", id: A }, sql, [B])).rows).toEqual([]);
    }
  });

  it("the window follows the lead: with no lead, only issues stored from the delivery itself", async () => {
    const out = await load(A, 0);
    expect(out.ok && out.value.windowStart).toBe("2026-11-24T15:00:00.000Z");
    expect(ids(out)).toEqual([]);
  });

  it("before today's pull starts, the briefing is yesterday's delivery", async () => {
    const out = await load(A, 30, "2026-11-24T14:00:00Z"); // 06:00 in Los Angeles
    expect(out.ok && out.value.deliveryAt).toBe("2026-11-23T15:00:00.000Z");
    expect(ids(out)).toContain(issue.yesterday);
  });

  it("delivery_due_at is the scheduled pull's math, for the server only", async () => {
    const at = async (now: string, time: string, tz: string, lead: number) =>
      new Date(await dueAt({ p_now: now, p_time: time, p_tz: tz, p_lead_minutes: lead })).toISOString();
    expect(await at("2026-11-24T14:29:00Z", "07:00", "America/Los_Angeles", 30)).toBe("2026-11-23T15:00:00.000Z");
    expect(await at("2026-11-24T14:30:00Z", "07:00", "America/Los_Angeles", 30)).toBe("2026-11-24T15:00:00.000Z");
    expect(await at("2026-11-24T08:00:00Z", "07:00", "UTC", 0)).toBe("2026-11-24T07:00:00.000Z");
    for (const bad of [
      { p_tz: "Mars/Base" },
      { p_lead_minutes: -1 },
      { p_lead_minutes: 361 },
    ]) {
      const args = { p_now: NOW, p_time: "07:00", p_tz: "UTC", p_lead_minutes: 30, ...bad };
      await expect(dueAt(args)).rejects.toMatchObject({ code: "22023" });
    }
    const call = "select public.delivery_due_at(now(), '07:00', 'UTC', 30)";
    expect((await attempt(db.admin, { kind: "anon" }, call)).error?.code).toBe("42501");
    expect((await attempt(db.admin, { kind: "user", id: A }, call)).error?.code).toBe("42501");
    const r = await q(
      `select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'delivery_due_at'`,
    );
    expect(r.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });

  it("turns into a script in the user's order", async () => {
    const out = await load(A);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const script = scriptFor(out.value);
    expect(script.sections.map((s) => s.title)).toEqual(["Quarry Daily", "Invented Weekly"]);
    expect(script.storyCount).toBe(2);
    const spoken = script.sentences.map((s) => s.text).join(" ");
    expect(spoken).toContain("Invented markets closed higher.");
    expect(spoken).toContain("Larkspur Robotics raised 4 million dollars.");
    expect(spoken).not.toMatch(/Other User|switched-off|Old invented news/);
  });
});
