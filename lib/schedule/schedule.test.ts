// Unit tests for the scheduled pull: the time budget, the lead time setting, the CRON_SECRET
// check, the tick loop (with a fake store and pipeline) and the route handler. The SQL side
// (schedule math across time zones and DST, the due query, leases, cron job) is tested on
// real Postgres in tests/db/scheduled-pull.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PipelineResult, PipelineSchedule } from "../pipeline/run";
import { handleCronPull } from "../routes/cron-pull";
import {
  createTimeBudget,
  failureCode,
  isAuthorizedCronRequest,
  leadMinutesFromEnv,
  outcomeOf,
  PULL_TIMING,
  runDuePulls,
  type Claim,
  type ScheduleStore,
} from ".";

const ROOT = path.resolve(__dirname, "../..");
const SECRET = "s".repeat(20) + "-invented-test-secret-" + "x".repeat(10);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("time budget", () => {
  it("starts work only when its estimate and the margin still fit in the limit", () => {
    let t = 1_000;
    const b = createTimeBudget({ now: () => t, limitMs: 60_000, marginMs: 5_000 });
    expect(b.canStart("feed")).toBe(true); // 0 + 20 + 5 <= 60
    t += 35_000;
    expect(b.canStart("feed")).toBe(true); // 35 + 20 + 5 = 60
    expect(b.canStart("archive")).toBe(false); // 35 + 25 + 5 = 65
    t += 1;
    expect(b.canStart("feed")).toBe(false);
    expect(b.elapsedMs()).toBe(35_001);
  });

  it("counts from when the request arrived, not from when the budget was made", () => {
    const b = createTimeBudget({ now: () => 50_000, startedAt: 10_000 });
    expect(b.elapsedMs()).toBe(40_000);
    expect(b.canStart("feed")).toBe(false);
  });

  it("every estimate fits in an empty budget, so each kind of work can always start first", () => {
    for (const [work, ms] of Object.entries(PULL_TIMING.estimatesMs)) {
      expect(ms + PULL_TIMING.safetyMarginMs, work).toBeLessThanOrEqual(PULL_TIMING.functionLimitMs);
    }
    expect(PULL_TIMING.summaryTimeoutMs).toBeLessThanOrEqual(PULL_TIMING.estimatesMs.summary);
    expect(PULL_TIMING.leaseSeconds * 1000).toBeGreaterThan(PULL_TIMING.functionLimitMs);
  });

  it("the route's maxDuration and the cron schedule match the timing settings", () => {
    const route = readFileSync(path.join(ROOT, "app/api/cron/pull/route.ts"), "utf8");
    expect(route).toMatch(new RegExp(`export const maxDuration = ${PULL_TIMING.functionLimitMs / 1000};`));
    const migration = readFileSync(path.join(ROOT, "supabase/migrations/20261123180000_scheduled_pull.sql"), "utf8");
    expect(migration).toContain(`cron.schedule('impartly-scheduled-pull', '*/${PULL_TIMING.tickMinutes} * * * *'`);
    // pg_net waits a little longer than the function may run.
    const timeout = Number(/timeout_milliseconds := (\d+)/.exec(migration)?.[1]);
    expect(timeout).toBeGreaterThan(PULL_TIMING.functionLimitMs);
  });
});

describe("PULL_LEAD_MINUTES", () => {
  it("defaults to 30 and accepts whole minutes from 0 to 360", () => {
    expect(leadMinutesFromEnv(undefined)).toBe(30);
    expect(leadMinutesFromEnv("")).toBe(30);
    expect(leadMinutesFromEnv(" 45 ")).toBe(45);
    expect(leadMinutesFromEnv("0")).toBe(0);
    expect(leadMinutesFromEnv("360")).toBe(360);
    for (const bad of ["361", "-5", "12.5", "1e2", "abc", "0x10", "9999"]) expect(leadMinutesFromEnv(bad), bad).toBe(30);
  });
});

describe("CRON_SECRET check", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer  ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(null, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest("", SECRET)).toBe(false);
  });

  it("refuses everything when CRON_SECRET is unset, blank or shorter than 32 characters", () => {
    for (const secret of [undefined, "", "short-secret"]) {
      expect(isAuthorizedCronRequest(`Bearer ${secret ?? ""}`, secret)).toBe(false);
      expect(isAuthorizedCronRequest("Bearer ", secret)).toBe(false);
      expect(isAuthorizedCronRequest(null, secret)).toBe(false);
    }
  });

  it("compares with timingSafeEqual on fixed-length digests, never with ===", () => {
    const src = readFileSync(path.join(ROOT, "lib/schedule/auth.ts"), "utf8");
    expect(src).toContain("timingSafeEqual(");
    expect(src).toContain('createHash("sha256")');
    // No direct string comparison of the given value with the secret.
    expect(src).not.toMatch(/(match\[1\]|authorization)\s*[!=]==|[!=]==\s*(match\[1\]|secret\b)/);
  });
});

function result(schedule?: PipelineResult["schedule"]): PipelineResult {
  return { userId: "u", sources: [], connections: [], feeds: [], summaries: { created: 0, failed: 0, deferred: 0 }, schedule };
}

describe("what a run means for the schedule", () => {
  const due = new Date("2026-11-24T15:00:00Z");
  it("complete when nothing is left", () => {
    expect(outcomeOf(result({ notStarted: 0, summariesNotStarted: 0, retryAt: null }), due)).toEqual({ outcome: "complete", retryAt: null });
  });
  it("partial when a source or summary did not fit in the time left", () => {
    expect(outcomeOf(result({ notStarted: 1, summariesNotStarted: 0, retryAt: null }), due).outcome).toBe("partial");
    expect(outcomeOf(result({ notStarted: 0, summariesNotStarted: 2, retryAt: null }), due).outcome).toBe("partial");
  });
  it("partial until a failed feed's retry time, if that comes before the delivery", () => {
    expect(outcomeOf(result({ notStarted: 0, summariesNotStarted: 0, retryAt: "2026-11-24T14:40:00.000Z" }), due)).toEqual({
      outcome: "partial",
      retryAt: new Date("2026-11-24T14:40:00Z"),
    });
    expect(outcomeOf(result({ notStarted: 0, summariesNotStarted: 0, retryAt: "2026-11-24T15:05:00.000Z" }), due)).toEqual({
      outcome: "complete",
      retryAt: null,
    });
  });
  it("failure codes are short and storable, never messages", () => {
    expect(failureCode(new Error("Summarizer not configured: a setting is missing"))).toBe("error");
    expect(failureCode(Object.assign(new Error("x"), { code: "http_404" }))).toBe("http_404");
    expect(failureCode("boom")).toBe("unknown");
    expect(failureCode(Object.assign(new Error("x"), { code: "A very-long code with spaces and more than forty characters" }))).toMatch(/^[a-z0-9_+]{1,40}$/);
  });
});

/** A fake store holding a queue of due users, recording finishes. */
function fakeStore(userIds: string[]) {
  const queue = [...userIds];
  const finishes: Parameters<ScheduleStore["finish"]>[0][] = [];
  const store: ScheduleStore = {
    async claimNext({ now }) {
      const userId = queue.shift();
      if (!userId) return null;
      const claim: Claim = { userId, dueFor: new Date(now.getTime() + 30 * 60_000), cycleStartedAt: now };
      return claim;
    },
    async finish(args) {
      finishes.push(args);
      return true;
    },
  };
  return { store, finishes, queue };
}

describe("one tick", () => {
  const base = { leadMinutes: 30, leaseSeconds: 120, owner: "tick-1", now: () => new Date("2026-11-24T14:30:00Z") };

  it("runs each due user once and finishes each with its outcome", async () => {
    const { store, finishes } = fakeStore(["a", "b", "c"]);
    const runUser = vi.fn(async (userId: string) => {
      if (userId === "b") throw Object.assign(new Error("x"), { code: "load_failed" });
      return result({ notStarted: userId === "c" ? 1 : 0, summariesNotStarted: 0, retryAt: null });
    });
    const s = await runDuePulls({ ...base, store, budget: createTimeBudget({ now: () => 0 }), runUser });
    expect(s).toEqual({ claimed: 3, completed: 1, partial: 1, failed: 1, stoppedForTime: false });
    expect(runUser.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(finishes.map((f) => [f.userId, f.outcome, f.error])).toEqual([
      ["a", "complete", null],
      ["b", "failed", "load_failed"],
      ["c", "partial", null],
    ]);
    expect(finishes.every((f) => f.owner === "tick-1")).toBe(true);
  });

  it("hands the pipeline the cycle start and the shared budget", async () => {
    const { store } = fakeStore(["a"]);
    let t = 0;
    let seen: PipelineSchedule | undefined;
    await runDuePulls({
      ...base,
      store,
      budget: createTimeBudget({ now: () => t }),
      runUser: async (_u, schedule) => {
        seen = schedule;
        expect(schedule.canStart("archive")).toBe(true);
        t = 31_000;
        expect(schedule.canStart("archive")).toBe(false);
        return result({ notStarted: 0, summariesNotStarted: 0, retryAt: null });
      },
    });
    expect(seen?.cycleStart.toISOString()).toBe("2026-11-24T14:30:00.000Z");
  });

  it("stops claiming when not even a feed fits in the time left, leaving the rest for the next tick", async () => {
    const { store, queue } = fakeStore(["a", "b", "c"]);
    let t = 0;
    const runUser = vi.fn(async () => {
      t += 20_000;
      return result({ notStarted: 0, summariesNotStarted: 0, retryAt: null });
    });
    const s = await runDuePulls({ ...base, store, budget: createTimeBudget({ now: () => t }), runUser });
    // 0 s: a; 20 s: b; 40 s: 40 + 20 + 5 > 60, stop.
    expect(s).toEqual({ claimed: 2, completed: 2, partial: 0, failed: 0, stoppedForTime: true });
    expect(queue).toEqual(["c"]);
  });

  it("a finish that fails counts as failed and does not stop the others", async () => {
    const { store } = fakeStore(["a", "b"]);
    const finish = store.finish;
    store.finish = async (args) => {
      if (args.userId === "a") throw new Error("db down");
      return finish(args);
    };
    const s = await runDuePulls({
      ...base,
      store,
      budget: createTimeBudget({ now: () => 0 }),
      runUser: async () => result({ notStarted: 0, summariesNotStarted: 0, retryAt: null }),
    });
    expect(s).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
  });
});

describe("POST /api/cron/pull", () => {
  const url = "https://impartly.example/api/cron/pull";
  const summary = { claimed: 2, completed: 1, partial: 1, failed: 0, stoppedForTime: false };
  const deps = (secret: string | undefined) => {
    const run = vi.fn(async () => summary);
    const log = vi.fn();
    return { secret, run, log };
  };

  it("runs one tick for the right secret and returns counts only", async () => {
    const d = deps(SECRET);
    const res = await handleCronPull(new Request(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual(summary);
    expect(body).not.toMatch(UUID);
    expect(d.run).toHaveBeenCalledTimes(1);
  });

  it("refuses GET and other methods with 405 before checking anything", async () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const d = deps(SECRET);
      const res = await handleCronPull(new Request(url, { method, headers: { authorization: `Bearer ${SECRET}` } }), d);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(d.run).not.toHaveBeenCalled();
    }
  });

  it("every auth failure is the same 401, and nothing runs", async () => {
    const cases: [string | undefined, Record<string, string>][] = [
      [SECRET, {}],
      [SECRET, { authorization: "Bearer wrong-secret-of-a-plausible-length-000000" }],
      [SECRET, { authorization: `Bearer ${SECRET}x` }],
      [SECRET, { authorization: `Bearer ${SECRET.toUpperCase()}` }],
      [SECRET, { authorization: `Token ${SECRET}` }],
      [SECRET, { "x-cron-secret": SECRET }],
      [undefined, { authorization: "Bearer " }],
      [undefined, {}],
      ["too-short", { authorization: "Bearer too-short" }],
    ];
    const bodies = new Set<string>();
    for (const [secret, headers] of cases) {
      const d = deps(secret);
      const res = await handleCronPull(new Request(url, { method: "POST", headers }), d);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      bodies.add(await res.text());
      expect(d.run).not.toHaveBeenCalled();
    }
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
  });

  it("logs (without the value) when CRON_SECRET is missing, so the owner can tell", async () => {
    const d = deps(undefined);
    await handleCronPull(new Request(url, { method: "POST" }), d);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("CRON_SECRET is not set"));
    const ok = deps(SECRET);
    await handleCronPull(new Request(url, { method: "POST", headers: { authorization: "Bearer nope" } }), ok);
    expect(ok.log).not.toHaveBeenCalled();
  });

  it("a failing tick is a bare 500 with no detail", async () => {
    const d = deps(SECRET);
    d.run.mockRejectedValueOnce(new Error("relation private.pull_schedule does not exist; user 1234"));
    const res = await handleCronPull(new Request(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }), d);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"pull_failed"}');
    expect(d.log.mock.calls.flat().join(" ")).not.toContain("1234");
  });

  it("the route file exports POST only (Next.js answers 405 for the rest) and sits outside the sign-in proxy", async () => {
    const route = readFileSync(path.join(ROOT, "app/api/cron/pull/route.ts"), "utf8");
    const handlers = [...route.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
    expect(handlers).toEqual(["POST"]);
    expect(route).toContain("process.env.CRON_SECRET");
    const { isPublicPath } = await import("../auth/access");
    expect(isPublicPath("/api/cron/pull")).toBe(true);
    for (const p of ["/api/cron", "/api/cron/pull/x", "/api/cron/pull/", "/api/cron/other"]) expect(isPublicPath(p), p).toBe(false);
  });
});
