// The pull-and-summarize pipeline (one user per run). See run.ts for the steps and limits.
// Production wiring (service-role client, Gmail, summarizer from env) is in from-env.ts,
// which is server-only.

export { runPipelineForUser, DEFAULT_PIPELINE_LIMITS } from "./run";
export type { PipelineDeps, PipelineLimits, PipelineResult, ConnectionResult, ConnectionOutcome } from "./run";
export { createRpcPipelineStore } from "./store";
export type { PipelineStore, PipelineState, PipelineConnection, NewsletterRow, PendingNewsletter } from "./store";
