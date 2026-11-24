// A newsletter's public web archive as a NewsletterSource: the fallback for newsletters
// that publish no RSS or Atom feed. Parsing lives in archive.ts; this file fetches.
//
// One pull:
//   1. robots.txt (through the fetcher, once per site per run): every URL is checked
//      against it, and its Crawl-delay is honoured. A Crawl-delay over
//      ARCHIVE_LIMITS.maxCrawlDelaySeconds skips the site ("crawl_delay_too_long") rather
//      than crawl it faster than it asks.
//   2. the archive page (conditional GET; a 304 reads nothing), then issue links by the
//      most structured method that finds any (archive.ts). When the page gives only
//      heuristic links or none, a sitemap the site advertises in robots.txt is tried.
//      rel="next" pages are followed only while every link so far is new, at most
//      ARCHIVE_LIMITS.maxIndexPages pages in all, never the same page twice and never to
//      another site (pagination loops and traps end there).
//   3. new issues only: links already stored for this archive are skipped. When the
//      listing has dates, anything before `since` is skipped. When it has none, the
//      listing is read newest first and stops at the first stored link or the first page
//      dated before `since`; a first pull takes only the newest issue.
//   4. at most ARCHIVE_LIMITS.maxIssuesPerRun issue pages per site per run, each through
//      the polite fetcher, and every request to the site spaced at least
//      ARCHIVE_LIMITS.minIntervalMs apart (or the Crawl-delay, if longer).
//   5. each page's main text goes through the shared hidden-text-stripping HTML-to-text
//      step; items are keyed by canonical URL, so the same issue under two links is
//      stored once.
// Never: cookies, sign-ins, a headless browser, or another site. A redirect to a sign-in,
// subscribe or account page, or to another site, is refused at that hop and the issue is
// skipped. 401, 402, 403 and 451 are skipped as they are. Paywalled or teaser pages are
// stored `partial` with only their public text.

import { SourceFetchError, type NewsletterSource, type PullResult, type SourceItem } from "../types";
import { extractIssue, isSignInUrl, pageTitle, issueLinksFromIndex, issueLinksFromSitemap, normalizeUrl, parseSitemap, sameSite, type IssueLink, type LinkMethod } from "./archive";
import { LIMITS, type FetchedText, type WebFetcher } from "./fetcher";

export const HTML_ACCEPT = "text/html, application/xhtml+xml;q=0.9, */*;q=0.1";
const SITEMAP_ACCEPT = "application/xml, text/xml;q=0.9, */*;q=0.1";

export const ARCHIVE_LIMITS = Object.freeze({
  /** Issue pages fetched per site per run. */
  maxIssuesPerRun: 5,
  /** Archive pages read per run: the archive page and at most two rel="next" pages. */
  maxIndexPages: 3,
  /** Sitemap files read per run (a sitemap index and one of its sitemaps). */
  maxSitemaps: 2,
  /** At most one request per second to a site. */
  minIntervalMs: 1000,
  /** A site asking for more than this between requests is skipped, not crawled faster. */
  maxCrawlDelaySeconds: 30,
  /** Issues listed in a discovery preview. */
  previewIssues: 5,
});

/** Spaces requests to each host. One per pipeline run (or discovery), shared by its sources. */
export interface Pacer {
  wait(host: string, intervalMs: number): Promise<void>;
}

export function createPacer(
  clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Pacer {
  const now = clock.now ?? (() => Date.now());
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const last = new Map<string, number>();
  return {
    async wait(host, intervalMs) {
      const key = host.toLowerCase().replace(/^www\./, "");
      const prev = last.get(key);
      if (prev !== undefined) {
        const wait = prev + intervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      last.set(key, now());
    },
  };
}

export interface StoredArchive {
  id: string;
  /** The archive (index) page. */
  archiveUrl: string;
  title: string | null;
  etag: string | null;
  lastModified: string | null;
  /** URLs of issues already stored for this archive (item keys and links), newest first. */
  knownUrls: readonly string[];
}

const isHtml = (res: FetchedText) => {
  const type = (res.headers["content-type"] ?? "").toLowerCase().split(";")[0].trim();
  if (type) return type === "text/html" || type === "application/xhtml+xml";
  return /^\s*</.test(res.text.slice(0, 512));
};

/** Refuses a hop to another site or to a sign-in/subscribe/account page. */
export function archiveHopGuard(siteUrl: string) {
  return (u: URL): string | null => {
    if (!sameSite(u, siteUrl)) return "off_site";
    if (isSignInUrl(u)) return "sign_in_page";
    return null;
  };
}

/** The request spacing for a site: robots.txt Crawl-delay if longer than the default. */
export async function siteInterval(fetcher: WebFetcher, url: string, pacer: Pacer): Promise<{ intervalMs: number; sitemaps: string[] }> {
  const info = (await fetcher.siteInfo?.(url)) ?? { crawlDelaySeconds: null, sitemaps: [] };
  const delay = info.crawlDelaySeconds;
  if (delay !== null && delay > ARCHIVE_LIMITS.maxCrawlDelaySeconds) throw new SourceFetchError("crawl_delay_too_long");
  const intervalMs = Math.max(ARCHIVE_LIMITS.minIntervalMs, Math.ceil((delay ?? 0) * 1000));
  // robots.txt was just read (or earlier in this run): count it as a request to the site.
  await pacer.wait(new URL(url).hostname, intervalMs);
  return { intervalMs, sitemaps: info.sitemaps };
}

interface Ctx {
  fetcher: WebFetcher;
  pacer: Pacer;
  intervalMs: number;
  siteUrl: string;
}

async function politeGet(ctx: Ctx, url: string, accept: string, extra: { etag?: string | null; lastModified?: string | null } = {}) {
  await ctx.pacer.wait(new URL(url).hostname, ctx.intervalMs);
  return ctx.fetcher.get(url, { accept, maxBytes: LIMITS.pageBytes, refuseHop: archiveHopGuard(ctx.siteUrl), ...extra });
}

/** Issue links from the site's advertised sitemaps (same site only, at most maxSitemaps files). */
async function linksFromSitemaps(ctx: Ctx, sitemaps: string[], archiveUrl: string): Promise<IssueLink[]> {
  const candidates = sitemaps
    .map((s) => normalizeUrl(s))
    .filter((s): s is string => !!s && sameSite(s, archiveUrl))
    .sort((a, b) => Number(/news|post|issue|newsletter|article/i.test(b)) - Number(/news|post|issue|newsletter|article/i.test(a)));
  let fetched = 0;
  const queue = candidates.slice(0, 1);
  const seen = new Set<string>();
  while (queue.length && fetched < ARCHIVE_LIMITS.maxSitemaps) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    fetched++;
    let res: FetchedText;
    try {
      res = await politeGet(ctx, url, SITEMAP_ACCEPT);
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const parsed = parseSitemap(res.text);
    if (parsed.kind === "index") {
      // Follow one child: a news/post-like one if any, same site only.
      const child = parsed.entries
        .map((e) => normalizeUrl(e.url))
        .filter((u): u is string => !!u && sameSite(u, archiveUrl))
        .sort((a, b) => Number(/news|post|issue|newsletter|article/i.test(b)) - Number(/news|post|issue|newsletter|article/i.test(a)))[0];
      if (child) queue.push(child);
      continue;
    }
    const links = issueLinksFromSitemap(parsed, archiveUrl);
    if (links.length) return links;
  }
  return [];
}

export interface FoundIssues {
  links: IssueLink[];
  method: LinkMethod | null;
  next: string | null;
}

/** Issue links for an archive page already fetched: the page's own, else the advertised sitemap's. */
export async function findIssueLinks(ctx: Ctx, html: string, pageUrl: string, sitemaps: string[]): Promise<FoundIssues> {
  const idx = issueLinksFromIndex(html, pageUrl);
  if (idx.method === "jsonld" || idx.method === "article") return idx;
  if (sitemaps.length) {
    const fromSitemap = await linksFromSitemaps(ctx, sitemaps, pageUrl);
    if (fromSitemap.length) return { links: fromSitemap, method: "sitemap", next: null };
  }
  return idx;
}

/** Enough to call it an archive: one structured link, or two heuristic ones. */
export function looksLikeArchive(found: FoundIssues): boolean {
  if (!found.method) return false;
  return found.method === "heuristic" ? found.links.length >= 2 : found.links.length >= 1;
}

const keyFor = (canonicalUrl: string) => `url:${canonicalUrl}`;

export function webArchiveSource(
  archive: StoredArchive,
  fetcher: WebFetcher,
  options: { pacer?: Pacer; now?: () => Date } = {},
): NewsletterSource {
  const pacer = options.pacer ?? createPacer();
  const now = options.now ?? (() => new Date());
  return {
    kind: "web",
    id: archive.id,
    async pull({ since, limit, maxChars, firstPull }): Promise<PullResult> {
      const { intervalMs, sitemaps } = await siteInterval(fetcher, archive.archiveUrl, pacer);
      const ctx: Ctx = { fetcher, pacer, intervalMs, siteUrl: archive.archiveUrl };

      const res = await politeGet(ctx, archive.archiveUrl, HTML_ACCEPT, { etag: archive.etag, lastModified: archive.lastModified });
      if (res.status === 304) {
        return { items: [], listed: 0, capped: false, cache: { etag: archive.etag, lastModified: archive.lastModified, notModified: true } };
      }
      if (res.status !== 200) throw new SourceFetchError(`http_${res.status}`);
      if (!isHtml(res)) throw new SourceFetchError("not_html");

      const known = new Set<string>();
      for (const k of archive.knownUrls) {
        const n = normalizeUrl(k.replace(/^url:/, ""));
        if (n) known.add(n);
      }
      const found = await findIssueLinks(ctx, res.text, res.url.toString(), sitemaps);
      const links = [...found.links];
      const cap = Math.max(0, Math.min(limit, ARCHIVE_LIMITS.maxIssuesPerRun));

      // Older index pages, only while everything listed so far is new.
      const visited = new Set([normalizeUrl(archive.archiveUrl), normalizeUrl(res.url.toString())]);
      let next = found.method === "sitemap" ? null : found.next;
      let indexPages = 1;
      while (
        next &&
        !firstPull &&
        indexPages < ARCHIVE_LIMITS.maxIndexPages &&
        !visited.has(next) &&
        links.length < cap &&
        !links.some((l) => known.has(l.url))
      ) {
        visited.add(next);
        indexPages++;
        let page: FetchedText;
        try {
          page = await politeGet(ctx, next, HTML_ACCEPT);
        } catch {
          break;
        }
        if (page.status !== 200 || !isHtml(page)) break;
        const more = issueLinksFromIndex(page.text, page.url.toString());
        const fresh = more.links.filter((l) => !links.some((x) => x.url === l.url));
        if (!fresh.length) break; // a loop or a trap: nothing new
        links.push(...fresh);
        next = more.next;
      }

      // Newest first: by date when the listing has dates, else in listing order.
      const dated = links.some((l) => l.published);
      const ordered = dated
        ? links
            .map((l, i) => ({ l, i }))
            .sort((a, b) => (b.l.published ? Date.parse(b.l.published) : -Infinity) - (a.l.published ? Date.parse(a.l.published) : -Infinity) || a.i - b.i)
            .map((x) => x.l)
        : links;

      const selected: IssueLink[] = [];
      let capped = false;
      let undatedTaken = 0;
      for (const l of ordered) {
        if (known.has(l.url)) {
          if (!dated) break; // undated listing: everything after a stored issue is older
          continue;
        }
        if (l.published && Date.parse(l.published) < since.getTime()) {
          if (dated) continue;
        }
        if (!l.published) {
          if (firstPull && undatedTaken >= 1) continue;
          undatedTaken++;
        }
        if (selected.length >= cap) {
          capped = true;
          break;
        }
        selected.push(l);
      }

      const senderAddress = new URL(archive.archiveUrl).hostname.toLowerCase().replace(/^www\./, "");
      const senderName = (archive.title || senderAddress).slice(0, 200);
      const fetchedAt = now().toISOString();
      const items: SourceItem[] = [];
      const canonicals = new Set<string>();
      for (const link of selected) {
        let page: FetchedText;
        try {
          page = await politeGet(ctx, link.url, HTML_ACCEPT);
        } catch (err) {
          // robots.txt, a sign-in redirect, another site, a timeout: skip this issue only.
          if (err instanceof SourceFetchError) continue;
          throw err;
        }
        if (page.status !== 200 || !isHtml(page)) continue; // 401/402/403/451 included: never worked around
        const issue = extractIssue(page.text, page.url.toString(), { maxChars });
        const published = issue.published ?? link.published;
        if (published && Date.parse(published) < since.getTime()) {
          if (!dated) break; // undated listing, older page: the rest are older still
          continue;
        }
        if (!issue.text) continue;
        if (canonicals.has(issue.canonicalUrl) || known.has(issue.canonicalUrl)) continue;
        canonicals.add(issue.canonicalUrl);
        items.push({
          key: keyFor(issue.canonicalUrl),
          senderAddress,
          senderName,
          subject: (issue.title || link.title || senderName).slice(0, 500),
          receivedAt: published ?? fetchedAt,
          bodyText: issue.text,
          truncated: issue.truncated,
          partial: issue.partial,
          url: link.url,
        });
      }

      return {
        items,
        listed: links.length,
        capped,
        cache: {
          etag: res.headers["etag"]?.slice(0, 512) ?? null,
          lastModified: res.headers["last-modified"]?.slice(0, 100) ?? null,
          notModified: false,
        },
      };
    },
  };
}

export interface DiscoveredArchive {
  archiveUrl: string;
  title: string;
  method: LinkMethod;
  issueCount: number;
  latestIssueAt: string | null;
  issues: { title: string; url: string; publishedAt: string | null }[];
}

/**
 * Whether a page (already fetched as `html`) is a usable public archive: its issue links,
 * by the same rules the source uses, at most one sitemap request more. Used by discovery
 * when a site has no feed. Stores nothing.
 */
export async function archiveFromPage(
  fetcher: WebFetcher,
  page: { url: string; html: string; title?: string },
  pacer: Pacer = createPacer(),
): Promise<DiscoveredArchive | null> {
  const { intervalMs, sitemaps } = await siteInterval(fetcher, page.url, pacer);
  const ctx: Ctx = { fetcher, pacer, intervalMs, siteUrl: page.url };
  const found = await findIssueLinks(ctx, page.html, page.url, sitemaps);
  if (!looksLikeArchive(found)) return null;
  const dates = found.links.map((l) => l.published).filter((d): d is string => !!d);
  const latest = dates.length ? new Date(Math.max(...dates.map((d) => Date.parse(d)))).toISOString() : null;
  return {
    archiveUrl: normalizeUrl(page.url) ?? page.url,
    title: (page.title || new URL(page.url).hostname.replace(/^www\./, "")).slice(0, 200),
    method: found.method!,
    issueCount: found.links.length,
    latestIssueAt: latest,
    issues: found.links.slice(0, ARCHIVE_LIMITS.previewIssues).map((l) => ({ title: l.title || l.url, url: l.url, publishedAt: l.published })),
  };
}

/** Fetches a page (politely) and checks it as an archive. */
export async function discoverArchiveAt(fetcher: WebFetcher, url: string, pacer: Pacer = createPacer()): Promise<{ archive: DiscoveredArchive | null; error?: string }> {
  let intervalMs: number;
  try {
    intervalMs = (await siteInterval(fetcher, url, pacer)).intervalMs;
  } catch (err) {
    return { archive: null, error: err instanceof SourceFetchError ? err.code : "network_error" };
  }
  let res: FetchedText;
  try {
    res = await politeGet({ fetcher, pacer, intervalMs, siteUrl: url }, url, HTML_ACCEPT);
  } catch (err) {
    return { archive: null, error: err instanceof SourceFetchError ? err.code : "network_error" };
  }
  if (res.status !== 200) return { archive: null, error: `http_${res.status}` };
  if (!isHtml(res)) return { archive: null, error: "not_html" };
  const archive = await archiveFromPage(fetcher, { url: res.url.toString(), html: res.text, title: pageTitle(res.text) }, pacer);
  return archive ? { archive } : { archive: null, error: "no_archive" };
}
