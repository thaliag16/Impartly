// The pull-and-summarize pipeline for ONE user:
//   1. load the user's settings (summary length), newsletter sources and mail connections
//   2. for each active connection: pull newsletters received since its last pull (or the
//      last 24 hours on the first pull) through the read-only mail adapter
//   3. store them, and add newly seen newsletter senders to newsletter_sources
//   4. on MailAuthError (grant revoked or expired) mark the connection status 'error' so
//      the user is asked to reconnect, and carry on with the rest
//   5. summarize the user's stored newsletters that have no summary at the chosen length
//      yet, through lib/summarizer, and store the summaries
//
// Idempotent: storing is keyed on the provider's message id and summaries on (newsletter,
// length), so running it twice stores nothing twice and summarizes nothing twice.
//
// Bounded: at most `maxMessagesPerConnection` messages are listed per connection per run
// (newest first), each newsletter's text is capped at `maxCharsPerNewsletter`, and at most
// `maxSummariesPerRun` summaries totalling `maxSummaryCharsPerRun` input characters are
// requested per run, so one huge inbox cannot run up model cost. Whatever is left is
// picked up by the next run (within `pendingWindowHours`).
//
// Failure isolation: one newsletter failing to store or summarize is counted and skipped;
// one connection failing does not stop the others. Results hold counts and short error
// codes only, never newsletter text, addresses or tokens, so they are safe to log.

import { MailAuthError, pullNewsletters, type MailAdapter } from "../mail";
import type { Newsletter, SummaryProvider } from "../summarizer/types";
import type { PipelineConnection, PipelineStore } from "./store";

export interface PipelineLimits {
  maxMessagesPerConnection: number;
  maxCharsPerNewsletter: number;
  maxSummariesPerRun: number;
  maxSummaryCharsPerRun: number;
  /** How far back the first pull of a new connection looks. */
  firstPullWindowHours: number;
  /** Newsletters older than this are no longer summarized if they were missed. */
  pendingWindowHours: number;
}

export const DEFAULT_PIPELINE_LIMITS: Readonly<PipelineLimits> = Object.freeze({
  maxMessagesPerConnection: 50,
  maxCharsPerNewsletter: 20_000,
  maxSummariesPerRun: 30,
  maxSummaryCharsPerRun: 200_000,
  firstPullWindowHours: 24,
  pendingWindowHours: 72,
});

export interface PipelineDeps {
  store: PipelineStore;
  /** The read-only adapter for one stored connection. May throw (e.g. unsupported provider). */
  adapterFor(connection: PipelineConnection): MailAdapter;
  summarizer: SummaryProvider;
  now?: () => Date;
  limits?: Partial<PipelineLimits>;
}

export type ConnectionOutcome =
  | "pulled"
  | "auth_error" // marked status = 'error'; the user must reconnect
  | "failed" // anything else; last_synced_at not moved, so the next run retries
  | "skipped"; // not active (error or revoked)

export interface ConnectionResult {
  connectionId: string;
  outcome: ConnectionOutcome;
  listed: number;
  /** The list hit maxMessagesPerConnection: older mail in the window was not read. */
  capped: boolean;
  stored: number;
  alreadyStored: number;
  storeFailures: number;
  newSenders: number;
  error?: string;
}

export interface PipelineResult {
  userId: string;
  connections: ConnectionResult[];
  /**
   * deferred: newsletters left for a later run by the per-run caps. The pending list is
   * read with one row beyond maxSummariesPerRun, so this is a lower bound, not a total.
   */
  summaries: { created: number; failed: number; deferred: number };
}

/** A short, safe label for an error: its name only (never its message). */
function errorCode(err: unknown): string {
  if (err instanceof MailAuthError) return "mail_auth";
  if (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name;
  return "unknown";
}

export async function runPipelineForUser(userId: string, deps: PipelineDeps): Promise<PipelineResult> {
  const limits: PipelineLimits = { ...DEFAULT_PIPELINE_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const runStart = now();
  const state = await deps.store.load(userId);
  const result: PipelineResult = {
    userId,
    connections: [],
    summaries: { created: 0, failed: 0, deferred: 0 },
  };

  // Senders added during this run count as known for the next connection.
  const sources = state.sources.map((s) => ({ ...s }));

  for (const connection of state.connections) {
    const r: ConnectionResult = {
      connectionId: connection.id,
      outcome: "skipped",
      listed: 0,
      capped: false,
      stored: 0,
      alreadyStored: 0,
      storeFailures: 0,
      newSenders: 0,
    };
    result.connections.push(r);
    if (connection.status !== "active") continue;

    const since = connection.lastSyncedAt
      ? new Date(connection.lastSyncedAt)
      : new Date(runStart.getTime() - limits.firstPullWindowHours * 3600_000);

    let selection;
    try {
      const adapter = deps.adapterFor(connection);
      selection = await pullNewsletters(adapter, {
        sources,
        since,
        limit: limits.maxMessagesPerConnection,
        maxChars: limits.maxCharsPerNewsletter,
      });
    } catch (err) {
      r.error = errorCode(err);
      if (err instanceof MailAuthError) {
        r.outcome = "auth_error";
        try {
          await deps.store.markConnection(userId, connection.id, { status: "error" });
        } catch (markErr) {
          r.error = `mail_auth+${errorCode(markErr)}`;
        }
      } else {
        r.outcome = "failed";
      }
      continue;
    }

    const s = selection.skipped;
    r.listed = selection.newsletters.length + s.beforeSince + s.notNewsletter + s.excluded + s.empty;
    r.capped = r.listed >= limits.maxMessagesPerConnection;

    for (const n of selection.newsletters) {
      try {
        const saved = await deps.store.saveNewsletter(userId, {
          connectionId: connection.id,
          providerMessageId: n.providerMessageId,
          senderAddress: n.senderAddress,
          senderName: n.senderName,
          subject: n.subject,
          receivedAt: n.receivedAt,
          bodyText: n.bodyText,
        });
        if (saved.inserted) r.stored++;
        else r.alreadyStored++;
      } catch {
        r.storeFailures++;
      }
    }

    if (selection.discoveredSenders.length) {
      try {
        r.newSenders = await deps.store.addSources(userId, selection.discoveredSenders);
        for (const d of selection.discoveredSenders) sources.push({ senderAddress: d.address, included: true });
      } catch (err) {
        r.error = errorCode(err);
      }
    }

    r.outcome = "pulled";
    // Move the window forward only when everything pulled was stored; otherwise the next
    // run reads the same window again (storing is idempotent, so nothing doubles).
    if (r.storeFailures === 0) {
      try {
        await deps.store.markConnection(userId, connection.id, { syncedAt: runStart });
      } catch (err) {
        r.error = errorCode(err);
      }
    }
  }

  // Summaries: everything stored recently without a summary at the user's length,
  // including newsletters a previous run stored but could not summarize.
  const length = state.summaryLength;
  const pendingSince = new Date(runStart.getTime() - limits.pendingWindowHours * 3600_000);
  // Ask for one more than allowed, to know whether anything was deferred.
  const pending = await deps.store.pendingSummaries(userId, length, pendingSince, limits.maxSummariesPerRun + 1);
  let chars = 0;
  let requested = 0;
  for (const n of pending) {
    const text = n.bodyText.slice(0, limits.maxCharsPerNewsletter);
    if (requested >= limits.maxSummariesPerRun || chars + text.length > limits.maxSummaryCharsPerRun) {
      result.summaries.deferred++;
      continue;
    }
    requested++;
    chars += text.length;
    const input: Newsletter = {
      from: n.senderName ? `${n.senderName} <${n.senderAddress}>` : n.senderAddress,
      subject: n.subject,
      receivedAt: n.receivedAt,
      text,
    };
    try {
      const summary = (await deps.summarizer.summarize(input, { length })).trim();
      if (!summary) throw new Error("EmptySummary");
      if (await deps.store.saveSummary(userId, n.id, length, summary)) result.summaries.created++;
    } catch {
      result.summaries.failed++;
    }
  }

  return result;
}
