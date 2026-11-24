import "server-only";

// Production wiring for the pipeline: the service-role client's RPC for storage, the
// polite web fetcher for the user's web feeds (one per run, so robots.txt is read once per
// site), the Gmail adapter for any connected mailbox (optional; tokens from Vault), and
// the summarizer from SUMMARY_* env. Called by the scheduled pull (lib/schedule/from-env.ts).

import { gmailAdapterForConnection, createVaultTokenStore } from "../mail";
import { googleOAuthFromEnv } from "../mail/gmail/oauth";
import { createWebFetcher } from "../sources/web/fetcher";
import { summarizerFromEnv } from "../summarizer";
import { adminRpc, createAdminClient } from "../supabase/admin";
import { runPipelineForUser, type PipelineLimits, type PipelineResult, type PipelineSchedule } from "./run";
import { createRpcPipelineStore } from "./store";

export async function runPipelineForUserFromEnv(
  userId: string,
  limits?: Partial<PipelineLimits>,
  options: { schedule?: PipelineSchedule; summaryTimeoutMs?: number } = {},
): Promise<PipelineResult> {
  const rpc = adminRpc(createAdminClient());
  const tokens = createVaultTokenStore(rpc);
  const summarizer = summarizerFromEnv(process.env, undefined, { timeoutMs: options.summaryTimeoutMs });
  return runPipelineForUser(userId, {
    store: createRpcPipelineStore(rpc),
    summarizer,
    limits,
    schedule: options.schedule,
    webFetcher: createWebFetcher(),
    adapterFor(connection) {
      if (connection.provider !== "gmail") throw new Error(`No adapter for ${connection.provider} yet`);
      return gmailAdapterForConnection({ connectionId: connection.id, store: tokens, oauth: googleOAuthFromEnv() });
    },
  });
}
