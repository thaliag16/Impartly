// The scheduled pull on a real Postgres (supabase/migrations/20261123180000_scheduled_pull.sql
// plus lib/schedule): schedule math across time zones and both DST directions, the "due"
// query, leases under two concurrent ticks, the time budget cutting a run short and the
// next tick resuming it, per-source retry with backoff, per-user failure isolation, the
// cron job and its tick (pg_cron and pg_net are the stand-ins in supabase-shim.sql: jobs
// are recorded, nothing runs, no request leaves), and who may call what.
//
// The network is the fake in tests/web/fake-web.ts; clocks are fake. Nothing real is
// contacted.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Rpc } from "../../lib/mail";
import { createRpcPipelineStore, runPipelineForUser, type PipelineSchedule, type PipelineStore } from "../../lib/pipeline";
import { createRpcScheduleStore, createTimeBudget, runDuePulls, type ScheduleStore } from "../../lib/schedule";
import { createWebFetcher } from "../../lib/sources";
import type { SummaryProvider } from "../../lib/summarizer/types";
import { createFakeWeb, feedFixture, type FakeWeb } from "../web/fake-web";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

const rss = (body: string) => ({ status: 200, headers: { "content-type": "application/rss+xml" }, body });

function rpcOn(client: pg.Client): Rpc {
  return async (fn, args) => {
    const names = Object.keys(args);
    const params = names.map((n) => {
      const v = args[n];
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as result`;
    const r = await as(client, { kind: "service" }, (q) => q(sql, params));
    return r.rows[0].result;
  };
}

const iso = (v: unknown) => (v === null ? null : new Date(v as string | Date).toISOString());

describe.skipIf(!databaseUrl)("scheduled pull on real Postgres", () => {
  let db: TestDatabase;
  let rpc: Rpc;
  let pipelineStore: PipelineStore;
  let scheduleStore: ScheduleStore;

  const q = (sql: string, params?: unknown[]) => db.admin.query(sql, params);
  const one = async (sql: string, params?: unknown[]) => (await q(sql, params)).rows[0];

  const newUser = async (settings?: { time?: string; tz?: string }) => {
    const id = randomUUID();
    await q("insert into auth.users (id) values ($1)", [id]);
    if (settings) {
      await q("insert into public.user_settings (user_id, delivery_time, timezone) values ($1, $2, $3)", [
        id,
        settings.time ?? "07:00",
        settings.tz ?? "UTC",
      ]);
    }
    return id;
  };
  const addFeed = async (userId: string, url: string, opts: { included?: boolean; format?: string } = {}) =>
    (
      await q(
        "insert into public.web_feeds (user_id, feed_url, feed_format, title, included) values ($1, $2, $3, 'Invented feed', $4) returning id",
        [userId, url, opts.format ?? "rss", opts.included ?? true],
      )
    ).rows[0].id as string;
  const schedule = (userId: string) => one("select * from private.pull_schedule where user_id = $1", [userId]);
  const claim = (now: string, owner = randomUUID(), lead = 30, store = scheduleStore) =>
    store.claimNext({ now: new Date(now), leadMinutes: lead, leaseSeconds: 120, owner });
  const finish = (userId: string, owner: string, now: string, outcome: "complete" | "partial" | "failed", retryAt: string | null = null, error: string | null = null) =>
    scheduleStore.finish({ userId, owner, now: new Date(now), outcome, retryAt: retryAt ? new Date(retryAt) : null, error });
  /** Claims and completes everything due at `now`, so later tests start from a known state. */
  const settle = async (now: string) => {
    for (let c = await claim(now, "00000000-0000-4000-8000-000000000000"); c; c = await claim(now, "00000000-0000-4000-8000-000000000000")) {
      await finish(c.userId, "00000000-0000-4000-8000-000000000000", now, "complete");
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    rpc = rpcOn(db.admin);
    pipelineStore = createRpcPipelineStore(rpc);
    scheduleStore = createRpcScheduleStore(rpc);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  // Claims look at every user in the database, so each test starts with none.
  beforeEach(async () => {
    await q("delete from auth.users");
    await q("delete from net.http_request_queue");
    await q("delete from vault.secrets");
  });

  describe("schedule math", () => {
    const at = async (local: string, tz: string) =>
      iso((await one("select private.local_to_instant($1::timestamp, $2) as t", [local, tz])).t);

    it("an ordinary day is the plain conversion, in every kind of zone", async () => {
      expect(await at("2026-11-24 07:00", "UTC")).toBe("2026-11-24T07:00:00.000Z");
      expect(await at("2026-11-24 07:00", "America/Los_Angeles")).toBe("2026-11-24T15:00:00.000Z");
      expect(await at("2026-07-24 07:00", "America/Los_Angeles")).toBe("2026-07-24T14:00:00.000Z");
      expect(await at("2026-11-24 07:00", "Asia/Kolkata")).toBe("2026-11-24T01:30:00.000Z"); // +05:30, no DST
      expect(await at("2026-11-24 07:00", "Asia/Kathmandu")).toBe("2026-11-24T01:15:00.000Z"); // +05:45
      expect(await at("2026-11-24 07:00", "Pacific/Kiritimati")).toBe("2026-11-23T17:00:00.000Z"); // +14, the day before in UTC
      expect(await at("2026-11-24 07:00", "Pacific/Pago_Pago")).toBe("2026-11-24T18:00:00.000Z"); // -11
    });

    it("clocks go forward (northern spring): a skipped time becomes the moment the clock jumps", async () => {
      // New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z).
      expect(await at("2026-03-08 02:30", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
      expect(await at("2026-03-08 02:00", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
      expect(await at("2026-03-08 01:59", "America/New_York")).toBe("2026-03-08T06:59:00.000Z");
      expect(await at("2026-03-08 03:00", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
      expect(await at("2026-03-08 07:00", "America/New_York")).toBe("2026-03-08T11:00:00.000Z");
      // London, 2026-03-29: 01:00 GMT jumps to 02:00 BST.
      expect(await at("2026-03-29 01:30", "Europe/London")).toBe("2026-03-29T01:00:00.000Z");
    });

    it("clocks go back (northern autumn): a repeated time is its first occurrence", async () => {
      // New York, 2026-11-01: 02:00 EDT falls back to 01:00 EST; 01:30 happens at 05:30Z and 06:30Z.
      expect(await at("2026-11-01 01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
      expect(await at("2026-11-01 00:59", "America/New_York")).toBe("2026-11-01T04:59:00.000Z");
      expect(await at("2026-11-01 02:00", "America/New_York")).toBe("2026-11-01T07:00:00.000Z");
      // London, 2026-10-25: 01:30 at 00:30Z (BST) and 01:30Z (GMT).
      expect(await at("2026-10-25 01:30", "Europe/London")).toBe("2026-10-25T00:30:00.000Z");
    });

    it("the southern hemisphere, both directions", async () => {
      // Sydney: forward 2026-10-04 02:00 AEST -> 03:00 AEDT (16:00Z on the 3rd); back 2026-04-05 03:00 AEDT -> 02:00 AEST.
      expect(await at("2026-10-04 02:30", "Australia/Sydney")).toBe("2026-10-03T16:00:00.000Z");
      expect(await at("2026-04-05 02:30", "Australia/Sydney")).toBe("2026-04-04T15:30:00.000Z");
      // Lord Howe Island moves by 30 minutes: forward 02:00 -> 02:30, back 02:00 -> 01:30.
      expect(await at("2026-10-04 02:15", "Australia/Lord_Howe")).toBe("2026-10-03T15:30:00.000Z");
      expect(await at("2026-04-05 01:45", "Australia/Lord_Howe")).toBe("2026-04-04T14:45:00.000Z");
    });

    const dueAt = async (now: string, time: string, tz: string, leadMinutes = 30) =>
      iso((await one("select private.delivery_due_at($1::timestamptz, $2::time, $3, make_interval(mins => $4)) as t", [now, time, tz, leadMinutes])).t);

    it("the due delivery is the latest one whose lead time has begun", async () => {
      // 07:00 in Los Angeles is 15:00Z in November; with 30 minutes' lead it is due from 14:30Z.
      expect(await dueAt("2026-11-24T14:29:59Z", "07:00", "America/Los_Angeles")).toBe("2026-11-23T15:00:00.000Z");
      expect(await dueAt("2026-11-24T14:30:00Z", "07:00", "America/Los_Angeles")).toBe("2026-11-24T15:00:00.000Z");
      expect(await dueAt("2026-11-25T02:00:00Z", "07:00", "America/Los_Angeles")).toBe("2026-11-24T15:00:00.000Z");
      // No lead: due at the delivery time itself.
      expect(await dueAt("2026-11-24T14:59:59Z", "07:00", "America/Los_Angeles", 0)).toBe("2026-11-23T15:00:00.000Z");
      expect(await dueAt("2026-11-24T15:00:00Z", "07:00", "America/Los_Angeles", 0)).toBe("2026-11-24T15:00:00.000Z");
      // Local date ahead of UTC: Kiritimati's 07:00 on the 24th is 17:00Z on the 23rd.
      expect(await dueAt("2026-11-23T16:30:00Z", "07:00", "Pacific/Kiritimati")).toBe("2026-11-23T17:00:00.000Z");
      // Lead time reaching into the previous local day: 00:15 delivery, 30 minutes' lead.
      expect(await dueAt("2026-11-23T23:45:00Z", "00:15", "UTC")).toBe("2026-11-24T00:15:00.000Z");
    });

    it("across a DST change the daily delivery stays at 07:00 local (23- and 25-hour days)", async () => {
      // Spring: Mar 7 07:00 EST = 12:00Z, Mar 8 07:00 EDT = 11:00Z.
      expect(await dueAt("2026-03-08T10:29:00Z", "07:00", "America/New_York")).toBe("2026-03-07T12:00:00.000Z");
      expect(await dueAt("2026-03-08T10:30:00Z", "07:00", "America/New_York")).toBe("2026-03-08T11:00:00.000Z");
      // Autumn: Oct 31 07:00 EDT = 11:00Z, Nov 1 07:00 EST = 12:00Z.
      expect(await dueAt("2026-11-01T11:29:00Z", "07:00", "America/New_York")).toBe("2026-10-31T11:00:00.000Z");
      expect(await dueAt("2026-11-01T11:30:00Z", "07:00", "America/New_York")).toBe("2026-11-01T12:00:00.000Z");
      // A delivery set inside the skipped hour and inside the repeated hour.
      expect(await dueAt("2026-03-08T06:30:00Z", "02:30", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
      expect(await dueAt("2026-11-01T05:00:00Z", "01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
    });
  });

  describe("the due query", () => {
    it("only users with a switched-on feed or an active mailbox are ever claimed", async () => {
      await newUser({ time: "07:00" }); // no sources
      const off = await newUser({ time: "07:00" });
      await addFeed(off, "https://off.example/feed", { included: false });
      expect(await claim("2026-11-24T08:00:00Z")).toBeNull();
      const on = await newUser({ time: "07:00" });
      await addFeed(on, "https://on.example/feed");
      expect((await claim("2026-11-24T08:00:00Z"))?.userId).toBe(on);
    });

    it("a user with no settings row is scheduled for 07:00 UTC", async () => {
      const a = await newUser();
      await addFeed(a, "https://a.example/feed");
      const c = await claim("2026-11-24T06:45:00Z");
      expect(c && { user: c.userId, due: c.dueFor.toISOString() }).toEqual({ user: a, due: "2026-11-24T07:00:00.000Z" });
    });

    it("a new user is due at once; then not again until the next delivery's lead time", async () => {
      const a = await newUser({ time: "06:00", tz: "Asia/Tokyo" }); // 06:00 JST = 21:00Z the day before
      await addFeed(a, "https://a.example/feed");
      const owner = randomUUID();
      const c = await claim("2026-11-23T12:00:00Z", owner);
      expect(c?.dueFor.toISOString()).toBe("2026-11-22T21:00:00.000Z"); // the latest delivery, right away
      expect(c?.cycleStartedAt.toISOString()).toBe("2026-11-23T12:00:00.000Z");
      expect(await finish(a, owner, "2026-11-23T12:01:00Z", "complete")).toBe(true);
      expect(iso((await schedule(a)).completed_for)).toBe("2026-11-22T21:00:00.000Z");
      expect(await claim("2026-11-23T12:05:00Z")).toBeNull();
      expect(await claim("2026-11-23T20:29:59Z")).toBeNull();
      const next = await claim("2026-11-23T20:30:00Z");
      expect(next?.dueFor.toISOString()).toBe("2026-11-23T21:00:00.000Z");
    });

    it("missed deliveries do not pile up: after a long gap only the latest is pulled", async () => {
      const a = await newUser({ time: "07:00" });
      await addFeed(a, "https://a.example/feed");
      await settle("2026-11-20T06:30:00Z");
      const owner = randomUUID();
      const c = await claim("2026-11-24T09:00:00Z", owner);
      expect(c?.dueFor.toISOString()).toBe("2026-11-24T07:00:00.000Z");
      await finish(a, owner, "2026-11-24T09:01:00Z", "complete");
      expect(await claim("2026-11-24T09:05:00Z")).toBeNull();
    });

    it("moving the delivery time later the same day schedules that new time; earlier waits for tomorrow", async () => {
      const a = await newUser({ time: "07:00", tz: "Europe/Berlin" }); // 06:00Z in November
      await addFeed(a, "https://a.example/feed");
      await settle("2026-11-24T05:40:00Z");
      await q("update public.user_settings set delivery_time = '06:00' where user_id = $1", [a]);
      expect(await claim("2026-11-24T05:50:00Z")).toBeNull();
      await q("update public.user_settings set delivery_time = '09:00' where user_id = $1", [a]);
      expect(await claim("2026-11-24T07:29:00Z")).toBeNull();
      expect((await claim("2026-11-24T07:30:00Z"))?.dueFor.toISOString()).toBe("2026-11-24T08:00:00.000Z");
    });

    it("a lease keeps other ticks off a user until it is finished or runs out", async () => {
      const a = await newUser({ time: "07:00" });
      await addFeed(a, "https://a.example/feed");
      const first = randomUUID();
      const second = randomUUID();
      expect((await claim("2026-11-24T06:40:00Z", first))?.userId).toBe(a);
      expect(await claim("2026-11-24T06:41:59Z", second)).toBeNull(); // leased for 120 s
      const again = await claim("2026-11-24T06:42:00Z", second); // the lease ran out (the first tick died)
      expect(again?.userId).toBe(a);
      expect(again?.cycleStartedAt.toISOString()).toBe("2026-11-24T06:40:00.000Z"); // same cycle
      expect(await finish(a, first, "2026-11-24T06:42:30Z", "complete")).toBe(false); // lost its lease
      expect((await schedule(a)).completed_for).toBeNull();
      expect(await finish(a, second, "2026-11-24T06:42:30Z", "complete")).toBe(true);
      expect(iso((await schedule(a)).completed_for)).toBe("2026-11-24T07:00:00.000Z");
    });

    it("two ticks inside one transaction each: SKIP LOCKED hands them different users, never blocking", async () => {
      const a = await newUser({ time: "07:00" });
      const b = await newUser({ time: "07:00" });
      await addFeed(a, "https://a.example/feed");
      await addFeed(b, "https://b.example/feed");
      const c1 = await db.connect();
      const c2 = await db.connect();
      const call = (c: pg.Client) =>
        c.query("select public.pull_claim_next('2026-11-24T06:45:00Z', 30, 120, $1) as r", [randomUUID()]);
      await c1.query("begin");
      await c2.query("begin");
      try {
        const r1 = (await call(c1)).rows[0].r;
        const r2 = (await call(c2)).rows[0].r; // would hang here without SKIP LOCKED
        expect(new Set([r1.user_id, r2.user_id])).toEqual(new Set([a, b]));
        expect((await call(c2)).rows[0].r).toBeNull();
      } finally {
        await c1.query("commit");
        await c2.query("commit");
      }
    });

    it("pull_finish: a failure backs off 5 minutes, doubling to at most an hour; success clears it", async () => {
      const a = await newUser({ time: "07:00" });
      await addFeed(a, "https://a.example/feed");
      const t0 = Date.parse("2026-11-24T06:30:00Z");
      const backoffs: number[] = [];
      let t = t0;
      for (let i = 0; i < 6; i++) {
        const owner = randomUUID();
        const c = await claim(new Date(t).toISOString(), owner);
        expect(c?.userId).toBe(a);
        await finish(a, owner, new Date(t).toISOString(), "failed", null, "summarizer_down");
        const row = await schedule(a);
        expect(row.last_error).toBe("summarizer_down");
        expect(await claim(new Date(Date.parse(row.next_retry_at) - 1000).toISOString())).toBeNull();
        backoffs.push((Date.parse(row.next_retry_at) - t) / 60_000);
        t = Date.parse(row.next_retry_at);
      }
      expect(backoffs).toEqual([5, 10, 20, 40, 60, 60]);
      const owner = randomUUID();
      await claim(new Date(t).toISOString(), owner);
      await finish(a, owner, new Date(t).toISOString(), "complete");
      expect(await schedule(a)).toMatchObject({ failure_count: 0, next_retry_at: null, last_error: null, lease_owner: null });
      await expect(finish(a, owner, new Date(t).toISOString(), "failed", null, "Not a code!")).rejects.toThrow();
    });
  });

  describe("pipeline under the schedule", () => {
    const FEEDS = ["https://one.example/feed", "https://two.example/feed", "https://three.example/feed", "https://four.example/feed"];
    const summarizer = (): SummaryProvider & { calls: number } => {
      const s = {
        calls: 0,
        async summarize(input: { subject: string }) {
          s.calls++;
          return `A summary of ${input.subject}.`;
        },
      };
      return s;
    };

    /** One tick at wall-clock `now`, with a fake budget clock that each feed request advances. */
    const tick = async (net: FakeWeb, now: string, opts: { clock?: { t: number }; sum?: SummaryProvider; runUser?: (u: string, s: PipelineSchedule) => Promise<never> | undefined; store?: ScheduleStore } = {}) => {
      const clock = opts.clock ?? { t: 0 };
      clock.t = 0;
      const sum = opts.sum ?? summarizer();
      return runDuePulls({
        store: opts.store ?? scheduleStore,
        budget: createTimeBudget({ now: () => clock.t, startedAt: 0 }),
        runUser: (userId, schedule) =>
          opts.runUser?.(userId, schedule) ??
          runPipelineForUser(userId, { store: pipelineStore, summarizer: sum, webFetcher: createWebFetcher(net), now: () => new Date(now), schedule }),
        now: () => new Date(now),
        leadMinutes: 30,
        leaseSeconds: 120,
        owner: randomUUID(),
      });
    };

    it("the time budget stops a run cleanly and the next ticks resume it, never fetching a feed twice", async () => {
      const a = await newUser({ time: "07:00", tz: "America/Los_Angeles" }); // 15:00Z
      for (const f of FEEDS) await addFeed(a, f);
      const clock = { t: 0 };
      const net = createFakeWeb({
        routes: Object.fromEntries(
          FEEDS.map((f) => [
            f,
            () => {
              clock.t += 20_000; // each feed takes 20 s of the budget
              return rss(feedFixture("rss-full.xml"));
            },
          ]),
        ),
      });
      const sum = summarizer();
      const feedRequests = () => net.requests.filter((r) => r.url.pathname === "/feed").map((r) => r.url.host);

      // 14:35Z: two feeds fit (0 s, 20 s); at 40 s neither a feed nor a summary fits.
      expect(await tick(net, "2026-11-23T14:35:00Z", { clock, sum })).toEqual({ claimed: 1, completed: 0, partial: 1, failed: 0, stoppedForTime: true });
      expect(feedRequests()).toEqual(["one.example", "two.example"]);
      expect(sum.calls).toBe(0);
      expect(await schedule(a)).toMatchObject({ completed_for: null, lease_owner: null, next_retry_at: null });

      // 14:40Z: the first two are done for this delivery and skipped; the other two run.
      expect(await tick(net, "2026-11-23T14:40:00Z", { clock, sum })).toMatchObject({ claimed: 1, partial: 1 });
      expect(feedRequests()).toEqual(["one.example", "two.example", "three.example", "four.example"]);

      // 14:45Z: nothing left to fetch, so the summaries run and the delivery is complete.
      expect(await tick(net, "2026-11-23T14:45:00Z", { clock, sum })).toMatchObject({ claimed: 1, completed: 1 });
      expect(feedRequests()).toHaveLength(4);
      expect(sum.calls).toBe(4);
      expect(iso((await schedule(a)).completed_for)).toBe("2026-11-23T15:00:00.000Z");
      expect((await q("select count(*)::int as n from public.newsletters where user_id = $1", [a])).rows[0].n).toBe(4);

      // 14:50Z: nobody is due; nothing is fetched or summarized again.
      expect(await tick(net, "2026-11-23T14:50:00Z", { clock, sum })).toMatchObject({ claimed: 0 });
      expect(feedRequests()).toHaveLength(4);
      expect(sum.calls).toBe(4);
    });

    it("a failing feed is retried with backoff until the delivery time, without holding up the rest", async () => {
      const a = await newUser({ time: "07:00", tz: "America/Los_Angeles" });
      const good = await addFeed(a, FEEDS[0]);
      const bad = await addFeed(a, FEEDS[1]);
      const net = createFakeWeb({ routes: { [FEEDS[0]]: rss(feedFixture("rss-full.xml")), [FEEDS[1]]: { status: 500 } } });
      const hits = (host: string) => net.requests.filter((r) => r.url.pathname === "/feed" && r.url.host === host).length;
      const feedRow = async (id: string) => one("select failure_count, next_attempt_at, last_error, last_fetched_at from public.web_feeds where id = $1", [id]);

      // 14:35: good pulled, bad fails; it may be retried at 14:40, before 15:00, so the run stays open.
      expect(await tick(net, "2026-11-23T14:35:00Z")).toMatchObject({ partial: 1 });
      expect(await feedRow(bad)).toMatchObject({ failure_count: 1, last_error: "http_500" });
      expect(iso((await feedRow(bad)).next_attempt_at)).toBe("2026-11-23T14:40:00.000Z");
      expect(iso((await schedule(a)).next_retry_at)).toBe("2026-11-23T14:40:00.000Z");
      expect(await feedRow(good)).toMatchObject({ failure_count: 0, next_attempt_at: null, last_error: null });

      // 14:37: nobody is due (the user waits for 14:40).
      expect(await tick(net, "2026-11-23T14:37:00Z")).toMatchObject({ claimed: 0 });
      // 14:40: only the bad feed is fetched; it fails again (retry at 14:50).
      expect(await tick(net, "2026-11-23T14:40:00Z")).toMatchObject({ partial: 1 });
      // 14:50: fails a third time; the next retry (15:10) is after the delivery: complete without it.
      expect(await tick(net, "2026-11-23T14:50:00Z")).toMatchObject({ completed: 1 });
      expect([hits("one.example"), hits("two.example")]).toEqual([1, 3]);
      expect(await feedRow(bad)).toMatchObject({ failure_count: 3, last_error: "http_500" });
      expect(iso((await feedRow(bad)).next_attempt_at)).toBe("2026-11-23T15:10:00.000Z");
      expect(iso((await schedule(a)).completed_for)).toBe("2026-11-23T15:00:00.000Z");

      // The next day the feed works again: it is pulled, and its count resets.
      net.routes.set(FEEDS[1], rss(feedFixture("rss-full.xml")));
      expect(await tick(net, "2026-11-24T14:35:00Z")).toMatchObject({ completed: 1 });
      expect(await feedRow(bad)).toMatchObject({ failure_count: 0, next_attempt_at: null, last_error: null });
    });

    it("one user's failure is recorded and backs off; the other user's pull completes", async () => {
      const a = await newUser({ time: "07:00" });
      const b = await newUser({ time: "07:00" });
      await addFeed(a, FEEDS[0]);
      await addFeed(b, FEEDS[1]);
      const net = createFakeWeb({ routes: { [FEEDS[0]]: rss(feedFixture("rss-full.xml")), [FEEDS[1]]: rss(feedFixture("rss-full.xml")) } });
      const s = await tick(net, "2026-11-23T06:40:00Z", {
        runUser: (userId) => (userId === a ? Promise.reject(Object.assign(new Error("x"), { code: "summarizer_not_configured" })) : undefined),
      });
      expect(s).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
      expect(await schedule(a)).toMatchObject({ failure_count: 1, last_error: "summarizer_not_configured", completed_for: null, lease_owner: null });
      expect(iso((await schedule(a)).next_retry_at)).toBe("2026-11-23T06:45:00.000Z");
      expect(iso((await schedule(b)).completed_for)).toBe("2026-11-23T07:00:00.000Z");
    });

    it("two concurrent ticks on separate connections run each due user exactly once", async () => {
      const users: string[] = [];
      for (let i = 0; i < 5; i++) {
        const u = await newUser({ time: "07:00" });
        await addFeed(u, `https://u${i}.example/feed`);
        users.push(u);
      }
      const runs = new Map<string, number>();
      const fakeRun = async (userId: string) => {
        runs.set(userId, (runs.get(userId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 25)); // overlap the two ticks
        return { userId, sources: [], connections: [], feeds: [], summaries: { created: 0, failed: 0, deferred: 0 }, schedule: { notStarted: 0, summariesNotStarted: 0, retryAt: null } };
      };
      const c1 = await db.connect();
      const c2 = await db.connect();
      const tickOn = (c: pg.Client) =>
        runDuePulls({
          store: createRpcScheduleStore(rpcOn(c)),
          budget: createTimeBudget({ now: () => 0, startedAt: 0 }),
          runUser: fakeRun,
          now: () => new Date("2026-11-23T06:45:00Z"),
          leadMinutes: 30,
          leaseSeconds: 120,
          owner: randomUUID(),
        });
      const [s1, s2] = await Promise.all([tickOn(c1), tickOn(c2)]);
      expect(s1.claimed + s2.claimed).toBe(5);
      expect(s1.completed + s2.completed).toBe(5);
      expect([...runs.keys()].sort()).toEqual([...users].sort());
      expect([...runs.values()].every((n) => n === 1)).toBe(true);
      expect(await tickOn(c1)).toMatchObject({ claimed: 0 });
    });
  });

  describe("per-feed attempts", () => {
    it("begin counts the attempt and pushes the retry back; success clears it; the backoff tops out at 24 hours", async () => {
      const a = await newUser();
      const f = await addFeed(a, "https://a.example/feed");
      const begin = (at: string) => pipelineStore.beginFeedAttempt(a, f, new Date(at));
      expect((await begin("2026-11-23T10:00:00Z"))?.toISOString()).toBe("2026-11-23T10:05:00.000Z");
      expect((await begin("2026-11-23T10:05:00Z"))?.toISOString()).toBe("2026-11-23T10:15:00.000Z");
      await q("update public.web_feeds set failure_count = 30 where id = $1", [f]);
      expect((await begin("2026-11-23T10:00:00Z"))?.toISOString()).toBe("2026-11-24T10:00:00.000Z");
      await pipelineStore.markFeed(a, f, { fetchedAt: new Date("2026-11-23T10:01:00Z") });
      expect(await one("select failure_count, next_attempt_at from public.web_feeds where id = $1", [f])).toEqual({ failure_count: 0, next_attempt_at: null });
      const state = await pipelineStore.load(a);
      expect(state.feeds[0]).toMatchObject({ failureCount: 0, nextAttemptAt: null });
    });

    it("only for the user's own feed", async () => {
      const a = await newUser();
      const b = await newUser();
      const f = await addFeed(a, "https://a.example/feed");
      await expect(pipelineStore.beginFeedAttempt(b, f, new Date())).rejects.toThrow();
      expect((await one("select failure_count from public.web_feeds where id = $1", [f])).failure_count).toBe(0);
    });
  });

  describe("cron job and tick", () => {
    const tickSql = "select private.cron_pull_tick() as id";

    it("the migration schedules one job every 5 minutes whose command holds no secret", async () => {
      const jobs = (await q("select jobname, schedule, command from cron.job")).rows;
      expect(jobs).toEqual([{ jobname: "impartly-scheduled-pull", schedule: "*/5 * * * *", command: "select private.cron_pull_tick()" }]);
    });

    it("does nothing until both Vault secrets exist", async () => {
      expect((await one(tickSql)).id).toBeNull();
      await q("select vault.create_secret('https://impartly.example/api/cron/pull', 'impartly_pull_url')");
      expect((await one(tickSql)).id).toBeNull();
      await q("select vault.create_secret('short', 'impartly_cron_secret')");
      expect((await one(tickSql)).id).toBeNull(); // shorter than 32 characters
      expect((await q("select * from net.http_request_queue")).rows).toEqual([]);
    });

    it("with both secrets, POSTs to the route with the bearer secret read from Vault", async () => {
      const secret = "invented-cron-secret-for-tests-0123456789";
      await q("select vault.create_secret('https://impartly.example/api/cron/pull', 'impartly_pull_url')");
      await q("select vault.create_secret($1, 'impartly_cron_secret')", [secret]);
      expect((await one(tickSql)).id).not.toBeNull();
      const reqs = (await q("select method, url, headers, timeout_milliseconds from net.http_request_queue")).rows;
      expect(reqs).toEqual([
        {
          method: "POST",
          url: "https://impartly.example/api/cron/pull",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          timeout_milliseconds: 65000,
        },
      ]);
    });

    it("refuses a URL that is not https", async () => {
      await q("select vault.create_secret($1, 'impartly_cron_secret')", ["invented-cron-secret-for-tests-0123456789"]);
      for (const url of ["http://impartly.example/api/cron/pull", "https://user@impartly.example/x", "ftp://impartly.example/", "https://impartly.example"]) {
        await q("delete from vault.secrets where name = 'impartly_pull_url'");
        await q("select vault.create_secret($1, 'impartly_pull_url')", [url]);
        expect((await one(tickSql)).id, url).toBeNull();
      }
      expect((await q("select * from net.http_request_queue")).rows).toEqual([]);
    });
  });

  describe("access", () => {
    it("pull_schedule has RLS on and no privileges for the API roles", async () => {
      expect((await one("select relrowsecurity from pg_class where oid = 'private.pull_schedule'::regclass")).relrowsecurity).toBe(true);
      const a = await newUser();
      for (const actor of [{ kind: "anon" as const }, { kind: "user" as const, id: a }, { kind: "service" as const }]) {
        expect((await attempt(db.admin, actor, "select * from private.pull_schedule")).error?.code, actor.kind).toBe("42501");
        expect((await attempt(db.admin, actor, "insert into private.pull_schedule (user_id) values ($1)", [a])).error?.code, actor.kind).toBe("42501");
      }
    });

    it("claim, finish and begin are for the server only; the tick and the schedule helpers for no API role", async () => {
      const a = await newUser();
      const calls = [
        ["select public.pull_claim_next(now(), 30, 120, gen_random_uuid())", []],
        ["select public.pull_finish($1, gen_random_uuid(), now(), 'complete', null, null)", [a]],
        ["select public.pipeline_begin_feed($1, gen_random_uuid(), now())", [a]],
      ] as const;
      for (const actor of [{ kind: "anon" as const }, { kind: "user" as const, id: a }]) {
        for (const [sql, params] of calls) {
          expect((await attempt(db.admin, actor, sql, [...params])).error?.code, `${actor.kind}: ${sql}`).toBe("42501");
        }
      }
      expect((await attempt(db.admin, { kind: "service" }, calls[0][0])).error).toBeNull();
      for (const actor of [{ kind: "anon" as const }, { kind: "user" as const, id: a }, { kind: "service" as const }]) {
        for (const sql of [
          "select private.cron_pull_tick()",
          "select private.delivery_due_at(now(), '07:00', 'UTC', interval '30 minutes')",
          "select private.local_to_instant('2026-11-24 07:00', 'UTC')",
          "select * from cron.job",
          "select * from net.http_request_queue",
        ]) {
          expect((await attempt(db.admin, actor, sql)).error?.code, `${actor.kind}: ${sql}`).toBe("42501");
        }
      }
    });

    it("the new functions are security definer with an empty search_path", async () => {
      const rows = (
        await q(
          `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('pull_claim_next', 'pull_finish', 'pipeline_begin_feed')`,
        )
      ).rows;
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.prosecdef, r.proname).toBe(true);
        expect(r.proconfig, r.proname).toEqual(['search_path=""']);
      }
    });
  });
});
