// The scheduled pull (GOAL.md Phase 1). Supabase Cron calls POST /api/cron/pull every 5
// minutes; each call claims the users whose briefing is coming due and runs the pipeline
// for them within the function's time limit. See run-due.ts for the flow, budget.ts for
// the timing, and supabase/migrations/20261123180000_scheduled_pull.sql for the SQL.
// Production wiring is in from-env.ts (server-only).

export { createTimeBudget, leadMinutesFromEnv, PULL_TIMING, type TimeBudget } from "./budget";
export { cronSecretConfigured, isAuthorizedCronRequest, MIN_CRON_SECRET_LENGTH } from "./auth";
export {
  runDuePulls,
  outcomeOf,
  failureCode,
  type Claim,
  type DuePullDeps,
  type DuePullSummary,
  type FinishOutcome,
  type ScheduleStore,
} from "./run-due";
export { createRpcScheduleStore } from "./store";
