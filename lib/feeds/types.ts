// Shapes the newsletter picker sends between the server actions and the page. Plain data
// only (no URLs the browser could be steered by except the feed's own site and feed
// address, shown as text and a link). Safe to import from client components.

export type PickerError =
  | "signed_out"
  | "invalid_input"
  | "not_found"
  | "unavailable"
  | "no_feed"
  | "robots"
  | "refused"
  | "blocked"
  | "unreachable"
  | "rate_limited"
  | "failed";

export interface FeedPreview {
  /** "feed": an RSS/Atom feed. "archive": no feed, read from the public archive page. */
  kind: "feed" | "archive";
  /** Archive only: the newest issues found on the archive page (title and date). */
  issues?: { title: string; publishedAt: string | null }[];
  /** What to send back to add it: the catalog id, or the URL or domain the user gave. */
  query: string;
  title: string;
  /** The site's host, for display (e.g. "techcrunch.com"). */
  site: string;
  siteUrl: string | null;
  /** The feed URL, or for an archive the archive page. */
  feedUrl: string;
  /** Newest dated issue in the feed (ISO 8601), or null. */
  lastIssueAt: string | null;
  itemCount: number;
  fromCatalog: boolean;
  /** A short line from the catalog about this source (e.g. what it holds), if any. */
  note?: string;
}

export type PreviewOutcome = { ok: true; preview: FeedPreview } | { ok: false; error: PickerError };
export type AddOutcome = { ok: true; feedId: string; title: string; inserted: boolean } | { ok: false; error: PickerError };
export type ChangeOutcome = { ok: true } | { ok: false; error: PickerError | "not_yours" };

/** One of the user's feeds, as the page lists it (read under RLS). */
export interface FeedRow {
  id: string;
  title: string;
  homepage_url: string | null;
  feed_url: string;
  included: boolean;
  last_fetched_at: string | null;
  last_error: string | null;
}

/** A catalog entry as the picker shows it. */
export interface CatalogPick {
  id: string;
  name: string;
  site: string;
  aliases: string[];
  /** Impartly cannot read this one (its site refuses automated readers). */
  unavailable?: true;
}

export const ERROR_MESSAGES: Record<PickerError | "not_yours", string> = {
  signed_out: "Your session has ended. Please sign in again.",
  invalid_input: "Type a newsletter name, a website (like example.com) or a feed address.",
  not_found:
    "That name is not in Impartly's catalog yet. Paste the newsletter's website or feed address instead.",
  unavailable:
    "That newsletter's site refuses automated readers, so Impartly can't fetch it. Impartly does not get around that.",
  no_feed: "No public feed was found on that site, and no public list of past issues either.",
  robots: "That site asks automated readers not to fetch it (robots.txt), so Impartly won't.",
  refused: "That site refused the request. Impartly does not get around sign-ins or paywalls.",
  blocked: "That address is not a public website, so Impartly won't fetch it.",
  unreachable: "That site could not be reached. Please check the address or try again later.",
  rate_limited: "That's a lot of lookups in a few minutes. Please wait a little and try again.",
  failed: "Something went wrong. Please try again.",
  not_yours: "That newsletter is no longer in your list.",
};
