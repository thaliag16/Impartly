// Delivery time and timezone settings on a real Postgres
// (supabase/migrations/20261124120000_delivery_settings.sql): the next-briefing math the
// settings screen shows, and the schedule reset when the time or zone changes, written
// the way the screen writes it (as the signed-in user, under RLS). Clocks are fake: the
// claim takes `now` as an argument, and the trigger's clock is pinned with impartly.now.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Rpc } from "../../lib/mail";
import { createRpcScheduleStore, type ScheduleStore } from "../../lib/schedule";
import { timezoneOptions } from "../../lib/schedule/delivery";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

function rpcOn(client: pg.Client): Rpc {
  return async (fn, args) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as result`;
    const r = await as(client, { kind: "service" }, (q) => q(sql, names.map((n) => args[n])));
    return r.rows[0].result;
  };
}

const iso = (v: unknown) => (v === null ? null : new Date(v as string | Date).toISOString());

describe.skipIf(!databaseUrl)("delivery settings on real Postgres", () => {
  let db: TestDatabase;
  let store: ScheduleStore;

  const q = (sql: string, params?: unknown[]) => db.admin.query(sql, params);
  const one = async (sql: string, params?: unknown[]) => (await q(sql, params)).rows[0];

  const newUser = async (settings?: { time: string; tz: string }) => {
    const id = randomUUID();
    await q("insert into auth.users (id) values ($1)", [id]);
    if (settings) {
      await q("insert into public.user_settings (user_id, delivery_time, timezone) values ($1, $2, $3)", [id, settings.time, settings.tz]);
    }
    await q(
      "insert into public.web_feeds (user_id, feed_url, feed_format, title) values ($1, $2, 'rss', 'Invented feed')",
      [id, `https://${id.slice(0, 8)}.example/feed`],
    );
    return id;
  };
  const schedule = (userId: string) => one("select * from private.pull_schedule where user_id = $1", [userId]);
  const claim = (now: string, owner = randomUUID()) =>
    store.claimNext({ now: new Date(now), leadMinutes: 30, leaseSeconds: 120, owner });
  const finish = (userId: string, owner: string, now: string, outcome: "complete" | "partial" | "failed", retryAt: string | null = null) =>
    store.finish({ userId, owner, now: new Date(now), outcome, retryAt: retryAt ? new Date(retryAt) : null, error: outcome === "failed" ? "model_error" : null });
  /** Claims and completes the user's due pull at `now`. */
  const pullAt = async (userId: string, now: string) => {
    const owner = randomUUID();
    const c = await claim(now, owner);
    expect(c?.userId).toBe(userId);
    expect(await finish(userId, owner, now, "complete")).toBe(true);
    return c!.dueFor.toISOString();
  };
  /** Saves settings as the signed-in user (the screen's path: update, else insert), at a pinned clock. */
  const saveAt = async (now: string, userId: string, time: string, tz: string) => {
    await q("select set_config('impartly.now', $1, false)", [now]);
    try {
      await as(db.admin, { kind: "user", id: userId }, async (uq) => {
        const r = await uq("update public.user_settings set delivery_time = $1, timezone = $2, updated_at = now() where user_id = $3", [time, tz, userId]);
        if (r.rowCount === 0) {
          await uq("insert into public.user_settings (user_id, delivery_time, timezone) values ($1, $2, $3)", [userId, time, tz]);
        }
      });
    } finally {
      await q("select set_config('impartly.now', '', false)");
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    store = createRpcScheduleStore(rpcOn(db.admin));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await q("delete from auth.users");
  });

  describe("next briefing (delivery_next_after)", () => {
    const next = async (after: string, time: string, tz: string) =>
      iso((await one("select public.delivery_next_after($1, $2, $3) as t", [after, time, tz])).t);

    it("is the next delivery strictly after the moment, in the user's zone", async () => {
      expect(await next("2026-11-24T06:59:00Z", "07:00", "UTC")).toBe("2026-11-24T07:00:00.000Z");
      expect(await next("2026-11-24T07:00:00Z", "07:00", "UTC")).toBe("2026-11-25T07:00:00.000Z");
      expect(await next("2026-11-24T14:41:00Z", "07:00", "America/Los_Angeles")).toBe("2026-11-24T15:00:00.000Z");
      expect(await next("2026-11-24T15:30:00Z", "07:00", "America/Los_Angeles")).toBe("2026-11-25T15:00:00.000Z");
      expect(await next("2026-11-24T14:41:00Z", "06:15", "Asia/Kolkata")).toBe("2026-11-25T00:45:00.000Z");
      // +14: 04:41 on the 25th locally, so 07:00 on the 25th there, still the 24th in UTC.
      expect(await next("2026-11-24T14:41:00Z", "07:00", "Pacific/Kiritimati")).toBe("2026-11-24T17:00:00.000Z");
      expect(await next("2026-11-24T14:41:00Z", "23:45", "Pacific/Pago_Pago")).toBe("2026-11-25T10:45:00.000Z");
    });

    it("follows the scheduled pull's daylight-saving rules", async () => {
      // New York 2026-03-08: 02:30 does not exist; the pull aims for the jump (07:00Z).
      expect(await next("2026-03-08T05:00:00Z", "02:30", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
      // New York 2026-11-01: 01:30 happens twice; the first one (05:30Z).
      expect(await next("2026-11-01T04:00:00Z", "01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
      // 07:00 local stays 07:00 local across the change.
      expect(await next("2026-03-08T12:00:00Z", "07:00", "America/New_York")).toBe("2026-03-09T11:00:00.000Z");
    });

    it("matches the instant the scheduled pull claims for", async () => {
      const a = await newUser({ time: "06:15", tz: "Europe/Berlin" });
      expect(await pullAt(a, "2026-11-24T05:00:00Z")).toBe("2026-11-24T05:15:00.000Z");
      const shown = await next("2026-11-24T05:20:00Z", "06:15", "Europe/Berlin");
      expect(shown).toBe("2026-11-25T05:15:00.000Z");
      expect(await claim("2026-11-25T04:44:00Z")).toBeNull();
      expect((await claim("2026-11-25T04:45:00Z"))?.dueFor.toISOString()).toBe(shown);
    });

    it("every zone the settings screen offers is one Postgres accepts", async () => {
      const zones = timezoneOptions();
      expect(zones.length).toBeGreaterThan(300);
      const known = new Set((await q("select name from pg_timezone_names")).rows.map((r) => r.name));
      expect(zones.filter((z) => !known.has(z))).toEqual([]);
    });

    it("refuses an unknown zone and missing arguments", async () => {
      for (const [sql, code] of [
        ["select public.delivery_next_after(now(), '07:00', 'Mars/Olympus')", "22023"],
        ["select public.delivery_next_after(now(), null, 'UTC')", "22004"],
      ] as const) {
        expect((await attempt(db.admin, { kind: "service" }, sql)).error?.code, sql).toBe(code);
      }
    });

    it("only the server may call it; the reset helpers are for no API role", async () => {
      const a = await newUser();
      const sql = "select public.delivery_next_after(now(), '07:00', 'UTC')";
      expect((await attempt(db.admin, { kind: "anon" }, sql)).error?.code).toBe("42501");
      expect((await attempt(db.admin, { kind: "user", id: a }, sql)).error?.code).toBe("42501");
      expect((await attempt(db.admin, { kind: "service" }, sql)).error).toBeNull();
      for (const actor of [{ kind: "anon" as const }, { kind: "user" as const, id: a }, { kind: "service" as const }]) {
        for (const s of [
          "select private.settings_clock()",
          `select private.pull_schedule_settings_changed('${a}', '07:00', 'UTC', '08:00', 'UTC', now())`,
        ]) {
          expect((await attempt(db.admin, actor, s)).error?.code, `${actor.kind}: ${s}`).toBe("42501");
        }
      }
      const rows = (
        await q(
          `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname = 'delivery_next_after')
              or (n.nspname = 'private' and p.proname in ('pull_schedule_settings_changed', 'user_settings_delivery_changed'))`,
        )
      ).rows;
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.prosecdef, r.proname).toBe(true);
        expect(r.proconfig, r.proname).toEqual(['search_path=""']);
      }
    });
  });

  describe("changing the time resets the schedule", () => {
    it("moving the time earlier after today's briefing: no catch-up pull, the next one is tomorrow at the new time", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      expect(await pullAt(a, "2026-11-24T06:40:00Z")).toBe("2026-11-24T07:00:00.000Z");
      await saveAt("2026-11-24T10:00:00Z", a, "08:00", "UTC");
      // Without the reset, today's 08:00 (already past) would be claimed at once.
      expect(await claim("2026-11-24T10:05:00Z")).toBeNull();
      expect(await claim("2026-11-25T07:29:00Z")).toBeNull();
      expect((await claim("2026-11-25T07:30:00Z"))?.dueFor.toISOString()).toBe("2026-11-25T08:00:00.000Z");
    });

    it("moving the time later the same day: the pull is for the new time today", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      await pullAt(a, "2026-11-24T06:40:00Z");
      await saveAt("2026-11-24T08:00:00Z", a, "09:00", "UTC");
      expect(await claim("2026-11-24T08:29:00Z")).toBeNull();
      expect((await claim("2026-11-24T08:30:00Z"))?.dueFor.toISOString()).toBe("2026-11-24T09:00:00.000Z");
    });

    it("a change inside the new time's lead window still pulls for it", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      await pullAt(a, "2026-11-24T06:40:00Z");
      await saveAt("2026-11-24T08:50:00Z", a, "09:00", "UTC");
      expect((await claim("2026-11-24T08:50:00Z"))?.dueFor.toISOString()).toBe("2026-11-24T09:00:00.000Z");
    });

    it("changing the zone: the next pull follows the new zone, with no catch-up for a time already past there", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      await pullAt(a, "2026-11-24T06:40:00Z");
      // 07:00 in Berlin is 06:00Z, already past at 10:00Z: tomorrow.
      await saveAt("2026-11-24T10:00:00Z", a, "07:00", "Europe/Berlin");
      expect(await claim("2026-11-24T10:05:00Z")).toBeNull();
      expect(await claim("2026-11-25T05:29:00Z")).toBeNull();
      expect(await pullAt(a, "2026-11-25T05:30:00Z")).toBe("2026-11-25T06:00:00.000Z");
      // 07:00 in Los Angeles is 15:00Z, still ahead at 10:00Z: today.
      await saveAt("2026-11-25T10:00:00Z", a, "07:00", "America/Los_Angeles");
      expect(await claim("2026-11-25T14:29:00Z")).toBeNull();
      expect((await claim("2026-11-25T14:30:00Z"))?.dueFor.toISOString()).toBe("2026-11-25T15:00:00.000Z");
    });

    it("the first save (no row yet) counts as a change from 07:00 UTC", async () => {
      const a = await newUser();
      await pullAt(a, "2026-11-24T06:40:00Z"); // default 07:00 UTC
      await saveAt("2026-11-24T10:00:00Z", a, "08:00", "UTC");
      expect(await claim("2026-11-24T10:05:00Z")).toBeNull();
      expect((await claim("2026-11-25T07:30:00Z"))?.dueFor.toISOString()).toBe("2026-11-25T08:00:00.000Z");
    });

    it("saving the same values changes nothing, even with a pull still owed", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      await pullAt(a, "2026-11-23T06:40:00Z");
      const owner = randomUUID();
      expect((await claim("2026-11-24T06:40:00Z", owner))?.dueFor.toISOString()).toBe("2026-11-24T07:00:00.000Z");
      await finish(a, owner, "2026-11-24T06:41:00Z", "partial");
      const before = await schedule(a);
      await saveAt("2026-11-24T07:10:00Z", a, "07:00", "UTC");
      expect(await schedule(a)).toEqual(before);
      expect((await claim("2026-11-24T07:15:00Z"))?.dueFor.toISOString()).toBe("2026-11-24T07:00:00.000Z");
    });

    it("a pull still owed under the old time stays owed, and is made for the new time", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      await pullAt(a, "2026-11-23T06:40:00Z");
      const owner = randomUUID();
      await claim("2026-11-24T06:40:00Z", owner);
      await finish(a, owner, "2026-11-24T06:41:00Z", "partial"); // today's 07:00 not finished
      await saveAt("2026-11-24T07:10:00Z", a, "06:00", "UTC");
      expect((await claim("2026-11-24T07:15:00Z"))?.dueFor.toISOString()).toBe("2026-11-24T06:00:00.000Z");
    });

    it("a user who has never had a pull still gets their first pull at once", async () => {
      const a = await newUser();
      await saveAt("2026-11-24T10:00:00Z", a, "08:00", "America/New_York");
      expect(iso((await schedule(a)).completed_for)).toBeNull();
      expect((await claim("2026-11-24T10:05:00Z"))?.dueFor.toISOString()).toBe("2026-11-23T13:00:00.000Z");
    });

    it("a wait for a source's retry is released; a failure's backoff is kept", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      await pullAt(a, "2026-11-23T06:40:00Z");
      let owner = randomUUID();
      await claim("2026-11-24T06:31:00Z", owner);
      await finish(a, owner, "2026-11-24T06:32:00Z", "partial", "2026-11-24T06:52:00Z");
      await saveAt("2026-11-24T06:35:00Z", a, "06:50", "UTC");
      expect((await schedule(a)).next_retry_at).toBeNull();
      expect((await claim("2026-11-24T06:36:00Z"))?.dueFor.toISOString()).toBe("2026-11-24T06:50:00.000Z");

      const b = await newUser({ time: "07:00", tz: "UTC" });
      owner = randomUUID();
      await q("delete from public.web_feeds where user_id = $1", [a]);
      await claim("2026-11-24T08:00:00Z", owner);
      await finish(b, owner, "2026-11-24T08:00:00Z", "failed");
      const retry = iso((await schedule(b)).next_retry_at);
      expect(retry).toBe("2026-11-24T08:05:00.000Z");
      await saveAt("2026-11-24T08:01:00Z", b, "09:00", "UTC");
      expect(iso((await schedule(b)).next_retry_at)).toBe(retry);
      expect((await schedule(b)).last_error).toBe("model_error");
    });

    it("only the user's own schedule changes, and the trigger runs for any write path (Table Editor too)", async () => {
      const a = await newUser({ time: "07:00", tz: "UTC" });
      const b = await newUser({ time: "07:00", tz: "UTC" });
      for (let i = 0; i < 2; i++) {
        const owner = randomUUID();
        const c = await claim("2026-11-24T06:40:00Z", owner);
        await finish(c!.userId, owner, "2026-11-24T06:40:00Z", "complete");
      }
      expect(await claim("2026-11-24T06:41:00Z")).toBeNull();
      const bBefore = await schedule(b);
      await q("select set_config('impartly.now', '2026-11-24T10:00:00Z', false)");
      await q("update public.user_settings set delivery_time = '08:00' where user_id = $1", [a]); // as an admin would
      await q("select set_config('impartly.now', '', false)");
      expect(iso((await schedule(a)).completed_for)).toBe("2026-11-24T08:00:00.000Z");
      expect(await schedule(b)).toEqual(bBefore);
    });
  });
});
