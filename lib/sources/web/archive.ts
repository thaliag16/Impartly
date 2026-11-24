// Public web archives: reading a newsletter that publishes no feed from its public archive
// (index) page. This file is the parsing half (no network); archive-source.ts does the
// fetching under the polite rules.
//
// Finding issue links on an archive page, most structured first:
//   1. JSON-LD in the page (schema.org ItemList, Blog/blogPost, CollectionPage/hasPart, or
//      any Article/BlogPosting/NewsArticle node with a url)
//   2. a sitemap the site advertises in robots.txt (news sitemaps, or URLs under the
//      archive's own path), parsed by parseSitemap; archive-source.ts decides when
//   3. <article> elements, each with its first link (a heading link if there is one) and
//      its <time datetime>
//   4. conservative same-site link heuristics: visible links outside nav, header, footer,
//      aside and forms, under the archive's own path or shaped like an issue (/p/...,
//      /2026/11/..., /issues/..., /newsletter/...), never sign-in, subscribe, account,
//      tag, category, author, search or pagination pages
// Links to other sites are never returned, whatever the method. Links inside hidden
// elements are ignored (hidden links are a common crawler trap).
//
// Reading one issue page: the main content is chosen readability-style (itemprop
// articleBody, else the <article> with the most paragraph text, else <main>, else the
// block with the most paragraph text, counting each <p> in full for its parent block and
// half for the block above it, so a post body that wraps every paragraph in its own <div>,
// as beehiiv does, is read whole) and turned into text by the shared HTML-to-text
// step, so the hidden-text rules (lib/text/html-to-text.ts) apply exactly as for feeds and
// mail. Share bars, comments, related-post lists, sign-up boxes, nav, header, footer,
// aside and forms inside it are left out.
//
// Paywalls: a page is `partial` when it says so in structured data (isAccessibleForFree
// false, the Google paywall markup), carries a locked/metered content tier, shows a
// paywall notice, ends in "Read more" / "…", or is under PARTIAL_MAX_CHARS characters.
// Only what the public page shows is read; nothing is done to get past it.

import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import { SaxesParser } from "saxes";
import { documentHidingRules, htmlToText, isHiddenElement, plainTextToText, type HidingRule } from "../../text/html-to-text";
import { PAYWALL, TRUNCATED_END } from "./feed-source";

/** Below this many characters of article text, a page counts as a teaser (partial). */
export const PARTIAL_MAX_CHARS = 500;
/** Most issue links taken from one index page or sitemap. */
export const MAX_LINKS_PER_PAGE = 100;
const MAX_JSONLD_BYTES = 512 * 1024;
const MAX_JSONLD_NODES = 5000;

export type LinkMethod = "jsonld" | "sitemap" | "article" | "heuristic";

export interface IssueLink {
  /** Normalized absolute URL (same site as the archive page). */
  url: string;
  title: string;
  /** ISO 8601, or null when the listing gives no date. */
  published: string | null;
}

export interface IndexLinks {
  links: IssueLink[];
  method: LinkMethod | null;
  /** The next index page (rel="next"), same site only, or null. */
  next: string | null;
}

export interface IssuePage {
  /** <link rel="canonical"> if it is on the same site, else the fetched URL; normalized. */
  canonicalUrl: string;
  title: string;
  published: string | null;
  text: string;
  truncated: boolean;
  partial: boolean;
}

// ---- URLs -------------------------------------------------------------------------------

const TRACKING_PARAM = /^(?:utm_[a-z]+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|s|r|source|publication_id|post_id|isFreemail|triedRedirect)$/i;

/** Absolute http(s) URL without fragment, tracking parameters or a trailing slash; null if unusable. */
export function normalizeUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

const siteOf = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** Same site: the same host, ignoring a leading "www.". Subdomains are other sites. */
export function sameSite(a: string | URL, b: string | URL): boolean {
  try {
    return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** Pages that ask for an account or payment. Never fetched, never followed. */
const SIGN_IN_PATH =
  /(?:^|\/)(?:login|log-in|logout|signin|sign-in|sign_in|signup|sign-up|sign_up|register|registration|subscribe|subscription|subscriptions|account|accounts|my-account|profile|auth|oauth|sso|session|sessions|paywall|checkout|cart|billing|membership|members|join|upgrade|pricing|plans|portal|wp-login\.php|wp-admin)(?:\/|$|\.)/i;

export function isSignInUrl(url: string | URL): boolean {
  try {
    const u = new URL(url);
    return SIGN_IN_PATH.test(u.pathname);
  } catch {
    return true;
  }
}

/** Never issues: listing, taxonomy, search, feed and static-file pages. */
const NOT_AN_ISSUE_PATH =
  /(?:^|\/)(?:tag|tags|category|categories|topic|topics|author|authors|people|search|feed|rss|atom|comments|about|contact|privacy|terms|legal|cookies|careers|jobs|advertise|sponsor|sponsors|press|faq|help|support|archive|archives|page|recommendations|leaderboard|podcast|podcasts|events|shop|store|cdn-cgi)(?:\/|$)/i;
const STATIC_FILE = /\.(?:xml|json|rss|atom|txt|pdf|zip|gz|jpe?g|png|gif|webp|svg|ico|css|js|mp3|mp4|m4a|mov|woff2?)$/i;
/** Paths shaped like a newsletter issue or post. */
const ISSUE_SHAPED = /^\/(?:p|post|posts|issue|issues|newsletter|newsletters|edition|editions|letter|letters|essay|essays|article|articles|blog|news|briefing|briefings)\/[^/]+|^\/\d{4}\/\d{1,2}(?:\/\d{1,2})?\/[^/]+/i;

function candidateAllowed(url: string, archiveUrl: string): boolean {
  if (!sameSite(url, archiveUrl)) return false;
  const u = new URL(url);
  const a = new URL(archiveUrl);
  if (u.pathname === "/" || u.pathname === a.pathname.replace(/\/+$/, "") || u.pathname === a.pathname) return false;
  if (isSignInUrl(u)) return false;
  if (STATIC_FILE.test(u.pathname)) return false;
  return true;
}

/** Stricter, for the link heuristic: also not a taxonomy page, and under the archive's path or issue-shaped. */
function heuristicAllowed(url: string, archiveUrl: string): boolean {
  if (!candidateAllowed(url, archiveUrl)) return false;
  const u = new URL(url);
  const base = new URL(archiveUrl).pathname.replace(/\/+$/, "");
  const underArchive = base !== "" && u.pathname.startsWith(`${base}/`) && u.pathname.length > base.length + 1;
  if (u.search && !underArchive) return false;
  const rest = underArchive ? u.pathname.slice(base.length) : u.pathname;
  if (NOT_AN_ISSUE_PATH.test(rest)) return false;
  return underArchive || ISSUE_SHAPED.test(u.pathname);
}

// ---- HTML helpers -----------------------------------------------------------------------

const attrOf = (el: T.Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const isEl = (n: T.Node): n is T.Element => "tagName" in n;

function* elements(node: T.ParentNode): Generator<T.Element> {
  for (const child of node.childNodes) {
    if (!isEl(child)) continue;
    yield child;
    if (child.tagName === "template") continue;
    yield* elements(child);
  }
}

function rawText(node: T.Node): string {
  if (node.nodeName === "#text") return (node as T.TextNode).value;
  if (!isEl(node) || ["script", "style", "template", "noscript"].includes(node.tagName)) return "";
  return node.childNodes.map(rawText).join("");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function ancestorsHidden(el: T.Element, rules: readonly HidingRule[]): boolean {
  for (let n: T.ParentNode | null = el; n && isEl(n); n = (n as T.Element).parentNode) {
    if (isHiddenElement(n as T.Element, rules)) return true;
    if (["template", "noscript", "head"].includes((n as T.Element).tagName)) return true;
  }
  return false;
}

const CHROME = new Set(["nav", "header", "footer", "aside", "form", "dialog", "menu"]);
const CHROME_ROLE = /^(?:navigation|banner|contentinfo|complementary|search|dialog|menu)$/i;
/** Class or id words of boilerplate blocks inside an article. */
const BOILERPLATE =
  /(?:^|[\s_-])(?:share|sharing|social|comments?|related|recommended|more-posts|read-next|subscribe|subscription|signup|sign-up|newsletter-form|paywall|promo|advert|ads?|sponsor|footer|sidebar|byline-actions|author-bio|tags?|breadcrumbs?|pagination|cookie|modal|popup)(?:$|[\s_-])/i;

function insideChrome(el: T.Element): boolean {
  for (let n: T.ParentNode | null = el.parentNode; n && isEl(n); n = (n as T.Element).parentNode) {
    const e = n as T.Element;
    if (CHROME.has(e.tagName) || CHROME_ROLE.test(attrOf(e, "role") ?? "")) return true;
  }
  return false;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** rel="next" from <link> or <a>, same site, normalized. */
function nextLink(doc: T.Document, pageUrl: string, rules: readonly HidingRule[]): string | null {
  for (const el of elements(doc)) {
    if (el.tagName !== "link" && el.tagName !== "a") continue;
    const rel = (attrOf(el, "rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("next")) continue;
    if (el.tagName === "a" && ancestorsHidden(el, rules)) continue;
    const href = normalizeUrl(attrOf(el, "href") ?? "", pageUrl);
    if (href && sameSite(href, pageUrl) && !isSignInUrl(href) && href !== normalizeUrl(pageUrl)) return href;
  }
  return null;
}

// ---- JSON-LD ----------------------------------------------------------------------------

/** Every JSON-LD object in the page (parse failures skipped), flattened through @graph. */
export function jsonLdNodes(doc: T.Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let budget = MAX_JSONLD_NODES;
  const visit = (v: unknown, depth: number) => {
    if (budget <= 0 || depth > 12 || !v || typeof v !== "object") return;
    budget--;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    out.push(v as Record<string, unknown>);
    for (const x of Object.values(v as Record<string, unknown>)) if (x && typeof x === "object") visit(x, depth + 1);
  };
  let bytes = 0;
  for (const el of elements(doc)) {
    if (el.tagName !== "script" || (attrOf(el, "type") ?? "").toLowerCase().trim() !== "application/ld+json") continue;
    const text = el.childNodes.map((c) => (c.nodeName === "#text" ? (c as T.TextNode).value : "")).join("");
    bytes += text.length;
    if (bytes > MAX_JSONLD_BYTES) break;
    try {
      visit(JSON.parse(text), 0);
    } catch {
      /* malformed JSON-LD is common; skip it */
    }
  }
  return out;
}

const typesOf = (n: Record<string, unknown>): string[] =>
  (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]).filter((t): t is string => typeof t === "string");
const ARTICLE_TYPE = /^(?:Article|BlogPosting|NewsArticle|Report|SocialMediaPosting|AnalysisNewsArticle|OpinionNewsArticle|ReportageNewsArticle|TechArticle|ScholarlyArticle|LiveBlogPosting|CreativeWork)$/;

function linksFromJsonLd(nodes: Record<string, unknown>[], pageUrl: string): IssueLink[] {
  const out: IssueLink[] = [];
  for (const n of nodes) {
    const types = typesOf(n);
    let url: unknown;
    let item: Record<string, unknown> = n;
    if (types.includes("ListItem")) {
      const it = n.item;
      if (typeof it === "string") url = it;
      else if (it && typeof it === "object" && !Array.isArray(it)) {
        item = it as Record<string, unknown>;
        url = item.url ?? item["@id"];
      } else url = n.url;
    } else if (types.some((t) => ARTICLE_TYPE.test(t))) {
      url = n.url ?? (typeof n.mainEntityOfPage === "string" ? n.mainEntityOfPage : undefined);
    } else continue;
    if (typeof url !== "string") continue;
    const norm = normalizeUrl(url, pageUrl);
    if (!norm) continue;
    const title = [item.headline, item.name, n.name].find((x): x is string => typeof x === "string") ?? "";
    out.push({ url: norm, title: squash(title).slice(0, 300), published: isoDate(item.datePublished ?? item.dateCreated ?? n.datePublished) });
  }
  return out;
}

// ---- Index pages ------------------------------------------------------------------------

function dedupe(links: IssueLink[], archiveUrl: string, allowed: (url: string, archive: string) => boolean): IssueLink[] {
  const seen = new Map<string, IssueLink>();
  for (const l of links) {
    if (!allowed(l.url, archiveUrl)) continue;
    const prev = seen.get(l.url);
    if (!prev) seen.set(l.url, l);
    else {
      if (!prev.title && l.title) prev.title = l.title;
      if (!prev.published && l.published) prev.published = l.published;
    }
    if (seen.size >= MAX_LINKS_PER_PAGE) break;
  }
  return [...seen.values()];
}

/** Issue links on an archive (index) page, by the most structured method that finds any. */
export function issueLinksFromIndex(html: string, pageUrl: string): IndexLinks {
  const doc = parse(html);
  const rules = documentHidingRules(doc);
  const self = normalizeUrl(pageUrl) ?? pageUrl;
  const next = nextLink(doc, pageUrl, rules);
  const notSelf = (l: IssueLink) => l.url !== self;

  const fromLd = dedupe(linksFromJsonLd(jsonLdNodes(doc), pageUrl).filter(notSelf), pageUrl, candidateAllowed);
  if (fromLd.length) return { links: fromLd, method: "jsonld", next };

  const fromArticles: IssueLink[] = [];
  for (const el of elements(doc)) {
    if (el.tagName !== "article" || ancestorsHidden(el, rules)) continue;
    let link: T.Element | null = null;
    let time: T.Element | null = null;
    let linkInHeading = false;
    for (const inner of elements(el)) {
      if (!time && inner.tagName === "time") time = inner;
      if (inner.tagName === "a" && attrOf(inner, "href") && !ancestorsHidden(inner, rules)) {
        const inHeading = (() => {
          for (let n: T.ParentNode | null = inner.parentNode; n && n !== el && isEl(n); n = (n as T.Element).parentNode) {
            if (/^h[1-4]$/.test((n as T.Element).tagName)) return true;
          }
          return false;
        })();
        if (!link || (inHeading && !linkInHeading)) {
          link = inner;
          linkInHeading = inHeading;
        }
      }
    }
    if (!link) continue;
    const url = normalizeUrl(attrOf(link, "href")!, pageUrl);
    if (!url) continue;
    fromArticles.push({
      url,
      title: squash(rawText(link)).slice(0, 300),
      published: time ? isoDate(attrOf(time, "datetime") ?? rawText(time)) : null,
    });
  }
  const articles = dedupe(fromArticles.filter(notSelf), pageUrl, candidateAllowed);
  if (articles.length) return { links: articles, method: "article", next };

  const fromLinks: IssueLink[] = [];
  for (const el of elements(doc)) {
    if (el.tagName !== "a" || !attrOf(el, "href")) continue;
    if ((attrOf(el, "rel") ?? "").toLowerCase().split(/\s+/).some((r) => r === "nofollow" || r === "next" || r === "prev")) continue;
    if (insideChrome(el) || ancestorsHidden(el, rules)) continue;
    const title = squash(rawText(el));
    if (title.length < 8) continue; // "Next", "1", icons
    const url = normalizeUrl(attrOf(el, "href")!, pageUrl);
    if (!url) continue;
    fromLinks.push({ url, title: title.slice(0, 300), published: null });
  }
  const heuristic = dedupe(fromLinks.filter(notSelf), pageUrl, heuristicAllowed);
  return { links: heuristic, method: heuristic.length ? "heuristic" : null, next };
}

// ---- Sitemaps ---------------------------------------------------------------------------

export interface ParsedSitemap {
  kind: "urlset" | "index" | null;
  /** urlset: page URLs with dates; index: child sitemap URLs (published null). */
  entries: { url: string; published: string | null; title: string; news: boolean }[];
}

/** A sitemap or sitemap index (XML). No DOCTYPE or entity expansion. */
export function parseSitemap(xml: string): ParsedSitemap {
  const p = new SaxesParser({ xmlns: false, position: false });
  const entries: ParsedSitemap["entries"] = [];
  let kind: ParsedSitemap["kind"] = null;
  const stack: string[] = [];
  let cur: { url: string; published: string | null; title: string; news: boolean } | null = null;
  let text = "";
  p.on("doctype", () => {
    throw new Error("doctype");
  });
  p.on("opentag", (t) => {
    const name = t.name.toLowerCase().replace(/^[a-z0-9]+:/, (m) => (m === "news:" ? "news:" : ""));
    stack.push(name);
    if (stack.length === 1) kind = name === "urlset" ? "urlset" : name === "sitemapindex" ? "index" : null;
    if ((name === "url" || name === "sitemap") && stack.length === 2) cur = { url: "", published: null, title: "", news: false };
    if (name.startsWith("news:") && cur) cur.news = true;
    text = "";
  });
  p.on("text", (t) => (text += t));
  p.on("cdata", (t) => (text += t));
  p.on("closetag", () => {
    const name = stack.pop() ?? "";
    if (cur) {
      if (name === "loc" && stack.length === 2) cur.url = text.trim();
      else if (name === "lastmod") cur.published ??= isoDate(text);
      else if (name === "news:publication_date") cur.published = isoDate(text) ?? cur.published;
      else if (name === "news:title") cur.title = squash(text).slice(0, 300);
      else if ((name === "url" || name === "sitemap") && stack.length === 1) {
        if (cur.url && entries.length < 50_000) entries.push(cur);
        cur = null;
      }
    }
    text = "";
  });
  try {
    p.write(xml).close();
  } catch {
    return { kind: null, entries: [] };
  }
  return { kind, entries };
}

/**
 * Issue links from a sitemap: news-sitemap entries, or entries under the archive's own
 * path (not the archive page itself), or, when the hosting platform is known
 * (platforms.ts), entries whose path matches its issue path (beehiiv: /p/<slug>). A
 * whole-site sitemap with none of these gives nothing, rather than every page on the
 * site. Newest first.
 */
export function issueLinksFromSitemap(sitemap: ParsedSitemap, archiveUrl: string, options: { issuePath?: RegExp } = {}): IssueLink[] {
  if (sitemap.kind !== "urlset") return [];
  const base = new URL(archiveUrl).pathname.replace(/\/+$/, "");
  const links: IssueLink[] = [];
  for (const e of sitemap.entries) {
    const url = normalizeUrl(e.url);
    if (!url || !candidateAllowed(url, archiveUrl)) continue;
    const path = new URL(url).pathname;
    const under = base !== "" && path.startsWith(`${base}/`);
    const platformIssue = !!options.issuePath && options.issuePath.test(path);
    if (!e.news && !under && !platformIssue) continue;
    links.push({ url, title: e.title, published: e.published });
  }
  links.sort((a, b) => (b.published ? Date.parse(b.published) : -Infinity) - (a.published ? Date.parse(a.published) : -Infinity));
  return dedupe(links, archiveUrl, candidateAllowed);
}

// ---- Issue pages ------------------------------------------------------------------------

function paragraphChars(el: T.Element): number {
  let n = 0;
  for (const inner of elements(el)) if (inner.tagName === "p") n += squash(rawText(inner)).length;
  return n;
}

/** The element holding the main article text (readability-style), or null for the whole page. */
export function mainContent(doc: T.Document): T.Element | null {
  const all = [...elements(doc)];
  const body = all.find((e) => e.tagName === "body") ?? null;
  const itemprop = all.filter((e) => (attrOf(e, "itemprop") ?? "").split(/\s+/).includes("articleBody"));
  if (itemprop.length) return itemprop.sort((a, b) => paragraphChars(b) - paragraphChars(a))[0];
  const articles = all.filter((e) => e.tagName === "article" && !insideChrome(e));
  if (articles.length) {
    const best = articles.sort((a, b) => paragraphChars(b) - paragraphChars(a))[0];
    if (paragraphChars(best) > 0 || articles.length === 1) return best;
  }
  const main = all.find((e) => e.tagName === "main" || (attrOf(e, "role") ?? "").toLowerCase() === "main");
  if (main) return main;
  // The block with the most paragraph text, readability-style: each <p> counts in full for
  // its parent block and half for the block above that. So a post body whose paragraphs
  // each sit in their own wrapper <div> (beehiiv) beats any single wrapper, while a block
  // holding its paragraphs directly still beats the page-wide container around it.
  const scores = new Map<T.Element, number>();
  const credit = (e: T.ParentNode | null, n: number) => {
    if (!e || !isEl(e) || !BLOCK_TAGS.has(e.tagName) || insideChrome(e)) return;
    scores.set(e, (scores.get(e) ?? 0) + n);
  };
  for (const p of all) {
    if (p.tagName !== "p" || insideChrome(p)) continue;
    const n = squash(rawText(p)).length;
    if (!n) continue;
    credit(p.parentNode, n);
    const parent = p.parentNode;
    credit(parent && isEl(parent) ? parent.parentNode : null, n / 2);
  }
  let best: T.Element | null = null;
  let bestScore = 0;
  for (const e of all) {
    const score = scores.get(e) ?? 0;
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best ?? body;
}

const BLOCK_TAGS = new Set(["div", "section", "td"]);

function skipBoilerplate(el: T.Element): boolean {
  if (CHROME.has(el.tagName) || CHROME_ROLE.test(attrOf(el, "role") ?? "")) return true;
  if (el.tagName === "button") return true;
  const words = `${attrOf(el, "class") ?? ""} ${attrOf(el, "id") ?? ""}`;
  return BOILERPLATE.test(words);
}

function metaContent(doc: T.Document, keys: string[]): string | null {
  for (const el of elements(doc)) {
    if (el.tagName !== "meta") continue;
    const k = (attrOf(el, "property") ?? attrOf(el, "name") ?? attrOf(el, "itemprop") ?? "").toLowerCase();
    if (keys.includes(k)) {
      const v = attrOf(el, "content");
      if (v && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Reads one issue page: main text through the shared hidden-text-stripping step, plus title, date, canonical URL and the partial flag. */
export function extractIssue(html: string, pageUrl: string, options: { maxChars: number }): IssuePage {
  const doc = parse(html);
  const all = [...elements(doc)];
  const ld = jsonLdNodes(doc).filter((n) => typesOf(n).some((t) => ARTICLE_TYPE.test(t)));
  const article = ld[0];

  let canonical = normalizeUrl(pageUrl) ?? pageUrl;
  const linkCanon = all.find((e) => e.tagName === "link" && (attrOf(e, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const canonHref = linkCanon ? normalizeUrl(attrOf(linkCanon, "href") ?? "", pageUrl) : null;
  if (canonHref && sameSite(canonHref, pageUrl) && !isSignInUrl(canonHref)) canonical = canonHref;

  const h1 = all.find((e) => e.tagName === "h1");
  const titleEl = all.find((e) => e.tagName === "title");
  const rawTitle =
    (typeof article?.headline === "string" ? article.headline : null) ??
    metaContent(doc, ["og:title", "twitter:title"]) ??
    (h1 ? rawText(h1) : null) ??
    (titleEl ? rawText(titleEl) : "");
  const title = plainTextToText(squash(rawTitle), { maxChars: 500 }).text.replace(/\s+/g, " ");

  const timeEl = all.find((e) => e.tagName === "time" && attrOf(e, "datetime"));
  const published =
    isoDate(article?.datePublished) ??
    isoDate(metaContent(doc, ["article:published_time", "datepublished", "date", "pubdate", "dc.date"])) ??
    (timeEl ? isoDate(attrOf(timeEl, "datetime")) : null);

  // The page is parsed once more by htmlToText (it needs the whole document for <style>
  // rules); the main element is chosen there by the same rule.
  const { text, truncated } = htmlToText(html, { maxChars: options.maxChars, root: mainContent, skip: skipBoilerplate });

  const free = ld.map((n) => n.isAccessibleForFree).find((v) => v !== undefined);
  const lockedByData = free === false || (typeof free === "string" && free.trim().toLowerCase() === "false");
  // A paywall notice is often in a box the article text leaves out as boilerplate, so the
  // check reads the whole visible page.
  const pageText = htmlToText(html, { maxChars: 200_000 }).text;
  const tier = (metaContent(doc, ["article:content_tier"]) ?? "").toLowerCase();
  const partial =
    lockedByData ||
    tier === "locked" ||
    tier === "metered" ||
    PAYWALL.test(pageText) ||
    TRUNCATED_END.test(text) ||
    text.length < PARTIAL_MAX_CHARS;
  return { canonicalUrl: canonical, title, published, text, truncated, partial };
}

/** A display name for the site: og:site_name, else <title>; plain text. */
export function pageTitle(html: string): string {
  const doc = parse(html.slice(0, 256 * 1024));
  const site = metaContent(doc, ["og:site_name"]);
  const titleEl = [...elements(doc)].find((e) => e.tagName === "title");
  const raw = site ?? (titleEl ? rawText(titleEl) : "");
  return plainTextToText(squash(raw), { maxChars: 200 }).text.replace(/\s+/g, " ");
}
