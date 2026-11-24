import "server-only";
import { handleCronPull } from "../../../../lib/routes/cron-pull";
import { runDuePullsFromEnv } from "../../../../lib/schedule/from-env";

// Called by Supabase Cron every 5 minutes (see lib/routes/cron-pull.ts). POST only: Next.js
// answers 405 for any other method. Not behind the sign-in proxy (lib/auth/access.ts);
// the bearer CRON_SECRET is its authentication.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Keep in step with PULL_TIMING.functionLimitMs in lib/schedule/budget.ts.
export const maxDuration = 60;

export function POST(request: Request) {
  const startedAt = Date.now();
  return handleCronPull(request, {
    secret: process.env.CRON_SECRET,
    run: () => runDuePullsFromEnv(startedAt),
  });
}
