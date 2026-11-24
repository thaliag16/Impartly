// Source probes for the live catalog report (verify.catalog.ts): candidate public sources
// for newsletters whose catalog entry is not settled yet. Each probe prints what the
// source says it is (title, site link or platform, and the first 3 items with links and
// dates), so a reviewer can tell the newsletter's own issues from a site's other pages
// before editing the catalog. Report only: nothing is stored or changed.
//
// Politeness: every request goes through the app's polite fetcher (robots.txt, SSRF
// checks, size and time limits, Impartly user agent) and the archive pacer (at least 1 s
// between requests to a site). Link following is capped (PROBE_LIMITS), stays on the same
// site, drops query strings, and never follows sign-in, account or subscribe links. No
// page text is printed; titles are cut to 120 characters.

import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import { SourceFetchError } from "../../lib/sources/types";
import { extractIssue, isSignInUrl, issueLinksFromSitemap, normalizeUrl, pageTitle, parseSitemap, sameSite } from "../../lib/sources/web/archive";
import { archiveFromPage, createPacer, HTML_ACCEPT, webArchiveSource, type DiscoveredArchive, type Pacer } from "../../lib/sources/web/archive-source";
import { discoverFeed, type DiscoveryResult } from "../../lib/sources/web/discover";
import { createWebFetcher, LIMITS, type WebFetcher } from "../../lib/sources/web/fetcher";
import { parseFeed } from "../../lib/sources/web/feed-parser";
import { FEED_ACCEPT } from "../../lib/sources/web/feed-source";
import { BEEHIIV_ISSUE_PATH, detectPlatform } from "../../lib/sources/web/platforms";

export const PROBE_LIMITS = Object.freeze({
  /** Sitemap files read by a robots-sitemaps probe (an index and its children). */
  maxSitemaps: 4,
  /** Pages fetched while following links from the seed pages (seeds not counted). */
  maxFollowedPages: 6,
  /** Candidate links listed per probe. */
  maxListedLinks: 12,
  intervalMs: 1000,
});

/** Links worth following when looking for a newsletter's public web edition or archive. */
const EDITION_HINT = /\b(?:daily|issues?|archives?|newsletters?|editions?|read (?:it )?online|web version|view (?:it )?(?:online|in (?:your )?browser)|past issues|back issues|latest issue)\b/i;

export interface ProbeTarget {
  entry: string;
  kind: "discover" | "archive" | "sitemap" | "follow" | "issue" | "robots-sitemaps";
  /** robots-sitemaps only: the path prefix whose entries are counted (e.g. "/issues/"). */
  pathPrefix?: string;
  url: string;
  /** follow only: pages to start from. */
  seeds?: string[];
}

/** The candidates Thalia gave (run 16). Clean URLs only: never tracking parameters. */
export const PROBES: ProbeTarget[] = [
  { entry: "strictlyvc", kind: "discover", url: "https://newsletter.strictlyvc.com/" },
  { entry: "strictlyvc", kind: "archive", url: "https://newsletter.strictlyvc.com/archive" },
  { entry: "strictlyvc", kind: "sitemap", url: "https://newsletter.strictlyvc.com/sitemap.xml" },
  { entry: "morning-brew", kind: "follow", url: "https://www.morningbrew.com/subscribe", seeds: ["https://www.morningbrew.com/subscribe", "https://www.morningbrew.com/"] },
  // Found by the follow probe in Catalog check run 45337117393 (the homepage's "Latest
  // Newsletter" and "Newsletter" links): the daily email's web edition, one page per issue.
  { entry: "morning-brew", kind: "issue", url: "https://www.morningbrew.com/issues/latest" },
  { entry: "morning-brew", kind: "robots-sitemaps", url: "https://www.morningbrew.com/", pathPrefix: "/issues/" },
];

/** Table-safe, short: no pipes or line breaks, at most 120 characters. */
export function cell(s: string | null | undefined): string {
  return (s ?? "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

const code = (e: unknown) => (e instanceof SourceFetchError ? e.code : "error");
type Item = { title: string; url: string; date: string | null };

function rows(entry: string, probe: string, url: string, result: string, title: string, site: string, items: Item[]): string[] {
  const head = `| ${entry} | ${probe} | ${cell(url)} | ${cell(result)} | ${cell(title)} | ${cell(site)} |`;
  if (!items.length) return [`${head} | | | |`];
  return items.slice(0, 3).map((it, i) => (i === 0 ? head : "| | | | | | |") + ` ${i + 1} | ${cell(it.title)} | ${cell(it.url)} | ${cell(it.date)} |`);
}

function archiveItems(a: DiscoveredArchive): Item[] {
  return a.issues.map((i) => ({ title: i.title, url: i.url, date: i.publishedAt }));
}

/** The newest issue the archive source would read: its title, length and partial flag. */
async function sampleIssue(fetcher: WebFetcher, pacer: Pacer, a: DiscoveredArchive): Promise<string> {
  try {
    const source = webArchiveSource({ id: "probe", archiveUrl: a.archiveUrl, title: a.title, etag: null, lastModified: null, knownUrls: [] }, fetcher, { pacer });
    const pulled = await source.pull({ since: new Date(Date.now() - 365 * 24 * 3600 * 1000), limit: 1, maxChars: 20_000, firstPull: true });
    const item = pulled.items[0];
    return item ? `sample issue read: "${cell(item.subject).slice(0, 60)}", ${item.bodyText.length} chars, partial ${item.partial ? "yes" : "no"}` : "sample issue: none read";
  } catch (e) {
    return `sample issue: ${code(e)}`;
  }
}

function stripQuery(u: string): string {
  try {
    const url = new URL(u);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

async function getPage(fetcher: WebFetcher, pacer: Pacer, url: string) {
  await pacer.wait(new URL(url).hostname, PROBE_LIMITS.intervalMs);
  return fetcher.get(url, { accept: HTML_ACCEPT, maxBytes: LIMITS.pageBytes });
}

/** Same-site links on a page whose path or text hints at a web edition or archive. */
export function editionLinks(html: string, pageUrl: string): { url: string; text: string }[] {
  const out = new Map<string, string>();
  const walk = (node: T.ParentNode) => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      if (child.tagName === "a") {
        const href = child.attrs.find((a) => a.name === "href")?.value ?? "";
        const url = normalizeUrl(href, pageUrl);
        const text = textOf(child).trim();
        if (url && sameSite(url, pageUrl) && !isSignInUrl(url)) {
          const clean = new URL(url);
          clean.search = "";
          const key = clean.toString();
          if (key !== normalizeUrl(pageUrl) && (EDITION_HINT.test(clean.pathname.replace(/[-_/]/g, " ")) || EDITION_HINT.test(text)) && !out.has(key)) out.set(key, text);
        }
      }
      if ("childNodes" in child) walk(child as T.ParentNode);
    }
  };
  walk(parse(html.slice(0, LIMITS.pageBytes)));
  return [...out].map(([url, text]) => ({ url, text }));
}

function textOf(node: T.Node): string {
  if (node.nodeName === "#text") return (node as T.TextNode).value;
  if (!("childNodes" in node)) return "";
  return (node as T.ParentNode).childNodes.map(textOf).join(" ");
}

export async function runProbe(p: ProbeTarget): Promise<string[]> {
  const fetcher = createWebFetcher();
  const pacer = createPacer();
  try {
    if (p.kind === "discover") {
      let platform = "";
      try {
        const home = await getPage(fetcher, pacer, p.url);
        platform = home.status === 200 ? `platform: ${detectPlatform(home.text, home.url.toString()) ?? "not detected"}` : `homepage http_${home.status}`;
      } catch (e) {
        platform = `homepage ${code(e)}`;
      }
      const r = await discoverFeed(p.url, fetcher, [], { pacer });
      if (!r.ok) {
        const failed = r as Extract<DiscoveryResult, { ok: false }>;
        return rows(p.entry, "discover", p.url, `no source (${failed.reason}${failed.lastError ? `, ${failed.lastError}` : ""})`, "", platform, []);
      }
      if (r.feed.format === "archive" && r.feed.archive) {
        const a = { archiveUrl: r.feed.feedUrl, title: r.feed.title, method: r.feed.archive.method, issueCount: r.feed.itemCount, latestIssueAt: r.feed.latestIssueAt, issues: r.feed.archive.issues };
        return rows(p.entry, "discover", p.url, `archive at ${r.feed.feedUrl} (${r.feed.archive.method}, ${r.feed.itemCount} issues)`, r.feed.title, platform, archiveItems(a));
      }
      const res = await fetcher.get(r.feed.feedUrl, { accept: FEED_ACCEPT, maxBytes: LIMITS.feedBytes });
      const parsed = res.status === 200 ? parseFeed(res.text, res.url.toString()) : null;
      const items = (parsed?.items ?? []).map((i) => ({ title: i.title, url: i.link ?? "", date: i.published ?? null }));
      return rows(p.entry, "discover", p.url, `${r.feed.format} feed at ${r.feed.feedUrl} (${r.feed.itemCount} items)`, parsed?.title ?? r.feed.title, `${parsed?.siteUrl ?? ""} ${platform}`, items);
    }
    if (p.kind === "archive") {
      const page = await getPage(fetcher, pacer, p.url);
      if (page.status !== 200) return rows(p.entry, "archive", p.url, `http_${page.status}`, "", "", []);
      const platform = `platform: ${detectPlatform(page.text, page.url.toString()) ?? "not detected"}`;
      const a = await archiveFromPage(fetcher, { url: page.url.toString(), html: page.text, title: pageTitle(page.text) }, pacer);
      if (!a) return rows(p.entry, "archive", p.url, "no issue links found", pageTitle(page.text), platform, []);
      const sample = await sampleIssue(fetcher, pacer, a);
      return [
        ...rows(p.entry, "archive", p.url, `archive (${a.method}, ${a.issueCount} issues, newest ${a.latestIssueAt ?? "undated"})`, a.title, platform, archiveItems(a)),
        ...rows(p.entry, "sample issue", a.archiveUrl, sample, "", "", []),
      ];
    }
    if (p.kind === "issue") {
      const page = await getPage(fetcher, pacer, p.url);
      if (page.status !== 200) return rows(p.entry, "issue page", p.url, `http_${page.status}`, "", "", []);
      const issue = extractIssue(page.text, page.url.toString(), { maxChars: 20_000 });
      const canonical = new URL(issue.canonicalUrl);
      canonical.search = "";
      return rows(
        p.entry,
        "issue page",
        p.url,
        `final URL ${cell(stripQuery(page.url.toString()))}; ${issue.text.length} chars, partial ${issue.partial ? "yes" : "no"}`,
        issue.title,
        `platform: ${detectPlatform(page.text, page.url.toString()) ?? "not detected"}`,
        [{ title: issue.title, url: canonical.toString(), date: issue.published }],
      );
    }
    if (p.kind === "robots-sitemaps") {
      const info = (await fetcher.siteInfo?.(p.url)) ?? { crawlDelaySeconds: null, sitemaps: [] };
      const out = rows(p.entry, "robots sitemaps", p.url, `${info.sitemaps.length} sitemaps advertised${info.crawlDelaySeconds !== null ? `, Crawl-delay ${info.crawlDelaySeconds}` : ""}`, "", "", []);
      const prefix = p.pathPrefix ?? "/";
      // Advertised sitemaps first, then the children of any index, until maxSitemaps.
      const queue = info.sitemaps.map((u) => normalizeUrl(u)).filter((u): u is string => !!u && sameSite(u, p.url));
      let read = 0;
      while (queue.length && read < PROBE_LIMITS.maxSitemaps) {
        const url = queue.shift()!;
        read++;
        try {
          await pacer.wait(new URL(url).hostname, PROBE_LIMITS.intervalMs);
          const res = await fetcher.get(url, { accept: "application/xml, text/xml;q=0.9, */*;q=0.1", maxBytes: LIMITS.feedBytes });
          if (res.status !== 200) {
            out.push(...rows(p.entry, "sitemap", url, `http_${res.status}`, "", "", []));
            continue;
          }
          const sm = parseSitemap(res.text);
          if (sm.kind === "index") {
            const children = sm.entries.map((e) => normalizeUrl(e.url)).filter((u): u is string => !!u && sameSite(u, p.url));
            // Children that look like they hold the prefix's pages go to the front.
            const word = prefix.replace(/\W+/g, "");
            children.sort((a, b) => Number(!!word && b.includes(word)) - Number(!!word && a.includes(word)));
            queue.unshift(...children);
            out.push(...rows(p.entry, "sitemap index", url, `${sm.entries.length} sitemaps`, "", "", children.map((c) => ({ title: "(sitemap)", url: c, date: null }))));
            continue;
          }
          const matching = sm.entries
            .filter((e) => {
              try {
                return new URL(e.url).pathname.startsWith(prefix);
              } catch {
                return false;
              }
            })
            .sort((a, b) => (b.published ? Date.parse(b.published) : -Infinity) - (a.published ? Date.parse(a.published) : -Infinity));
          out.push(
            ...rows(p.entry, "sitemap", url, `${sm.kind ? `${sm.entries.length} URLs, ${matching.length} under ${prefix}` : "not a sitemap"}`, "", "", matching.map((e) => ({ title: e.title || "(no title in sitemap)", url: stripQuery(e.url), date: e.published }))),
          );
        } catch (e) {
          out.push(...rows(p.entry, "sitemap", url, code(e), "", "", []));
        }
      }
      return out;
    }
    if (p.kind === "sitemap") {
      await pacer.wait(new URL(p.url).hostname, PROBE_LIMITS.intervalMs);
      const res = await fetcher.get(p.url, { accept: "application/xml, text/xml;q=0.9, */*;q=0.1", maxBytes: LIMITS.pageBytes });
      if (res.status !== 200) return rows(p.entry, "sitemap", p.url, `http_${res.status}`, "", "", []);
      const sm = parseSitemap(res.text);
      if (sm.kind === "index") {
        return rows(p.entry, "sitemap", p.url, `sitemap index, ${sm.entries.length} sitemaps (not followed)`, "", "", sm.entries.map((e) => ({ title: "(sitemap)", url: e.url, date: e.published })));
      }
      const links = sm.kind ? issueLinksFromSitemap(sm, new URL("/archive", p.url).toString(), { issuePath: BEEHIIV_ISSUE_PATH }) : [];
      return rows(p.entry, "sitemap", p.url, sm.kind ? `${sm.entries.length} URLs, ${links.length} shaped like /p/<slug> issues (newest first)` : "not a sitemap", "", "", links.map((l) => ({ title: l.title || "(no title in sitemap)", url: l.url, date: l.published })));
    }
    // follow: read the seed pages, list the links that hint at a web edition or archive,
    // then check up to maxFollowedPages of them (and links found on those) as archives.
    const out: string[] = [];
    const queue: string[] = [];
    const seen = new Set<string>();
    for (const seed of p.seeds ?? [p.url]) {
      seen.add(normalizeUrl(seed) ?? seed);
      try {
        const page = await getPage(fetcher, pacer, seed);
        const links = page.status === 200 ? editionLinks(page.text, page.url.toString()) : [];
        out.push(
          ...rows(p.entry, "seed page", seed, page.status === 200 ? `${links.length} edition/archive-like links` : `http_${page.status}`, pageTitle(page.text), page.status === 200 ? `platform: ${detectPlatform(page.text, page.url.toString()) ?? "not detected"}` : "", []),
        );
        for (const l of links.slice(0, PROBE_LIMITS.maxListedLinks)) out.push(`| ${p.entry} | link on seed | ${cell(l.url)} | ${cell(l.text) || "(no text)"} | | | | | | |`);
        queue.push(...links.map((l) => l.url));
      } catch (e) {
        out.push(...rows(p.entry, "seed page", seed, code(e), "", "", []));
      }
    }
    let followed = 0;
    while (queue.length && followed < PROBE_LIMITS.maxFollowedPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      followed++;
      try {
        const page = await getPage(fetcher, pacer, url);
        if (page.status !== 200) {
          out.push(...rows(p.entry, "followed", url, `http_${page.status}`, "", "", []));
          continue;
        }
        const a = await archiveFromPage(fetcher, { url: page.url.toString(), html: page.text, title: pageTitle(page.text) }, pacer);
        const more = editionLinks(page.text, page.url.toString()).map((l) => l.url).filter((u) => !seen.has(u));
        queue.push(...more);
        out.push(
          ...rows(p.entry, "followed", url, a ? `archive-like (${a.method}, ${a.issueCount} links, newest ${a.latestIssueAt ?? "undated"}); ${more.length} more candidate links` : `no issue links; ${more.length} more candidate links`, pageTitle(page.text), `platform: ${detectPlatform(page.text, page.url.toString()) ?? "not detected"}`, a ? archiveItems(a) : []),
        );
      } catch (e) {
        out.push(...rows(p.entry, "followed", url, code(e), "", "", []));
      }
    }
    if (queue.some((u) => !seen.has(u))) out.push(`| ${p.entry} | (cap) | | stopped after ${PROBE_LIMITS.maxFollowedPages} followed pages | | | | | | |`);
    return out;
  } catch (e) {
    return rows(p.entry, p.kind, p.url, code(e), "", "", []);
  }
}
