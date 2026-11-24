// The newsletter picker's server logic. The server actions in app/newsletters/actions.ts
// only find the signed-in user and wire real dependencies into these functions; tests wire
// fakes (no network, no Supabase).
//
//   previewNewsletter  validate the input, take a rate-limit slot, discover the feed
//                      (lib/sources/web/discover.ts: robots.txt, SSRF checks, limits) and
//                      return what was found, without storing anything
//   addNewsletter      the same checks, then discovery again and feeds_subscribe: only a
//                      URL the server itself found to be a valid feed is stored, never a
//                      value the browser sends
//   setFeedIncluded    feeds_set_included (own feed only, server-only SQL function)
//   removeFeed         feeds_remove (own feed only; its stored issues go with it)
//
// Every input arrives from the browser and is treated as untrusted: types, lengths and
// characters are checked here before anything else happens.

import type { Rpc } from "../mail/token-store";
import { catalogLookup, type CatalogEntry, type CatalogUnavailable } from "../sources/web/catalog";
import { discoverFeed, type DiscoveryResult } from "../sources/web/discover";
import type { WebFetcher } from "../sources/web/fetcher";
import { subscribeToNewsletter } from "../sources/web/subscribe";
import type { AddOutcome, CatalogPick, ChangeOutcome, FeedPreview, PickerError, PickerFailure, PreviewOutcome } from "./types";

/** Discoveries (previews and adds) allowed per user per window. Each makes up to 8 requests. */
export const DISCOVERY_LIMIT = 20;
export const DISCOVERY_WINDOW_SECONDS = 10 * 60;
export const MAX_QUERY_LENGTH = 300;

export interface PickerDeps {
  /** Service-role RPC (server only). */
  rpc: Rpc;
  /** A fresh polite web fetcher per discovery (robots.txt cached per fetcher). */
  fetcher(): WebFetcher;
  catalog: readonly CatalogEntry[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A trimmed query, or null if it is not a usable one. */
export function validateQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim();
  if (!q || q.length > MAX_QUERY_LENGTH) return null;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(q)) return null;
  return q;
}

export function validateFeedId(raw: unknown): string | null {
  return typeof raw === "string" && UUID.test(raw) ? raw.toLowerCase() : null;
}

/** Maps a failed discovery to what the user is told. Never echoes anything from the site. */
export function discoveryError(result: Extract<DiscoveryResult, { ok: false }>, query = ""): PickerError {
  // A URL with a scheme that discovery could not use (e.g. a bare "localhost") is bad input.
  if (result.reason === "not_found") return /^[a-z][a-z0-9+.-]*:\/\//i.test(query) ? "invalid_input" : "not_found";
  // The first URL's failure says most about the site (later ones are guesses at feed paths).
  const code = result.startError && result.startError !== "http_404" ? result.startError : (result.lastError ?? "");
  if (code === "blocked_address" || code === "blocked_host") return "blocked";
  if (result.reason === "invalid_input") return "invalid_input";
  if (code === "robots_disallowed" || code === "robots_unreachable") return "robots";
  if (/^http_(401|402|403|451)$/.test(code)) return "refused";
  if (code === "dns_failed" || code === "network_error" || code === "timeout") return "unreachable";
  return "no_feed";
}

/** The failure for a query naming a catalog entry Impartly cannot read, else null
 * (checked before any rate-limit slot or request). Carries the entry's picker note. */
function unavailableFailure(query: string, deps: PickerDeps): PickerFailure | null {
  const entry = catalogLookup(deps.catalog, query);
  if (!entry?.unavailable) return null;
  return {
    ok: false,
    error: entry.unavailable === "not_on_web" ? "not_on_web" : "unavailable",
    ...(entry.pickerNote ? { detail: entry.pickerNote } : {}),
  };
}

/** A few words for the catalog list: why an entry is not available. */
const UNAVAILABLE_LABELS: Record<CatalogUnavailable, string> = {
  refuses_automated_access: "site refuses automated readers",
  not_on_web: "not readable on the web yet",
};

async function takeSlot(userId: string, deps: PickerDeps): Promise<boolean> {
  const ok = await deps.rpc("feeds_discovery_take", {
    p_user_id: userId,
    p_limit: DISCOVERY_LIMIT,
    p_window_seconds: DISCOVERY_WINDOW_SECONDS,
  });
  return ok === true;
}

const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

export async function previewNewsletter(userId: string, rawQuery: unknown, deps: PickerDeps): Promise<PreviewOutcome> {
  const query = validateQuery(rawQuery);
  if (!query) return { ok: false, error: "invalid_input" };
  const unavailable = unavailableFailure(query, deps);
  if (unavailable) return unavailable;
  try {
    if (!(await takeSlot(userId, deps))) return { ok: false, error: "rate_limited" };
    const found = await discoverFeed(query, deps.fetcher(), deps.catalog);
    if (!found.ok) return { ok: false, error: discoveryError(found as Extract<DiscoveryResult, { ok: false }>, query) };
    const f = (found as Extract<DiscoveryResult, { ok: true }>).feed;
    const entry = f.catalogId ? deps.catalog.find((e) => e.id === f.catalogId) : undefined;
    const preview: FeedPreview = {
      kind: f.format === "archive" ? "archive" : "feed",
      ...(f.archive ? { issues: f.archive.issues.map((i) => ({ title: i.title, publishedAt: i.publishedAt })) } : {}),
      // Adding sends this back; a catalog entry is re-found by its id.
      query: entry ? entry.id : query,
      title: f.title,
      site: hostOf(f.homepageUrl) ?? hostOf(f.feedUrl) ?? "",
      siteUrl: f.homepageUrl,
      feedUrl: f.feedUrl,
      lastIssueAt: f.latestIssueAt,
      itemCount: f.itemCount,
      fromCatalog: !!entry,
      ...(entry?.pickerNote ? { note: entry.pickerNote } : {}),
    };
    return { ok: true, preview };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export async function addNewsletter(userId: string, rawQuery: unknown, deps: PickerDeps): Promise<AddOutcome> {
  const query = validateQuery(rawQuery);
  if (!query) return { ok: false, error: "invalid_input" };
  const unavailable = unavailableFailure(query, deps);
  if (unavailable) return unavailable;
  try {
    if (!(await takeSlot(userId, deps))) return { ok: false, error: "rate_limited" };
    const r = await subscribeToNewsletter(userId, query, { rpc: deps.rpc, fetcher: deps.fetcher(), catalog: deps.catalog });
    if (!r.ok) return { ok: false, error: discoveryError(r as Extract<DiscoveryResult, { ok: false }>, query) };
    const added = r as Extract<typeof r, { ok: true }>;
    return { ok: true, feedId: added.feedId, title: added.feed.title, inserted: added.inserted };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export async function setFeedIncluded(userId: string, rawFeedId: unknown, rawIncluded: unknown, deps: Pick<PickerDeps, "rpc">): Promise<ChangeOutcome> {
  const feedId = validateFeedId(rawFeedId);
  if (!feedId || typeof rawIncluded !== "boolean") return { ok: false, error: "invalid_input" };
  try {
    const ok = await deps.rpc("feeds_set_included", { p_user_id: userId, p_feed_id: feedId, p_included: rawIncluded });
    return ok === true ? { ok: true } : { ok: false, error: "not_yours" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export async function removeFeed(userId: string, rawFeedId: unknown, deps: Pick<PickerDeps, "rpc">): Promise<ChangeOutcome> {
  const feedId = validateFeedId(rawFeedId);
  if (!feedId) return { ok: false, error: "invalid_input" };
  try {
    const ok = await deps.rpc("feeds_remove", { p_user_id: userId, p_feed_id: feedId });
    return ok === true ? { ok: true } : { ok: false, error: "not_yours" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** The catalog as the picker shows it (no network). */
export function catalogPicks(catalog: readonly CatalogEntry[]): CatalogPick[] {
  return catalog.map((e) => ({
    id: e.id,
    name: e.name,
    site: hostOf(e.homepageUrl) ?? "",
    aliases: e.aliases ?? [],
    ...(e.unavailable ? { unavailable: true as const, unavailableLabel: UNAVAILABLE_LABELS[e.unavailable] } : {}),
  }));
}

