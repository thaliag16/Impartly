// What the pipeline reads and writes, for one user at a time. The production store calls
// the service-role SQL functions in
// supabase/migrations/20261123140000_pipeline_functions.sql through an Rpc (supabase-js
// `rpc` on the server's admin client); the tests call the same functions on a real
// Postgres. Every call carries the user id, and the SQL only touches that user's rows.

import type { MailProvider, Rpc } from "../mail";
import type { SummaryLength, SummaryUsage } from "../summarizer/types";

export interface PipelineConnection {
  id: string;
  provider: MailProvider;
  status: "active" | "revoked" | "error";
  /** ISO time of the last successful pull, or null before the first. */
  lastSyncedAt: string | null;
}

/** A web feed the user picked (web_feeds row). */
export interface PipelineFeed {
  id: string;
  /** The feed URL, or for format "archive" the public archive page. */
  feedUrl: string;
  /** "rss" | "atom" for feeds, "archive" for a public archive page. Absent: a feed. */
  format?: "rss" | "atom" | "archive";
  /** Archive only: keys and links of recently stored issues (so only new pages are fetched). */
  knownUrls?: string[];
  title: string | null;
  included: boolean;
  etag: string | null;
  lastModified: string | null;
  /** ISO time of the last successful fetch, or null before the first. */
  lastFetchedAt: string | null;
  /** Consecutive failed (or cut-off) attempts; 0 after a success. */
  failureCount?: number;
  /** ISO time before which a scheduled pull does not retry this feed, or null. */
  nextAttemptAt?: string | null;
}

export interface PipelineState {
  summaryLength: SummaryLength;
  /** Mail sender rules (newsletter_sources). */
  sources: { senderAddress: string; included: boolean }[];
  connections: PipelineConnection[];
  feeds: PipelineFeed[];
}

export interface NewsletterRow {
  connectionId: string;
  providerMessageId: string;
  senderAddress: string;
  senderName?: string;
  subject: string;
  receivedAt: string;
  bodyText: string;
}

export interface FeedItemRow {
  feedId: string;
  itemKey: string;
  senderAddress: string;
  senderName?: string;
  subject: string;
  receivedAt: string;
  bodyText: string;
  partial: boolean;
  sourceUrl?: string;
}

export interface FeedMark {
  /** Success: when it was fetched, and the cache validators to send next time. */
  fetchedAt?: Date;
  etag?: string | null;
  lastModified?: string | null;
  /** Failure: a short code (lower case letters, digits, "_" and "+"). */
  error?: string;
}

export interface PendingNewsletter {
  id: string;
  senderAddress: string;
  senderName: string | null;
  subject: string;
  receivedAt: string;
  bodyText: string;
}

/** One summary's spend (summary_usage): counts and cost only, never text. */
export interface UsageRow {
  /** The issue the model was asked about (the first, when identical issues share one call). */
  newsletterId: string;
  /** The delivery a scheduled pull was for; null outside the schedule. */
  deliveryAt: Date | null;
  length: SummaryLength;
  usage: SummaryUsage;
}

export interface PipelineStore {
  load(userId: string): Promise<PipelineState>;
  saveNewsletter(userId: string, row: NewsletterRow): Promise<{ id: string; inserted: boolean }>;
  addSources(userId: string, senders: { address: string; name?: string }[]): Promise<number>;
  /**
   * Issues received since `since` with no summary at `length`, newest first, leaving out
   * switched-off feeds and, when `storedSince` is given, issues stored before it.
   */
  pendingSummaries(
    userId: string,
    length: SummaryLength,
    since: Date,
    limit: number,
    storedSince?: Date | null,
  ): Promise<PendingNewsletter[]>;
  /** Copies existing summaries to pending issues with identical text; returns how many. */
  reuseSummaries(userId: string, length: SummaryLength, since: Date, storedSince?: Date | null): Promise<number>;
  /** Records one summary's spend. */
  recordUsage(userId: string, row: UsageRow): Promise<void>;
  saveSummary(userId: string, newsletterId: string, length: SummaryLength, text: string): Promise<boolean>;
  markConnection(
    userId: string,
    connectionId: string,
    update: { status?: "active" | "error"; syncedAt?: Date },
  ): Promise<void>;
  saveFeedItem(userId: string, row: FeedItemRow): Promise<{ id: string; inserted: boolean }>;
  /**
   * Called just before a feed is fetched. Counts the attempt as a failure until markFeed
   * records a success, so a fetch cut off with the function still backs off. Returns when
   * the feed may next be retried if this attempt fails.
   */
  beginFeedAttempt(userId: string, feedId: string, at: Date): Promise<Date | null>;
  markFeed(userId: string, feedId: string, mark: FeedMark): Promise<void>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const LENGTHS = new Set<string>(["headline", "brief", "deep"]);

function asArray(value: unknown, fn: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${fn} returned an unexpected shape`);
  return value as Record<string, unknown>[];
}

export function createRpcPipelineStore(rpc: Rpc): PipelineStore {
  return {
    async load(userId) {
      const raw = (await rpc("pipeline_load", { p_user_id: userId })) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") throw new Error("pipeline_load returned nothing");
      const length = String(raw.summary_length);
      return {
        summaryLength: (LENGTHS.has(length) ? length : "brief") as SummaryLength,
        sources: asArray(raw.sources, "pipeline_load").map((s) => ({
          senderAddress: String(s.sender_address),
          included: s.included === true,
        })),
        connections: asArray(raw.connections, "pipeline_load").map((c) => ({
          id: String(c.id),
          provider: c.provider as MailProvider,
          status: c.status as PipelineConnection["status"],
          lastSyncedAt: typeof c.last_synced_at === "string" ? c.last_synced_at : null,
        })),
        // Older databases (before the web_feeds migration) return no feeds key.
        feeds: (raw.feeds === undefined ? [] : asArray(raw.feeds, "pipeline_load")).map((f) => ({
          id: String(f.id),
          feedUrl: String(f.feed_url),
          title: str(f.title),
          included: f.included === true,
          etag: str(f.etag),
          lastModified: str(f.last_modified),
          lastFetchedAt: str(f.last_fetched_at),
          format: f.feed_format === "archive" ? ("archive" as const) : f.feed_format === "atom" ? ("atom" as const) : ("rss" as const),
          knownUrls: Array.isArray(f.known_urls) ? (f.known_urls as unknown[]).filter((u): u is string => typeof u === "string") : [],
          failureCount: typeof f.failure_count === "number" ? f.failure_count : 0,
          nextAttemptAt: str(f.next_attempt_at),
        })),
      };
    },
    async saveNewsletter(userId, row) {
      const raw = (await rpc("pipeline_save_newsletter", {
        p_user_id: userId,
        p_connection_id: row.connectionId,
        p_provider_message_id: row.providerMessageId,
        p_sender_address: row.senderAddress,
        p_sender_name: row.senderName ?? null,
        p_subject: row.subject,
        p_received_at: row.receivedAt,
        p_body_text: row.bodyText,
      })) as { id?: unknown; inserted?: unknown } | null;
      if (!raw || typeof raw.id !== "string") throw new Error("pipeline_save_newsletter returned no id");
      return { id: raw.id, inserted: raw.inserted === true };
    },
    async addSources(userId, senders) {
      if (!senders.length) return 0;
      const added = await rpc("pipeline_add_sources", { p_user_id: userId, p_senders: senders });
      return typeof added === "number" ? added : Number(added ?? 0);
    },
    async pendingSummaries(userId, length, since, limit, storedSince) {
      const raw = await rpc("pipeline_pending_summaries", {
        p_user_id: userId,
        p_length: length,
        p_since: since.toISOString(),
        p_limit: limit,
        p_stored_since: storedSince ? storedSince.toISOString() : null,
      });
      return asArray(raw, "pipeline_pending_summaries").map((n) => ({
        id: String(n.id),
        senderAddress: String(n.sender_address),
        senderName: typeof n.sender_name === "string" ? n.sender_name : null,
        subject: String(n.subject ?? ""),
        receivedAt: String(n.received_at),
        bodyText: String(n.body_text ?? ""),
      }));
    },
    async reuseSummaries(userId, length, since, storedSince) {
      const copied = await rpc("pipeline_reuse_summaries", {
        p_user_id: userId,
        p_length: length,
        p_since: since.toISOString(),
        p_stored_since: storedSince ? storedSince.toISOString() : null,
      });
      return typeof copied === "number" ? copied : Number(copied ?? 0);
    },
    async recordUsage(userId, { newsletterId, deliveryAt, length, usage }) {
      const whole = (n: number) => Math.max(0, Math.round(n));
      await rpc("pipeline_record_usage", {
        p_user_id: userId,
        p_newsletter_id: newsletterId,
        p_delivery_at: deliveryAt ? deliveryAt.toISOString() : null,
        p_length: length,
        p_model: usage.model,
        p_requests: whole(usage.requests),
        p_prompt_tokens: whole(usage.promptTokens),
        p_completion_tokens: whole(usage.completionTokens),
        p_reasoning_tokens: whole(usage.reasoningTokens),
        p_thinking: usage.thinking,
        p_cost_usd: usage.cost ?? null,
      });
    },
    async saveSummary(userId, newsletterId, length, text) {
      const inserted = await rpc("pipeline_save_summary", {
        p_user_id: userId,
        p_newsletter_id: newsletterId,
        p_length: length,
        p_summary_text: text,
      });
      return inserted === true;
    },
    async markConnection(userId, connectionId, update) {
      await rpc("pipeline_mark_connection", {
        p_user_id: userId,
        p_connection_id: connectionId,
        p_status: update.status ?? null,
        p_synced_at: update.syncedAt ? update.syncedAt.toISOString() : null,
      });
    },
    async saveFeedItem(userId, row) {
      const raw = (await rpc("pipeline_save_feed_item", {
        p_user_id: userId,
        p_feed_id: row.feedId,
        p_item_key: row.itemKey,
        p_sender_address: row.senderAddress,
        p_sender_name: row.senderName ?? null,
        p_subject: row.subject,
        p_received_at: row.receivedAt,
        p_body_text: row.bodyText,
        p_partial: row.partial,
        p_source_url: row.sourceUrl ?? null,
      })) as { id?: unknown; inserted?: unknown } | null;
      if (!raw || typeof raw.id !== "string") throw new Error("pipeline_save_feed_item returned no id");
      return { id: raw.id, inserted: raw.inserted === true };
    },
    async beginFeedAttempt(userId, feedId, at) {
      const raw = await rpc("pipeline_begin_feed", { p_user_id: userId, p_feed_id: feedId, p_at: at.toISOString() });
      // supabase-js returns timestamptz as a string; node-postgres (tests) as a Date.
      const t = typeof raw === "string" ? Date.parse(raw) : raw instanceof Date ? raw.getTime() : NaN;
      return Number.isFinite(t) ? new Date(t) : null;
    },
    async markFeed(userId, feedId, mark) {
      await rpc("pipeline_mark_feed", {
        p_user_id: userId,
        p_feed_id: feedId,
        p_fetched_at: mark.fetchedAt ? mark.fetchedAt.toISOString() : null,
        p_etag: mark.etag ?? null,
        p_last_modified: mark.lastModified ?? null,
        p_error: mark.error ?? null,
      });
    },
  };
}
