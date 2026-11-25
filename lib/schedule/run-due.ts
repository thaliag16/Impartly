// One tick of the scheduled pull: claim the users whose briefing is coming due, one at a
// time, and run the pipeline for each within this invocation's time budget.
//
// Claiming (pull_claim_next in supabase/migrations/20261123180000_scheduled_pull.sql)
// takes a lease on one user with FOR UPDATE SKIP LOCKED, so overlapping ticks never run
// the same user. Every claimed run ends with pull_finish:
//   complete  every source is pulled for this delivery (or failed and cannot be retried
//             before it), and every summary that fits the per-run caps is written
//   partial   time ran out, or a failed feed can still be retried before the delivery
//             time: the user stays due and the next tick carries on where this one stopped
//   failed    the run threw (database down, summarizer not configured, ...): a short
//             code is recorded and the user backs off (5 minutes, doubling, at most 1 hour)
// One user's failure never stops the others. The summary holds counts only: no user ids,
// so nothing here says which users exist.

import type { PipelineResult, PipelineSchedule } from "../pipeline/run";
import type { TimeBudget } from "./budget";

export interface Claim {
  userId: string;
  /** The delivery this pull is for. */
  dueFor: Date;
  /** When work for this delivery started (sources pulled since then are done). */
  cycleStartedAt: Date;
}

export type FinishOutcome = "complete" | "partial" | "failed";

export interface ScheduleStore {
  claimNext(args: { now: Date; leadMinutes: number; leaseSeconds: number; owner: string }): Promise<Claim | null>;
  finish(args: {
    userId: string;
    owner: string;
    now: Date;
    outcome: FinishOutcome;
    retryAt: Date | null;
    error: string | null;
  }): Promise<boolean>;
}

export interface DuePullDeps {
  store: ScheduleStore;
  budget: TimeBudget;
  runUser(userId: string, schedule: PipelineSchedule): Promise<PipelineResult>;
  now?: () => Date;
  leadMinutes: number;
  leaseSeconds: number;
  /** A fresh random id for this tick (the lease owner). */
  owner: string;
}

export interface DuePullSummary {
  claimed: number;
  completed: number;
  partial: number;
  failed: number;
  /** The tick stopped claiming because too little time was left. */
  stoppedForTime: boolean;
}

/** What a finished pipeline run means for the schedule. */
export function outcomeOf(result: PipelineResult, dueFor: Date): { outcome: "complete" | "partial"; retryAt: Date | null } {
  const s = result.schedule;
  if (!s) return { outcome: "complete", retryAt: null };
  if (s.notStarted > 0 || s.summariesNotStarted > 0) return { outcome: "partial", retryAt: null };
  if (s.retryAt) {
    const at = new Date(s.retryAt);
    // A failed feed that can be retried before the briefing is due: come back for it then.
    if (at.getTime() <= dueFor.getTime()) return { outcome: "partial", retryAt: at };
  }
  return { outcome: "complete", retryAt: null };
}

/** A short, storable code for an error (pull_schedule.last_error): never its message. */
export function failureCode(err: unknown): string {
  const raw = err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
    ? (err as { code: string }).code
    : err instanceof Error ? err.name : "unknown";
  return raw.toLowerCase().replace(/[^a-z0-9_+]/g, "_").slice(0, 40) || "unknown";
}

export async function runDuePulls(deps: DuePullDeps): Promise<DuePullSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: DuePullSummary = { claimed: 0, completed: 0, partial: 0, failed: 0, stoppedForTime: false };

  for (;;) {
    // The cheapest source is a feed: if not even one fits, stop claiming.
    if (!deps.budget.canStart("feed")) {
      summary.stoppedForTime = true;
      break;
    }
    const claim = await deps.store.claimNext({
      now: now(),
      leadMinutes: deps.leadMinutes,
      leaseSeconds: deps.leaseSeconds,
      owner: deps.owner,
    });
    if (!claim) break;
    summary.claimed++;

    let outcome: FinishOutcome;
    let retryAt: Date | null = null;
    let error: string | null = null;
    try {
      const result = await deps.runUser(claim.userId, {
        cycleStart: claim.cycleStartedAt,
        deliveryAt: claim.dueFor,
        playableSince: new Date(claim.dueFor.getTime() - deps.leadMinutes * 60_000),
        canStart: (work) => deps.budget.canStart(work),
      });
      ({ outcome, retryAt } = outcomeOf(result, claim.dueFor));
    } catch (err) {
      outcome = "failed";
      error = failureCode(err);
    }

    try {
      await deps.store.finish({ userId: claim.userId, owner: deps.owner, now: now(), outcome, retryAt, error });
    } catch {
      // The lease runs out on its own and the next tick tries again.
      outcome = "failed";
    }
    if (outcome === "complete") summary.completed++;
    else if (outcome === "partial") summary.partial++;
    else summary.failed++;
  }
  return summary;
}
