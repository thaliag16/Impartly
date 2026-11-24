import "server-only";

// Production wiring for one tick of the scheduled pull: the service-role RPC for claiming
// and finishing, the pipeline from env for each user, a time budget that starts when the
// request arrived, and the lead time from PULL_LEAD_MINUTES (default 30).

import { randomUUID } from "node:crypto";
import { runPipelineForUserFromEnv } from "../pipeline/from-env";
import { adminRpc, createAdminClient } from "../supabase/admin";
import { createTimeBudget, leadMinutesFromEnv, PULL_TIMING } from "./budget";
import { runDuePulls, type DuePullSummary } from "./run-due";
import { createRpcScheduleStore } from "./store";

export function runDuePullsFromEnv(startedAt: number, env: Record<string, string | undefined> = process.env): Promise<DuePullSummary> {
  const rpc = adminRpc(createAdminClient(env));
  return runDuePulls({
    store: createRpcScheduleStore(rpc),
    budget: createTimeBudget({ now: () => Date.now(), startedAt }),
    runUser: (userId, schedule) =>
      runPipelineForUserFromEnv(userId, undefined, { schedule, summaryTimeoutMs: PULL_TIMING.summaryTimeoutMs }),
    leadMinutes: leadMinutesFromEnv(env.PULL_LEAD_MINUTES),
    leaseSeconds: PULL_TIMING.leaseSeconds,
    owner: randomUUID(),
  });
}
