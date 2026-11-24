// The pull-and-summarize pipeline for ONE user:
//   1. load the user's settings (summary length), mail sender rules, mail connections and
//      web feeds
//   2. turn each into a NewsletterSource (lib/sources): a web feed the user picked, or a
//      connected mailbox (optional). The pipeline only sees the source interface, so later
//      sources (forwarding, iPhone mail access) plug in without changing this file
//   3. pull each active source: items published or received since its last pull (or the
//      last 24 hours on the first pull), store them (de-duplicated by the source's item
//      key), and for mail add newly seen newsletter senders to newsletter_sources
//   4. on SourceAuthError (a mailbox grant revoked or expired) mark the connection status
//      'error' so the user is asked to reconnect; any other failure is recorded and the
//      rest carry on
//   5. summarize the user's stored newsletters that have no summary at the chosen length
//      yet, through lib/summarizer, and store the summaries
//
// Idempotent: storing is keyed on (connection, provider message id) for mail and (feed,
// item key) for web feeds, and summaries on (newsletter, length), so running it twice
// stores nothing twice and summarizes nothing twice.
//
// Bounded: at most `maxMessagesPerConnection` items are taken per source per run (newest
// first), each newsletter's text is capped at `maxCharsPerNewsletter`, and at most
// `maxSummariesPerRun` summaries totalling `maxSummaryCharsPerRun` input characters are
// requested per run, so one huge inbox or feed cannot run up model cost. Whatever is left
// is picked up by the next run (within `pendingWindowHours`).
//
// Failure isolation: one newsletter failing to store or summarize is counted and skipped;
// one source failing does not stop the others. Results hold counts and short error codes
// only, never newsletter text, addresses, URLs or tokens, so they are safe to log.
//
// Scheduled runs (`schedule`, from lib/schedule): one delivery's pull may span several
// function invocations. A source already pulled since the cycle started is skipped
// ("done"); a web feed whose retry time lies ahead is skipped ("waiting"); work that
// would not fit in the time left is not started ("not_started"), and the next tick picks
// it up. Every web feed attempt is marked before it starts (beginFeedAttempt), so a
// fetch cut off with the function backs off like a failure.

import type { MailAdapter, NewsletterSource as SenderRule } from "../mail";
import { mailSource } from "../sources/mail";
import { SourceAuthError, SourceFetchError, type NewsletterSource, type PullResult } from "../sources/types";
import type { WebFetcher } from "../sources/web/fetcher";
import { createPacer, webArchiveSource, type Pacer } from "../sources/web/archive-source";
import { webFeedSource } from "../sources/web/feed-source";
import type { Newsletter, SummaryProvider } from "../summarizer/types";
import type { PipelineConnection, PipelineFeed, PipelineStore } from "./store";

export interface PipelineLimits {
  /** Per source (mail connection or web feed) per run. */
  maxMessagesPerConnection: number;
  maxCharsPerNewsletter: number;
  maxSummariesPerRun: number;
  maxSummaryCharsPerRun: number;
  /** How far back the first pull of a new source looks. Web feeds also re-read this much
   * before their last fetch, since items can be dated before they appear in the feed. */
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

/** A stored source, before it is turned into a NewsletterSource. */
export type StoredSource =
  | { kind: "mail"; connection: PipelineConnection }
  | { kind: "web"; feed: PipelineFeed };

export interface PipelineDeps {
  store: PipelineStore;
  /**
   * Builds the NewsletterSource for a stored source. When absent, mail connections use
   * `adapterFor` and web feeds use `webFetcher`. May throw (e.g. unsupported provider).
   */
  sourceFor?(stored: StoredSource, context: { senderRules: () => readonly SenderRule[] }): NewsletterSource;
  /** The read-only adapter for one stored mail connection (mail is optional). */
  adapterFor?(connection: PipelineConnection): MailAdapter;
  /** The polite web fetcher (one per run, so robots.txt is read once per site). */
  webFetcher?: WebFetcher;
  /** Spaces archive requests per site (tests pass one with a fake clock). Default: real time. */
  pacer?: Pacer;
  summarizer: SummaryProvider;
  now?: () => Date;
  limits?: Partial<PipelineLimits>;
  /** Set by the scheduled pull (lib/schedule). Absent: pull every active source now. */
  schedule?: PipelineSchedule;
}

/** The kinds of work a scheduled run budgets time for. */
export type ScheduledWork = "mail" | "feed" | "archive" | "summary";

export interface PipelineSchedule {
  /** Sources pulled at or after this belong to the current cycle and are skipped. */
  cycleStart: Date;
  /** True when there is time left to start (and finish) this kind of work. */
  canStart(work: ScheduledWork): boolean;
}

export type SourceOutcome =
  | "pulled"
  | "not_modified" // web feed answered 304: nothing new
  | "auth_error" // marked status = 'error'; the user must reconnect
  | "failed" // anything else; the window is not moved, so the next run retries
  | "skipped" // not active (mail error or revoked) or switched off (web feed)
  | "done" // scheduled: already pulled in this cycle
  | "waiting" // scheduled: a web feed whose retry time lies ahead
  | "not_started"; // scheduled: not enough time left in this invocation

export interface SourceResult {
  kind: "mail" | "web";
  sourceId: string;
  outcome: SourceOutcome;
  listed: number;
  /** The source had more than maxMessagesPerConnection items: older ones were not read. */
  capped: boolean;
  stored: number;
  alreadyStored: number;
  storeFailures: number;
  /** Mail only: new senders added to newsletter_sources. */
  newSenders: number;
  /** Items stored as partial (only a teaser or excerpt was public). */
  partial: number;
  /** Web feeds that failed: when they may be retried. */
  retryAt?: string;
  error?: string;
}

export type ConnectionOutcome = "pulled" | "auth_error" | "failed" | "skipped";

/** A mail connection's result (the mail view of SourceResult). */
export interface ConnectionResult {
  connectionId: string;
  outcome: ConnectionOutcome;
  listed: number;
  capped: boolean;
  stored: number;
  alreadyStored: number;
  storeFailures: number;
  newSenders: number;
  error?: string;
}

/** A web feed's result (the web view of SourceResult). */
export interface FeedResult {
  feedId: string;
  outcome: SourceOutcome;
  listed: number;
  capped: boolean;
  stored: number;
  alreadyStored: number;
  storeFailures: number;
  partial: number;
  error?: string;
}

export interface PipelineResult {
  userId: string;
  /** Every source, mail connections first, in stored order. */
  sources: SourceResult[];
  connections: ConnectionResult[];
  feeds: FeedResult[];
  /**
   * deferred: newsletters left for a later run by the per-run caps. The pending list is
   * read with one row beyond maxSummariesPerRun, so this is a lower bound, not a total.
   */
  summaries: { created: number; failed: number; deferred: number };
  /** Scheduled runs only: what is left for a later invocation. */
  schedule?: {
    /** Sources not started for lack of time. */
    notStarted: number;
    /** Summaries not started for lack of time. */
    summariesNotStarted: number;
    /** The earliest time a waiting or just-failed web feed may be retried (ISO), or null. */
    retryAt: string | null;
  };
}

/** A short, safe label for an error: a known code, or the error's name (never its message). */
function errorCode(err: unknown): string {
  if (err instanceof SourceAuthError || err instanceof SourceFetchError) return err.code;
  if (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name;
  return "unknown";
}

/** web_feeds.last_error accepts lower case letters, digits, "_" and "+" only. */
const storableCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9_+]/g, "_").slice(0, 40) || "unknown";

function defaultSourceFor(deps: PipelineDeps, now: () => Date): NonNullable<PipelineDeps["sourceFor"]> {
  // One pacer per run: archive requests to the same site are spaced across all its sources.
  const pacer = deps.pacer ?? createPacer();
  return (stored, context) => {
    if (stored.kind === "mail") {
      if (!deps.adapterFor) throw new Error("NoMailAdapter");
      return mailSource({ id: stored.connection.id, adapter: deps.adapterFor(stored.connection), senderRules: context.senderRules });
    }
    if (!deps.webFetcher) throw new Error("NoWebFetcher");
    const f = stored.feed;
    if (f.format === "archive") {
      return webArchiveSource(
        { id: f.id, archiveUrl: f.feedUrl, title: f.title, etag: f.etag, lastModified: f.lastModified, knownUrls: f.knownUrls ?? [] },
        deps.webFetcher,
        { pacer, now },
      );
    }
    return webFeedSource(
      { id: f.id, feedUrl: f.feedUrl, title: f.title, etag: f.etag, lastModified: f.lastModified },
      deps.webFetcher,
      now,
    );
  };
}

export async function runPipelineForUser(userId: string, deps: PipelineDeps): Promise<PipelineResult> {
  const limits: PipelineLimits = { ...DEFAULT_PIPELINE_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const runStart = now();
  const state = await deps.store.load(userId);
  const sourceFor = deps.sourceFor ?? defaultSourceFor(deps, now);
  const result: PipelineResult = {
    userId,
    sources: [],
    connections: [],
    feeds: [],
    summaries: { created: 0, failed: 0, deferred: 0 },
  };
  const windowMs = limits.firstPullWindowHours * 3600_000;
  const schedule = deps.schedule;
  let notStarted = 0;
  let summariesNotStarted = 0;
  let retryAt: number | null = null;
  const noteRetry = (iso: string | null | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(t) && (retryAt === null || t < retryAt)) retryAt = t;
  };

  // Senders added during this run count as known for the next mail connection.
  const senderRules: SenderRule[] = state.sources.map((s) => ({ ...s }));

  const stored: StoredSource[] = [
    ...state.connections.map((connection) => ({ kind: "mail" as const, connection })),
    ...state.feeds.map((feed) => ({ kind: "web" as const, feed })),
  ];

  for (const s of stored) {
    const id = s.kind === "mail" ? s.connection.id : s.feed.id;
    const r: SourceResult = {
      kind: s.kind,
      sourceId: id,
      outcome: "skipped",
      listed: 0,
      capped: false,
      stored: 0,
      alreadyStored: 0,
      storeFailures: 0,
      newSenders: 0,
      partial: 0,
    };
    result.sources.push(r);
    if (s.kind === "mail" ? s.connection.status !== "active" : !s.feed.included) continue;

    const last = s.kind === "mail" ? s.connection.lastSyncedAt : s.feed.lastFetchedAt;
    if (schedule) {
      if (last && Date.parse(last) >= schedule.cycleStart.getTime()) {
        r.outcome = "done";
        continue;
      }
      if (s.kind === "web" && s.feed.nextAttemptAt && Date.parse(s.feed.nextAttemptAt) > runStart.getTime()) {
        r.outcome = "waiting";
        noteRetry(s.feed.nextAttemptAt);
        continue;
      }
      const work: ScheduledWork = s.kind === "mail" ? "mail" : s.feed.format === "archive" ? "archive" : "feed";
      if (!schedule.canStart(work)) {
        r.outcome = "not_started";
        notStarted++;
        continue;
      }
    }
    const since = !last
      ? new Date(runStart.getTime() - windowMs)
      : s.kind === "web"
        ? new Date(Date.parse(last) - windowMs)
        : new Date(last);

    let pulled: PullResult;
    // When this web feed may be retried if this attempt fails (set by beginFeedAttempt).
    let retryIfFailed: string | undefined;
    try {
      if (s.kind === "web") {
        const next = await deps.store.beginFeedAttempt(userId, id, now());
        if (next) retryIfFailed = next.toISOString();
      }
      const source = sourceFor(s, { senderRules: () => senderRules });
      pulled = await source.pull({
        since,
        limit: limits.maxMessagesPerConnection,
        maxChars: limits.maxCharsPerNewsletter,
        firstPull: !last,
      });
    } catch (err) {
      r.error = errorCode(err);
      if (err instanceof SourceAuthError && s.kind === "mail") {
        r.outcome = "auth_error";
        try {
          await deps.store.markConnection(userId, id, { status: "error" });
        } catch (markErr) {
          r.error = `${r.error}+${errorCode(markErr)}`;
        }
      } else {
        r.outcome = "failed";
        r.retryAt = retryIfFailed;
        noteRetry(retryIfFailed);
        if (s.kind === "web") {
          try {
            await deps.store.markFeed(userId, id, { error: storableCode(r.error) });
          } catch (markErr) {
            r.error = `${r.error}+${errorCode(markErr)}`;
          }
        }
      }
      continue;
    }

    r.listed = pulled.listed;
    r.capped = pulled.capped;
    for (const item of pulled.items) {
      try {
        const saved =
          s.kind === "mail"
            ? await deps.store.saveNewsletter(userId, {
                connectionId: id,
                providerMessageId: item.key,
                senderAddress: item.senderAddress,
                senderName: item.senderName,
                subject: item.subject,
                receivedAt: item.receivedAt,
                bodyText: item.bodyText,
              })
            : await deps.store.saveFeedItem(userId, {
                feedId: id,
                itemKey: item.key,
                senderAddress: item.senderAddress,
                senderName: item.senderName,
                subject: item.subject,
                receivedAt: item.receivedAt,
                bodyText: item.bodyText,
                partial: item.partial,
                sourceUrl: item.url,
              });
        if (saved.inserted) {
          r.stored++;
          if (item.partial) r.partial++;
        } else r.alreadyStored++;
      } catch {
        r.storeFailures++;
      }
    }

    if (pulled.discoveredSenders?.length) {
      try {
        r.newSenders = await deps.store.addSources(userId, pulled.discoveredSenders);
        for (const d of pulled.discoveredSenders) senderRules.push({ senderAddress: d.address, included: true });
      } catch (err) {
        r.error = errorCode(err);
      }
    }

    r.outcome = pulled.cache?.notModified ? "not_modified" : "pulled";
    // Move the window forward only when everything pulled was stored; otherwise the next
    // run reads the same window again (storing is idempotent, so nothing doubles). For a
    // feed that also means not saving the new cache validators, or a 304 would hide the
    // items that failed to store.
    try {
      if (s.kind === "mail") {
        if (r.storeFailures === 0) await deps.store.markConnection(userId, id, { syncedAt: runStart });
      } else if (r.storeFailures === 0) {
        await deps.store.markFeed(userId, id, {
          fetchedAt: runStart,
          etag: pulled.cache?.etag ?? null,
          lastModified: pulled.cache?.lastModified ?? null,
        });
      } else {
        r.retryAt = retryIfFailed;
        noteRetry(retryIfFailed);
        await deps.store.markFeed(userId, id, { error: "store_failed" });
      }
    } catch (err) {
      r.error = errorCode(err);
    }
  }

  for (const r of result.sources) {
    if (r.kind === "mail") {
      result.connections.push({
        connectionId: r.sourceId,
        outcome:
          r.outcome === "not_modified"
            ? "pulled"
            : r.outcome === "done" || r.outcome === "waiting" || r.outcome === "not_started"
              ? "skipped"
              : r.outcome,
        listed: r.listed,
        capped: r.capped,
        stored: r.stored,
        alreadyStored: r.alreadyStored,
        storeFailures: r.storeFailures,
        newSenders: r.newSenders,
        ...(r.error ? { error: r.error } : {}),
      });
    } else {
      result.feeds.push({
        feedId: r.sourceId,
        outcome: r.outcome,
        listed: r.listed,
        capped: r.capped,
        stored: r.stored,
        alreadyStored: r.alreadyStored,
        storeFailures: r.storeFailures,
        partial: r.partial,
        ...(r.error ? { error: r.error } : {}),
      });
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
    if (schedule && !schedule.canStart("summary")) {
      summariesNotStarted++;
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

  if (schedule) {
    result.schedule = {
      notStarted,
      summariesNotStarted,
      retryAt: retryAt === null ? null : new Date(retryAt).toISOString(),
    };
  }
  return result;
}
