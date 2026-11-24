// Feed discovery: from what the user typed (a catalog name, a domain or a URL) to a
// validated public feed URL.
//
//   1. A catalog name or id (data/newsletter-catalog.json) gives its feed URL, else its
//      homepage. Anything else must look like a URL or domain; a free-text name that is
//      not in the catalog is "not_found" (Impartly does not search the web for it).
//   2. If the URL itself is a feed, done.
//   3. If it is an HTML page: its <link rel="alternate"> feeds (RSS or Atom), in order.
//   4. Else common feed paths on the same site: /feed (WordPress, Substack), /rss (Ghost,
//      beehiiv custom domains), /feed.xml, /rss.xml, /atom.xml, /index.xml (Hugo).
//   5. No feed: the public web archive fallback (archive-source.ts). The catalog's
//      archiveUrl if it has one, else (on a beehiiv site) its /archive page, else the
//      first HTML page seen, is checked for issue links (JSON-LD, an advertised sitemap,
//      <article> markup, then conservative same-site links). A page that lists issues is
//      returned as format "archive" with a preview of the issues found. At most
//      ARCHIVE_EXTRA_FETCHES more requests per archive page tried, spaced politely.
// beehiiv-hosted newsletters (platforms.ts): when the first HTML page is a beehiiv page,
// a link on it to the publication's rss.beehiiv.com feed is tried first among the feeds,
// and its /archive page (with /sitemap.xml and /p/<slug> issues) before the page itself.
// Every candidate is fetched through the polite fetcher (robots.txt, SSRF checks, limits)
// and must parse as RSS or Atom to count. At most MAX_CANDIDATES fetches per discovery.
// The result is never trusted on the user's word: the stored feed URL is the one that
// answered with a valid feed.

import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import { SourceFetchError } from "../types";
import { archiveFromPage, createPacer, discoverArchiveAt, type DiscoveredArchive, type Pacer } from "./archive-source";
import { pageTitle } from "./archive";
import { catalogLookup, type CatalogEntry } from "./catalog";
import { LIMITS, type WebFetcher } from "./fetcher";
import { parseFeed, type FeedFormat } from "./feed-parser";
import { FEED_ACCEPT } from "./feed-source";
import { BEEHIIV_ARCHIVE_PATH, beehiivFeedLinks, detectPlatform } from "./platforms";
import { checkUrl } from "./safe-fetch";

export const COMMON_FEED_PATHS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml"] as const;
export const MAX_CANDIDATES = 8;
/** Requests the archive fallback may add: the archive page and one sitemap (or a sitemap index and its child). */
export const ARCHIVE_EXTRA_FETCHES = 3;

/** "archive": a public archive page, read by the archive source (no feed). */
export type SourceFormat = FeedFormat | "archive";

const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/xml", "text/xml"]);

export interface DiscoveredFeed {
  /** The feed URL, or for format "archive" the archive page's URL. */
  feedUrl: string;
  format: SourceFormat;
  title: string;
  homepageUrl: string | null;
  itemCount: number;
  /** The newest dated item (ISO 8601), or null when no item carries a date. */
  latestIssueAt: string | null;
  catalogId: string | null;
  /** Archive only: how issues were found, and the newest few (for the preview). */
  archive?: Pick<DiscoveredArchive, "method" | "issues">;
}

export type DiscoveryResult =
  | { ok: true; feed: DiscoveredFeed }
  | {
      ok: false;
      reason: "not_found" | "invalid_input" | "no_feed";
      lastError?: string;
      /** Why the first URL tried (the one the user named, or the catalog's) failed, if it did. */
      startError?: string;
    };

/** Turns "news.example", "news.example/weekly" or a full URL into an https URL. */
export function toUrl(input: string): URL | null {
  const s = input.trim();
  if (!s || /\s/.test(s) || s.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes(".") && !u.hostname.startsWith("[")) return null;
    return u;
  } catch {
    return null;
  }
}

/** <link rel="alternate" type="application/rss+xml|atom+xml" href> in an HTML page. */
export function feedLinksInHtml(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const walk = (node: T.ParentNode) => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      if (child.tagName === "link") {
        const attr = (n: string) => child.attrs.find((a) => a.name === n)?.value?.trim() ?? "";
        const rel = attr("rel").toLowerCase().split(/\s+/);
        const type = attr("type").toLowerCase().split(";")[0].trim();
        if (rel.includes("alternate") && (type === "application/rss+xml" || type === "application/atom+xml") && attr("href")) {
          try {
            out.push(new URL(attr("href"), baseUrl).toString());
          } catch {
            /* ignore an unparseable href */
          }
        }
      }
      if ("childNodes" in child) walk(child as T.ParentNode);
      if (child.tagName === "template") walk((child as T.Template).content);
    }
  };
  walk(parse(html.slice(0, LIMITS.pageBytes)));
  return [...new Set(out)];
}

function looksLikeFeed(contentType: string | undefined, text: string): boolean {
  const type = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if (FEED_TYPES.has(type)) return true;
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 2048));
}

/** The newest of the given ISO dates, or null. */
export function latestDate(dates: readonly (string | undefined)[]): string | null {
  let best: number | null = null;
  for (const d of dates) {
    const t = d ? Date.parse(d) : NaN;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

export async function discoverFeed(
  input: string,
  fetcher: WebFetcher,
  catalog: readonly CatalogEntry[] = [],
  options: { pacer?: Pacer; archiveFallback?: boolean } = {},
): Promise<DiscoveryResult> {
  const entry = catalogLookup(catalog, input);
  const start = entry ? toUrl(entry.feedUrl ?? entry.homepageUrl) : toUrl(input);
  if (!start) return { ok: false, reason: entry ? "invalid_input" : "not_found" };
  try {
    checkUrl(start);
  } catch (err) {
    return { ok: false, reason: "invalid_input", lastError: err instanceof SourceFetchError ? err.code : undefined };
  }
  const homepage = entry ? entry.homepageUrl : null;

  const queue: string[] = [start.toString()];
  const tried = new Set<string>();
  let lastError: string | undefined;
  let pageSeen = false;
  let firstPage: { url: string; html: string } | null = null;
  let startError: string | undefined;

  while (queue.length && tried.size < MAX_CANDIDATES) {
    const candidate = queue.shift()!;
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    let res;
    try {
      res = await fetcher.get(candidate, { accept: `${FEED_ACCEPT}, text/html;q=0.5`, maxBytes: LIMITS.feedBytes });
    } catch (err) {
      lastError = err instanceof SourceFetchError ? err.code : "network_error";
      if (tried.size === 1) startError = lastError;
      // A refusal for safety reasons stops discovery outright.
      if (lastError === "blocked_address" || lastError === "blocked_host") break;
      continue;
    }
    if (res.status !== 200) {
      lastError = `http_${res.status}`;
      if (tried.size === 1) startError = lastError;
    } else if (looksLikeFeed(res.headers["content-type"], res.text)) {
      const parsed = parseFeed(res.text, res.url.toString());
      if (parsed) {
        return {
          ok: true,
          feed: {
            feedUrl: res.url.toString(),
            format: parsed.format,
            title: (parsed.title || entry?.name || res.url.hostname).slice(0, 200),
            homepageUrl: homepage ?? parsed.siteUrl ?? null,
            itemCount: parsed.items.length,
            latestIssueAt: latestDate(parsed.items.map((i) => i.published)),
            catalogId: entry?.id ?? null,
          },
        };
      }
      lastError = "not_a_feed";
    } else if (!pageSeen) {
      // The first HTML page: its advertised feeds first, then the common paths.
      pageSeen = true;
      firstPage = { url: res.url.toString(), html: res.text };
      const platformFeeds = detectPlatform(res.text, res.url.toString()) === "beehiiv" ? beehiivFeedLinks(res.text) : [];
      queue.unshift(...new Set([...feedLinksInHtml(res.text, res.url.toString()), ...platformFeeds]));
      for (const p of COMMON_FEED_PATHS) queue.push(new URL(p, res.url.origin).toString());
    } else {
      lastError = "not_a_feed";
    }
    // The first URL gave neither a feed nor a page: a catalog entry falls back to its
    // homepage; anything else tries the common paths on the same site.
    if (tried.size === 1 && !pageSeen) {
      const home = entry?.feedUrl ? toUrl(entry.homepageUrl) : null;
      if (home) queue.push(home.toString());
      else for (const p of COMMON_FEED_PATHS) queue.push(new URL(p, start.origin).toString());
    }
  }
  if (options.archiveFallback !== false && lastError !== "blocked_address" && lastError !== "blocked_host") {
    const archive = await archiveFallback(fetcher, entry, firstPage, options.pacer ?? createPacer());
    if (archive.found) {
      const a = archive.found;
      return {
        ok: true,
        feed: {
          feedUrl: a.archiveUrl,
          format: "archive",
          title: (entry?.name || a.title).slice(0, 200),
          homepageUrl: homepage ?? new URL(a.archiveUrl).origin + "/",
          itemCount: a.issueCount,
          latestIssueAt: a.latestIssueAt,
          catalogId: entry?.id ?? null,
          archive: { method: a.method, issues: a.issues },
        },
      };
    }
  }
  return { ok: false, reason: "no_feed", lastError, ...(startError ? { startError } : {}) };
}

/** No feed: the catalog's archive page, else the first HTML page seen, as a public archive. */
async function archiveFallback(
  fetcher: WebFetcher,
  entry: CatalogEntry | null,
  firstPage: { url: string; html: string } | null,
  pacer: Pacer,
): Promise<{ found: DiscoveredArchive | null; error?: string }> {
  try {
    const archiveUrl = entry?.archiveUrl ? toUrl(entry.archiveUrl) : null;
    if (archiveUrl) {
      const r = await discoverArchiveAt(fetcher, archiveUrl.toString(), pacer);
      if (r.archive || !firstPage) return { found: r.archive, error: r.error };
    }
    if (!firstPage) return { found: null };
    // A beehiiv site lists its issues at /archive; its homepage often shows only the latest.
    if (detectPlatform(firstPage.html, firstPage.url) === "beehiiv") {
      const platformArchive = new URL(BEEHIIV_ARCHIVE_PATH, firstPage.url).toString();
      if (platformArchive !== firstPage.url && platformArchive !== archiveUrl?.toString()) {
        const r = await discoverArchiveAt(fetcher, platformArchive, pacer);
        if (r.archive) return { found: r.archive };
      }
    }
    const found = await archiveFromPage(fetcher, { ...firstPage, title: pageTitle(firstPage.html) }, pacer);
    return { found };
  } catch (err) {
    return { found: null, error: err instanceof SourceFetchError ? err.code : "network_error" };
  }
}
