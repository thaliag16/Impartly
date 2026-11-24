// The schedule's database calls, through the service-role RPC (supabase-js `rpc` on the
// server's admin client; the tests call the same SQL functions on a real Postgres).

import type { Rpc } from "../mail";
import type { Claim, ScheduleStore } from "./run-due";

export function createRpcScheduleStore(rpc: Rpc): ScheduleStore {
  return {
    async claimNext({ now, leadMinutes, leaseSeconds, owner }): Promise<Claim | null> {
      const raw = (await rpc("pull_claim_next", {
        p_now: now.toISOString(),
        p_lead_minutes: leadMinutes,
        p_lease_seconds: leaseSeconds,
        p_owner: owner,
      })) as Record<string, unknown> | null;
      if (!raw) return null;
      const dueFor = Date.parse(String(raw.due_for));
      const started = Date.parse(String(raw.cycle_started_at));
      if (typeof raw.user_id !== "string" || !Number.isFinite(dueFor) || !Number.isFinite(started)) {
        throw new Error("pull_claim_next returned an unexpected shape");
      }
      return { userId: raw.user_id, dueFor: new Date(dueFor), cycleStartedAt: new Date(started) };
    },
    async finish({ userId, owner, now, outcome, retryAt, error }) {
      const ok = await rpc("pull_finish", {
        p_user_id: userId,
        p_owner: owner,
        p_now: now.toISOString(),
        p_outcome: outcome,
        p_retry_at: retryAt ? retryAt.toISOString() : null,
        p_error: error,
      });
      return ok === true;
    },
  };
}
