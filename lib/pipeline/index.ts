// The pull-and-summarize pipeline (one user per run). See run.ts for the steps and limits.
// Production wiring (service-role client, web fetcher, Gmail, summarizer from env) is in from-env.ts,
// which is server-only.

export { runPipelineForUser, DEFAULT_PIPELINE_LIMITS } from "./run";
export type {
  PipelineDeps,
  PipelineLimits,
  PipelineResult,
  ConnectionResult,
  ConnectionOutcome,
  FeedResult,
  SourceResult,
  SourceOutcome,
  StoredSource,
  PipelineSchedule,
  ScheduledWork,
} from "./run";
export { createRpcPipelineStore } from "./store";
export type {
  PipelineStore,
  PipelineState,
  PipelineConnection,
  PipelineFeed,
  NewsletterRow,
  FeedItemRow,
  FeedMark,
  PendingNewsletter,
} from "./store";
