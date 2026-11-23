// What the pipeline reads and writes, for one user at a time. The production store calls
// the service-role SQL functions in
// supabase/migrations/20261123140000_pipeline_functions.sql through an Rpc (supabase-js
// `rpc` on the server's admin client); the tests call the same functions on a real
// Postgres. Every call carries the user id, and the SQL only touches that user's rows.

import type { MailProvider, Rpc } from "../mail";
import type { SummaryLength } from "../summarizer/types";

export interface PipelineConnection {
  id: string;
  provider: MailProvider;
  status: "active" | "revoked" | "error";
  /** ISO time of the last successful pull, or null before the first. */
  lastSyncedAt: string | null;
}

export interface PipelineState {
  summaryLength: SummaryLength;
  sources: { senderAddress: string; included: boolean }[];
  connections: PipelineConnection[];
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

export interface PendingNewsletter {
  id: string;
  senderAddress: string;
  senderName: string | null;
  subject: string;
  receivedAt: string;
  bodyText: string;
}

export interface PipelineStore {
  load(userId: string): Promise<PipelineState>;
  saveNewsletter(userId: string, row: NewsletterRow): Promise<{ id: string; inserted: boolean }>;
  addSources(userId: string, senders: { address: string; name?: string }[]): Promise<number>;
  pendingSummaries(userId: string, length: SummaryLength, since: Date, limit: number): Promise<PendingNewsletter[]>;
  saveSummary(userId: string, newsletterId: string, length: SummaryLength, text: string): Promise<boolean>;
  markConnection(
    userId: string,
    connectionId: string,
    update: { status?: "active" | "error"; syncedAt?: Date },
  ): Promise<void>;
}

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
    async pendingSummaries(userId, length, since, limit) {
      const raw = await rpc("pipeline_pending_summaries", {
        p_user_id: userId,
        p_length: length,
        p_since: since.toISOString(),
        p_limit: limit,
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
  };
}
