// The picker's server-only SQL functions on a real Postgres (migration
// 20261123160000_feed_picker.sql): switching a feed on or off, removing it, and the
// per-user discovery rate limit. Every function takes the user id and touches only that
// user's rows; only the service role may call them.

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

const DENIED = "42501";

describe.skipIf(!databaseUrl)("feed picker functions on real Postgres", () => {
  let db: TestDatabase;
  const svc = async (sql: string, params: unknown[]) =>
    (await as(db.admin, { kind: "service" }, (q) => q(sql, params))).rows[0];

  const newUser = async () => {
    const id = randomUUID();
    await db.admin.query("insert into auth.users (id) values ($1)", [id]);
    return id;
  };
  const newFeed = async (userId: string) =>
    (
      await db.admin.query(
        "insert into public.web_feeds (user_id, feed_url, feed_format, title) values ($1, $2, 'rss', 'Invented Feed') returning id",
        [userId, `https://feeds.example/${randomUUID()}.xml`],
      )
    ).rows[0].id as string;
  const feedRow = async (id: string) => (await db.admin.query("select * from public.web_feeds where id = $1", [id])).rows[0];
  const take = async (userId: string, limit = 3, windowSeconds = 600) =>
    (await svc("select public.feeds_discovery_take($1, $2, $3) as ok", [userId, limit, windowSeconds])).ok as boolean;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  describe("feeds_set_included", () => {
    it("switches the user's own feed off and on", async () => {
      const a = await newUser();
      const feed = await newFeed(a);
      expect((await svc("select public.feeds_set_included($1, $2, false) as ok", [a, feed])).ok).toBe(true);
      expect((await feedRow(feed)).included).toBe(false);
      expect((await svc("select public.feeds_set_included($1, $2, true) as ok", [a, feed])).ok).toBe(true);
      expect((await feedRow(feed)).included).toBe(true);
    });

    it("does nothing to another user's feed and says so", async () => {
      const a = await newUser();
      const b = await newUser();
      const feedA = await newFeed(a);
      const before = await feedRow(feedA);
      expect((await svc("select public.feeds_set_included($1, $2, false) as ok", [b, feedA])).ok).toBe(false);
      expect(await feedRow(feedA)).toEqual(before);
    });

    it("refuses a null switch value", async () => {
      const a = await newUser();
      const feed = await newFeed(a);
      const r = await attempt(db.admin, { kind: "service" }, "select public.feeds_set_included($1, $2, null)", [a, feed]);
      expect(r.error?.code).toBe("22023");
    });
  });

  describe("feeds_remove", () => {
    it("removes the user's own feed with its stored issues and summaries", async () => {
      const a = await newUser();
      const feed = await newFeed(a);
      const n = (
        await db.admin.query(
          "insert into public.newsletters (user_id, feed_id, provider_message_id, sender_address, subject, received_at, body_text) values ($1, $2, 'item-1', 'feed@feeds.example', 'Invented issue', now(), 'Invented body.') returning id",
          [a, feed],
        )
      ).rows[0].id;
      await db.admin.query(
        "insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, 'brief', 'An invented summary.')",
        [a, n],
      );
      expect((await svc("select public.feeds_remove($1, $2) as ok", [a, feed])).ok).toBe(true);
      expect(await feedRow(feed)).toBeUndefined();
      expect((await db.admin.query("select count(*)::int as n from public.newsletters where feed_id = $1", [feed])).rows[0].n).toBe(0);
      expect((await db.admin.query("select count(*)::int as n from public.summaries where newsletter_id = $1", [n])).rows[0].n).toBe(0);
    });

    it("does nothing to another user's feed and says so", async () => {
      const a = await newUser();
      const b = await newUser();
      const feedA = await newFeed(a);
      expect((await svc("select public.feeds_remove($1, $2) as ok", [b, feedA])).ok).toBe(false);
      expect(await feedRow(feedA)).toBeDefined();
    });
  });

  describe("feeds_discovery_take (rate limit)", () => {
    it("allows up to the limit in the window, then refuses", async () => {
      const a = await newUser();
      expect([await take(a), await take(a), await take(a)]).toEqual([true, true, true]);
      expect(await take(a)).toBe(false);
      expect(await take(a)).toBe(false);
      // Refusals are not recorded: still exactly 3 attempts.
      const n = (await db.admin.query("select count(*)::int as n from private.feed_discovery_attempts where user_id = $1", [a])).rows[0].n;
      expect(n).toBe(3);
    });

    it("counts each user separately", async () => {
      const a = await newUser();
      const b = await newUser();
      for (let i = 0; i < 3; i++) await take(a);
      expect(await take(a)).toBe(false);
      expect(await take(b)).toBe(true);
    });

    it("forgets attempts older than the window (and deletes them)", async () => {
      const a = await newUser();
      await db.admin.query(
        "insert into private.feed_discovery_attempts (user_id, attempted_at) select $1, now() - interval '11 minutes' from generate_series(1, 5)",
        [a],
      );
      expect(await take(a, 3, 600)).toBe(true);
      const n = (await db.admin.query("select count(*)::int as n from private.feed_discovery_attempts where user_id = $1", [a])).rows[0].n;
      expect(n).toBe(1);
    });

    it("holds under concurrent calls: never more than the limit", async () => {
      const a = await newUser();
      const url = new URL(databaseUrl);
      url.pathname = `/${db.name}`;
      const clients = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const c = new pg.Client({ connectionString: url.toString() });
          await c.connect();
          return c;
        }),
      );
      try {
        const results = await Promise.all(
          clients.map((c) => as(c, { kind: "service" }, (q) => q("select public.feeds_discovery_take($1, 3, 600) as ok", [a]))),
        );
        expect(results.filter((r) => r.rows[0].ok === true)).toHaveLength(3);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it.each([
      [0, 600],
      [1001, 600],
      [3, 0],
      [3, 86401],
    ])("refuses out-of-range arguments (limit %i, window %i)", async (limit, windowSeconds) => {
      const a = await newUser();
      const r = await attempt(db.admin, { kind: "service" }, "select public.feeds_discovery_take($1, $2, $3)", [a, limit, windowSeconds]);
      expect(r.error?.code).toBe("22023");
    });

    it("the attempts table has row-level security and no privileges for API users", async () => {
      const rls = await db.admin.query(
        "select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname = 'feed_discovery_attempts'",
      );
      expect(rls.rows[0].relrowsecurity).toBe(true);
      const a = await newUser();
      for (const actor of [{ kind: "anon" }, { kind: "user", id: a }, { kind: "service" }] as const) {
        const sel = await attempt(db.admin, actor, "select * from private.feed_discovery_attempts");
        expect(sel.error?.code, actor.kind).toBe(DENIED);
        const ins = await attempt(db.admin, actor, "insert into private.feed_discovery_attempts (user_id) values ($1)", [a]);
        expect(ins.error?.code, actor.kind).toBe(DENIED);
      }
    });
  });

  it("anon and signed-in users cannot call any picker function, even for themselves", async () => {
    const a = await newUser();
    const feed = await newFeed(a);
    for (const actor of [{ kind: "anon" }, { kind: "user", id: a }] as const) {
      for (const [sql, params] of [
        ["select public.feeds_set_included($1, $2, false)", [a, feed]],
        ["select public.feeds_remove($1, $2)", [a, feed]],
        ["select public.feeds_discovery_take($1, 3, 600)", [a]],
      ] as const) {
        const r = await attempt(db.admin, actor, sql, [...params]);
        expect(r.error?.code, `${actor.kind}: ${sql}`).toBe(DENIED);
      }
    }
    expect((await feedRow(feed)).included).toBe(true);
  });

  it("the functions are security definer with an empty search_path", async () => {
    const r = await db.admin.query(
      `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('feeds_set_included', 'feeds_remove', 'feeds_discovery_take') order by 1`,
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.proconfig, row.proname).toEqual(['search_path=""']);
    }
  });
});
