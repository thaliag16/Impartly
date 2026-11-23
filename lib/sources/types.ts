// The source interface: the one way newsletters come into Impartly (CLAUDE.md).
//
// A NewsletterSource is one place a user's newsletters come from: a public web feed the
// user picked (lib/sources/web), or a connected mailbox (lib/sources/mail.ts, wrapping the
// read-only mail adapter). Later sources (a forwarding address, mail access in the iPhone
// app) implement the same interface and the pipeline (lib/pipeline) needs no change.
//
// A source only reads. It returns items as clean, visible text (lib/text/html-to-text.ts)
// and never stores, sends or changes anything; storing and summarizing is the pipeline's
// job. Every field of an item is untrusted (it came from the web or an inbox).

export type SourceKind = "mail" | "web";

/** One newsletter issue from a source, ready to store and summarize. */
export interface SourceItem {
  /**
   * De-duplication key, stable across pulls and unique within the source: the provider's
   * message id for mail; the feed item's guid/id, else its link, for web feeds.
   */
  key: string;
  /** Mail: the sender's address. Web: the feed's host name (e.g. "news.example"). */
  senderAddress: string;
  /** Mail: the sender's display name. Web: the feed's title. */
  senderName?: string;
  subject: string;
  /** ISO 8601. Mail: when it was received. Web: when it was published. */
  receivedAt: string;
  /** Visible text only, capped at the pipeline's per-newsletter limit. */
  bodyText: string;
  /** bodyText hit the character cap. */
  truncated: boolean;
  /**
   * Only part of the issue is public (a teaser, an excerpt, or a paywall notice). The
   * public part is summarized and the item is marked partial; the rest is never fetched.
   */
  partial: boolean;
  /** Web only: the item's own link (http or https). */
  url?: string;
}

export interface PullOptions {
  /** Items published or received before this are skipped. */
  since: Date;
  /** Upper bound on items returned. */
  limit: number;
  /** Per-item cap on bodyText characters. */
  maxChars: number;
  /** True on a source's first pull (no earlier successful pull). */
  firstPull: boolean;
}

export interface PullResult {
  items: SourceItem[];
  /** How many entries the source looked at (items plus skipped ones). */
  listed: number;
  /** The source had more than `limit` entries in the window; older ones were not read. */
  capped: boolean;
  /** Mail only: newsletter senders not yet in the user's newsletter_sources. */
  discoveredSenders?: { address: string; name?: string }[];
  /**
   * Web only: HTTP cache validators to send next time (conditional GET). `notModified`
   * means the server answered 304 and nothing was read.
   */
  cache?: { etag: string | null; lastModified: string | null; notModified: boolean };
}

export interface NewsletterSource {
  readonly kind: SourceKind;
  /** The stored row's id (mail_connections.id or web_feeds.id). */
  readonly id: string;
  pull(options: PullOptions): Promise<PullResult>;
}

/**
 * The source needs the user to act before it can be read again (a mailbox grant was
 * revoked or expired). `code` is short and safe to log.
 */
export class SourceAuthError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SourceAuthError";
  }
}

/**
 * A web fetch was refused or failed in a known way. `code` is short and safe to log (no
 * URL, no response text): e.g. "blocked_address", "robots_disallowed", "http_404",
 * "too_large", "timeout", "not_a_feed".
 */
export class SourceFetchError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SourceFetchError";
  }
}
