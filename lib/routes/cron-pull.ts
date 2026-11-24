// The scheduled pull route (POST /api/cron/pull), called by Supabase Cron every 5 minutes
// (supabase/migrations/20261123180000_scheduled_pull.sql).
//
//   * POST only; anything else is 405.
//   * The bearer CRON_SECRET is checked first, in constant time (lib/schedule/auth.ts),
//     before anything else is created or read. Every refusal is the same 401 with the same
//     body, whether the header is missing, malformed or wrong, or CRON_SECRET is unset.
//   * A successful call returns counts only (claimed, completed, partial, failed): no user
//     ids or anything else that says which users exist.
//   * No caching, ever.

import { cronSecretConfigured, isAuthorizedCronRequest } from "../schedule/auth";
import type { DuePullSummary } from "../schedule/run-due";

export interface CronPullDeps {
  /** CRON_SECRET from the environment. */
  secret: string | undefined;
  /** Builds the real dependencies and runs one tick. Called only after the secret matched. */
  run(): Promise<DuePullSummary>;
  /** Server log, codes only. Default: console. */
  log?(message: string): void;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

export async function handleCronPull(request: Request, deps: CronPullDeps): Promise<Response> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });

  const authorized = isAuthorizedCronRequest(request.headers.get("authorization"), deps.secret);
  if (!authorized) {
    if (!cronSecretConfigured(deps.secret)) log("cron pull: CRON_SECRET is not set (or shorter than 32 characters); refusing every call");
    return json(401, { error: "unauthorized" });
  }

  try {
    const s = await deps.run();
    return json(200, {
      claimed: s.claimed,
      completed: s.completed,
      partial: s.partial,
      failed: s.failed,
      stoppedForTime: s.stoppedForTime,
    });
  } catch (err) {
    log(`cron pull: tick failed (${err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "unknown"})`);
    return json(500, { error: "pull_failed" });
  }
}
