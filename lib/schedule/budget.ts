// The scheduled pull's time budget and timing settings.
//
// Supabase Cron calls the pull route every PULL_TICK_MINUTES. Each call is one Vercel
// function invocation, which the platform stops at the route's maxDuration
// (app/api/cron/pull/route.ts sets 60 seconds, a limit every Vercel plan allows, to my
// knowledge; not checked from here). So the route starts a piece of work only when its
// worst expected time still fits before that limit, minus a safety margin for the final
// database writes, and leaves the rest for the next tick.
//
// Estimates (worst expected, not typical):
//   feed     robots.txt plus the feed, each with the fetcher's 10 s deadline: 20 s
//   archive  robots.txt, the archive page and up to 5 issue pages at 1 request per second
//            or the site's Crawl-delay; typically about 10 s; 25 s budgeted
//   mail     one mailbox listing and up to 50 messages: 20 s
//   summary  one model call; scheduled runs cap the summarizer at 20 s
// A fetch that still outlasts the function is cut off with it. The feed was marked as
// attempted before it started (pipeline_begin_feed), so it backs off like a failure and
// cannot block later ticks; the user's lease runs out and the next tick carries on.

import type { ScheduledWork } from "../pipeline/run";

export const PULL_TIMING = Object.freeze({
  /** pg_cron schedule in the migration: every 5 minutes. */
  tickMinutes: 5,
  /** Must match `maxDuration` in app/api/cron/pull/route.ts. */
  functionLimitMs: 60_000,
  /** Kept free at the end for the last database writes. */
  safetyMarginMs: 5_000,
  /** A claimed user's lease; longer than the function can live, so it outlasts a stopped run. */
  leaseSeconds: 120,
  /** Scheduled runs give the summarizer this long per call. */
  summaryTimeoutMs: 20_000,
  /** Default: start pulling this long before the delivery time. PULL_LEAD_MINUTES overrides. */
  defaultLeadMinutes: 30,
  maxLeadMinutes: 360,
  estimatesMs: Object.freeze({ feed: 20_000, archive: 25_000, mail: 20_000, summary: 20_000 } satisfies Record<ScheduledWork, number>),
});

export interface TimeBudget {
  canStart(work: ScheduledWork): boolean;
  elapsedMs(): number;
}

export function createTimeBudget(options: {
  now: () => number;
  startedAt?: number;
  limitMs?: number;
  marginMs?: number;
  estimatesMs?: Partial<Record<ScheduledWork, number>>;
}): TimeBudget {
  const startedAt = options.startedAt ?? options.now();
  const limitMs = options.limitMs ?? PULL_TIMING.functionLimitMs;
  const marginMs = options.marginMs ?? PULL_TIMING.safetyMarginMs;
  const estimates = { ...PULL_TIMING.estimatesMs, ...options.estimatesMs };
  const elapsedMs = () => options.now() - startedAt;
  return {
    elapsedMs,
    canStart(work) {
      return elapsedMs() + estimates[work] + marginMs <= limitMs;
    },
  };
}

/**
 * PULL_LEAD_MINUTES: a whole number of minutes from 0 to 360. Anything else (unset,
 * blank, not a whole number, out of range) gives the default, 30.
 */
export function leadMinutesFromEnv(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!/^\d{1,3}$/.test(v)) return PULL_TIMING.defaultLeadMinutes;
  const n = Number(v);
  return n <= PULL_TIMING.maxLeadMinutes ? n : PULL_TIMING.defaultLeadMinutes;
}
