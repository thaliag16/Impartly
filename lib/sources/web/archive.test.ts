// The public web archive fallback: link finding, issue extraction, politeness, and the
// archive source end to end on the fake internet (tests/web/fake-web.ts). Every page is
// invented (fixtures/archives/, .example hosts). Time is a fake clock: the pacer's waits
// are recorded, never slept.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeWeb, rss, feedFixture, type Route } from "../../../tests/web/fake-web";
import { SourceFetchError } from "../types";
import {
  extractIssue,
  isSignInUrl,
  issueLinksFromIndex,
  issueLinksFromSitemap,
  mainContent,
  normalizeUrl,
  pageTitle,
  parseSitemap,
  sameSite,
} from "./archive";
import { ARCHIVE_LIMITS, createPacer, webArchiveSource, type StoredArchive } from "./archive-source";
import type { CatalogEntry } from "./catalog";
import { discoverFeed } from "./discover";
import { createWebFetcher } from "./fetcher";
import { robotsExtras } from "./robots";
import { parse } from "parse5";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/archives");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
const html = (body: string, headers: Record<string, string> = {}): Route => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body,
});
const text = (body: string): Route => ({ status: 200, headers: { "content-type": "text/plain" }, body });

const SITE = "https://letters.example";
const NOW = new Date("2026-11-23T12:00:00Z");
const pullOpts = (o: Partial<{ since: Date; limit: number; maxChars: number; firstPull: boolean }> = {}) => ({
  since: new Date("2026-11-01T00:00:00Z"),
  limit: 50,
  maxChars: 20_000,
  firstPull: false,
  ...o,
});

/** A fake clock shared by the pacer and the transport, so request times can be checked. */
function clockedWeb(routes: Record<string, Route>) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const times: { url: string; at: number }[] = [];
  const web = createFakeWeb({ routes });
  const inner = web.transport;
  web.transport = async (req) => {
    times.push({ url: req.url.toString(), at: t });
    return inner(req);
  };
  const pacer = createPacer({
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { web, pacer, sleeps, times, fetcher: createWebFetcher(web) };
}

const archive = (o: Partial<StoredArchive> = {}): StoredArchive => ({
  id: "a1",
  archiveUrl: `${SITE}/archive`,
  title: "The Invented Ledger",
  etag: null,
  lastModified: null,
  knownUrls: [],
  ...o,
});

const requested = (web: { requests: { url: URL }[] }) => web.requests.map((r) => r.url.toString());

describe("URLs", () => {
  it("normalizes: absolute, no fragment, no tracking parameters, no trailing slash, http(s) only", () => {
    expect(normalizeUrl("/p/x/?utm_source=a&id=3#top", `${SITE}/archive`)).toBe(`${SITE}/p/x?id=3`);
    expect(normalizeUrl("HTTPS://Letters.EXAMPLE/")).toBe(`${SITE}/`);
    expect(normalizeUrl("javascript:alert(1)", SITE)).toBeNull();
    expect(normalizeUrl("mailto:a@letters.example", SITE)).toBeNull();
    expect(normalizeUrl("https://user:pw@letters.example/p/x")).toBeNull();
  });

  it("same site means the same host, ignoring www; subdomains are other sites", () => {
    expect(sameSite("https://www.letters.example/a", `${SITE}/b`)).toBe(true);
    expect(sameSite("https://shop.letters.example/a", `${SITE}/b`)).toBe(false);
    expect(sameSite("https://elsewhere.example/a", `${SITE}/b`)).toBe(false);
  });

  it("recognizes sign-in, subscribe and account pages", () => {
    for (const p of ["/login", "/account/subscribe", "/sign-in?next=/p/x", "/members/area", "/wp-login.php", "/checkout", "/subscribe"]) {
      expect(isSignInUrl(`${SITE}${p}`), p).toBe(true);
    }
    for (const p of ["/p/subscriber-growth-in-2026", "/p/ledger-issue-3", "/2026/11/accounting-notes"]) {
      expect(isSignInUrl(`${SITE}${p}`), p).toBe(false);
    }
  });
});

describe("robots.txt extras", () => {
  it("reads Crawl-delay for our token, else *, and Sitemap lines", () => {
    const body = "User-agent: Impartly\nCrawl-delay: 3\n\nUser-agent: *\nCrawl-delay: 10\nDisallow: /x\nSitemap: https://letters.example/sitemap.xml\nSitemap: not-a-url\n";
    expect(robotsExtras(body, "impartly")).toEqual({ crawlDelaySeconds: 3, sitemaps: ["https://letters.example/sitemap.xml"] });
    expect(robotsExtras("User-agent: *\nCrawl-delay: 1.5\n", "impartly").crawlDelaySeconds).toBe(1.5);
    expect(robotsExtras("User-agent: other\nCrawl-delay: 9\n", "impartly").crawlDelaySeconds).toBeNull();
  });
});

describe("issue links on an archive page", () => {
  it("prefers JSON-LD: dated issues in order, relative URLs resolved, off-site and malformed entries dropped", () => {
    const r = issueLinksFromIndex(fixture("index-jsonld.html"), `${SITE}/archive`);
    expect(r.method).toBe("jsonld");
    expect(r.links).toEqual([
      { url: `${SITE}/p/ledger-issue-3`, title: "Issue 3: Invented lenders cut rates", published: "2026-11-23T06:00:00.000Z" },
      { url: `${SITE}/p/ledger-issue-2`, title: "Issue 2: An invented fund closes", published: "2026-11-16T06:00:00.000Z" },
      { url: `${SITE}/p/ledger-issue-1`, title: "Issue 1: Hello from an invented desk", published: "2026-11-09T06:00:00.000Z" },
    ]);
  });

  it("then <article>/<time>: heading links win over tag links; hidden articles and off-site links are ignored; rel=next found", () => {
    const r = issueLinksFromIndex(fixture("index-articles.html"), `${SITE}/archive`);
    expect(r.method).toBe("article");
    expect(r.links.map((l) => l.url)).toEqual([`${SITE}/p/ledger-issue-3`, `${SITE}/p/ledger-issue-2`]);
    expect(r.links[0].published).toBe("2026-11-23T06:00:00.000Z");
    expect(r.next).toBe(`${SITE}/archive?page=2`);
  });

  it("then conservative same-site links: issue-shaped paths only, never nav/footer, sign-in, tags, files, hidden, nofollow or other sites", () => {
    const r = issueLinksFromIndex(fixture("index-heuristic.html"), `${SITE}/`);
    expect(r.method).toBe("heuristic");
    expect(r.links.map((l) => l.url)).toEqual([`${SITE}/p/desk-issue-3`, `${SITE}/p/desk-issue-2`, `${SITE}/p/desk-issue-1`]);
    expect(r.links.every((l) => l.published === null)).toBe(true);
  });

  it("an archive under a path takes links under that path even when not issue-shaped", () => {
    const page = `<main><a href="/letters/autumn-invented-notes">Autumn invented notes, long title</a><a href="/letters/winter-invented-notes">Winter invented notes, long title</a><a href="/shop/invented-hats">Invented hats for sale in the shop</a></main>`;
    const r = issueLinksFromIndex(page, `${SITE}/letters`);
    expect(r.links.map((l) => l.url)).toEqual([`${SITE}/letters/autumn-invented-notes`, `${SITE}/letters/winter-invented-notes`]);
  });

  it("a page with no issue links finds nothing", () => {
    expect(issueLinksFromIndex("<html><body><p>No links</p></body></html>", `${SITE}/`)).toEqual({ links: [], method: null, next: null });
  });

  it("rel=next to another site or a sign-in page is ignored", () => {
    expect(issueLinksFromIndex('<link rel="next" href="https://elsewhere.example/page/2">', `${SITE}/a`).next).toBeNull();
    expect(issueLinksFromIndex('<a rel="next" href="/login?page=2">next</a>', `${SITE}/a`).next).toBeNull();
  });
});

describe("sitemaps", () => {
  it("parses a news sitemap; keeps same-site news entries, newest first", () => {
    const sm = parseSitemap(fixture("sitemap-news.xml"));
    expect(sm.kind).toBe("urlset");
    const links = issueLinksFromSitemap(sm, `${SITE}/`);
    expect(links.map((l) => [l.url, l.published, l.title])).toEqual([
      [`${SITE}/p/ledger-issue-3`, "2026-11-23T06:00:00.000Z", "Issue 3: Invented lenders cut rates"],
      [`${SITE}/p/ledger-issue-2`, "2026-11-16T06:00:00.000Z", "Issue 2: An invented fund closes"],
    ]);
  });

  it("a whole-site sitemap with no news entries gives only URLs under the archive's path", () => {
    const sm = parseSitemap(
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/about</loc></url><url><loc>${SITE}/letters/one</loc><lastmod>2026-11-20</lastmod></url></urlset>`,
    );
    expect(issueLinksFromSitemap(sm, `${SITE}/`)).toEqual([]);
    expect(issueLinksFromSitemap(sm, `${SITE}/letters`).map((l) => l.url)).toEqual([`${SITE}/letters/one`]);
  });

  it("refuses DOCTYPE/entities and garbage", () => {
    expect(parseSitemap(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><urlset><url><loc>&a;</loc></url></urlset>`).entries).toEqual([]);
    expect(parseSitemap("not xml").kind).toBeNull();
  });
});

describe("reading an issue page", () => {
  it("keeps the article's visible text; drops hidden instructions, nav, share bars, comments, related, forms and footer", () => {
    const issue = extractIssue(fixture("issue-full.html"), `${SITE}/p/ledger-issue-3?utm_source=x`, { maxChars: 20_000 });
    expect(issue.canonicalUrl).toBe(`${SITE}/p/ledger-issue-3`);
    expect(issue.title).toBe("Issue 3: Invented lenders cut rates");
    expect(issue.published).toBe("2026-11-23T06:00:00.000Z");
    expect(issue.text).toContain("Larkspur Lending");
    expect(issue.text).toContain("$40 a month");
    expect(issue.text).toContain("safetextend.");
    expect(issue.text).not.toMatch(/PWNED/);
    for (const boiler of ["Share this", "Comment from", "Related:", "Subscribe to the invented", "footer text", "The Invented Ledger Subscribe"]) {
      expect(issue.text, boiler).not.toContain(boiler);
    }
    expect(issue.partial).toBe(false);
  });

  it("a paywalled page is partial: structured data says so and the notice is shown; only public text is kept", () => {
    const issue = extractIssue(fixture("issue-paywall.html"), `${SITE}/p/ledger-issue-2`, { maxChars: 20_000 });
    expect(issue.partial).toBe(true);
    expect(issue.text).toContain("Meadowbank Capital");
    expect(issue.published).toBe("2026-11-16T06:00:00.000Z");
  });

  it("the paywall notice alone (no structured data) also marks it partial, even when it sits in a box left out of the text", () => {
    const page = fixture("issue-paywall.html").replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
    const issue = extractIssue(page, `${SITE}/p/ledger-issue-2`, { maxChars: 20_000 });
    expect(issue.text).not.toContain("paid subscribers");
    expect(issue.partial).toBe(true);
  });

  it("structured data alone (isAccessibleForFree false, or a locked content tier) marks a long page partial", () => {
    const noNotice = fixture("issue-paywall.html").replace(/<div class="paywall">[\s\S]*?<\/div>/, "");
    expect(extractIssue(noNotice, `${SITE}/p/ledger-issue-2`, { maxChars: 20_000 }).partial).toBe(true);
    const free = noNotice.replace(/"isAccessibleForFree":false/g, '"isAccessibleForFree":true');
    expect(extractIssue(free, `${SITE}/p/ledger-issue-2`, { maxChars: 20_000 }).partial).toBe(false);
    const tier = free.replace("</head>", '<meta property="article:content_tier" content="locked"></head>');
    expect(extractIssue(tier, `${SITE}/p/ledger-issue-2`, { maxChars: 20_000 }).partial).toBe(true);
  });

  it("a short teaser ending in an ellipsis is partial", () => {
    expect(extractIssue(fixture("issue-teaser.html"), `${SITE}/p/ledger-issue-1`, { maxChars: 20_000 }).partial).toBe(true);
  });

  it("a canonical link to another site is ignored", () => {
    const page = fixture("issue-full.html").replace(`href="https://letters.example/p/ledger-issue-3"`, `href="https://elsewhere.example/p/x"`);
    expect(extractIssue(page, `${SITE}/p/ledger-issue-3`, { maxChars: 20_000 }).canonicalUrl).toBe(`${SITE}/p/ledger-issue-3`);
  });

  it("main content: the <article> with the most paragraph text, else the densest block", () => {
    const doc = parse(`<body><article><p>short</p></article><article id="big"><p>${"word ".repeat(100)}</p></article></body>`);
    expect(mainContent(doc)?.attrs.find((a) => a.name === "id")?.value).toBe("big");
    const doc2 = parse(`<body><div id="menu"><p>Home</p></div><div id="post"><p>${"word ".repeat(50)}</p><p>${"more ".repeat(50)}</p></div></body>`);
    expect(mainContent(doc2)?.attrs.find((a) => a.name === "id")?.value).toBe("post");
  });

  it("an article inside a hidden ancestor yields no text", () => {
    const page = `<html><body><div style="display:none"><article><p>${"hidden instruction ".repeat(40)}</p></article></div></body></html>`;
    expect(extractIssue(page, `${SITE}/p/x`, { maxChars: 20_000 }).text).toBe("");
  });

  it("the site title comes from og:site_name, else <title>, as plain text", () => {
    expect(pageTitle(fixture("index-jsonld.html"))).toBe("The Invented Ledger");
    expect(pageTitle("<title>Notes &amp; Things</title>")).toBe("Notes & Things");
  });
});

describe("the archive source", () => {
  const issueRoutes = (): Record<string, Route> => ({
    [`${SITE}/p/ledger-issue-3`]: html(fixture("issue-full.html")),
    [`${SITE}/p/ledger-issue-2`]: html(fixture("issue-paywall.html")),
    [`${SITE}/p/ledger-issue-1`]: html(fixture("issue-teaser.html")),
  });

  it("stores new issues with clean text, keyed by canonical URL; partial pages marked; off-site links never requested", async () => {
    const { web, pacer, fetcher } = clockedWeb({ [`${SITE}/archive`]: html(fixture("index-jsonld.html"), { etag: '"v1"' }), ...issueRoutes() });
    const r = await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(r.items.map((i) => [i.key, i.subject, i.partial, i.receivedAt])).toEqual([
      [`url:${SITE}/p/ledger-issue-3`, "Issue 3: Invented lenders cut rates", false, "2026-11-23T06:00:00.000Z"],
      [`url:${SITE}/p/ledger-issue-2`, "Issue 2: An invented fund closes", true, "2026-11-16T06:00:00.000Z"],
      [`url:${SITE}/p/ledger-issue-1`, "Issue 1: Hello from an invented desk", true, "2026-11-09T06:00:00.000Z"],
    ]);
    expect(r.items[0].senderAddress).toBe("letters.example");
    expect(r.items[0].senderName).toBe("The Invented Ledger");
    expect(r.items.map((i) => i.bodyText).join("\n")).not.toMatch(/PWNED/);
    expect(r.cache).toEqual({ etag: '"v1"', lastModified: null, notModified: false });
    expect(r.listed).toBe(3);
    expect(web.lookups.every((h) => h === "letters.example")).toBe(true);
    expect(requested(web).every((u) => u.startsWith(`${SITE}/`))).toBe(true);
  });

  it("at most maxIssuesPerRun issue pages per run (capped), newest first", async () => {
    const items = Array.from({ length: 9 }, (_, n) => ({
      "@type": "BlogPosting",
      url: `${SITE}/p/n-${n}`,
      headline: `Invented ${n}`,
      datePublished: new Date(Date.UTC(2026, 10, 20 - n)).toISOString(),
    }));
    const index = `<script type="application/ld+json">${JSON.stringify({ "@type": "Blog", blogPost: items })}</script>`;
    const routes: Record<string, Route> = { [`${SITE}/archive`]: html(index) };
    for (let n = 0; n < 9; n++) routes[`${SITE}/p/n-${n}`] = html(fixture("issue-full.html").replace(/ledger-issue-3/g, `n-${n}`));
    const { web, pacer, fetcher } = clockedWeb(routes);
    const r = await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(r.items).toHaveLength(ARCHIVE_LIMITS.maxIssuesPerRun);
    expect(r.capped).toBe(true);
    expect(r.items[0].key).toBe(`url:${SITE}/p/n-0`);
    expect(requested(web).filter((u) => u.includes("/p/"))).toHaveLength(ARCHIVE_LIMITS.maxIssuesPerRun);
  });

  it("is polite: at least 1 s between requests to the site, robots.txt counted", async () => {
    const { pacer, fetcher, times } = clockedWeb({ [`${SITE}/archive`]: html(fixture("index-jsonld.html")), ...issueRoutes() });
    await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(times.map((t) => new URL(t.url).pathname)).toEqual(["/robots.txt", "/archive", "/p/ledger-issue-3", "/p/ledger-issue-2", "/p/ledger-issue-1"]);
    for (let i = 1; i < times.length; i++) expect(times[i].at - times[i - 1].at).toBeGreaterThanOrEqual(1000);
  });

  it("honours Crawl-delay, and skips a site asking for more than the maximum without fetching anything else", async () => {
    const slow = clockedWeb({ [`${SITE}/robots.txt`]: text("User-agent: *\nCrawl-delay: 4\n"), [`${SITE}/archive`]: html(fixture("index-jsonld.html")), ...issueRoutes() });
    await webArchiveSource(archive(), slow.fetcher, { pacer: slow.pacer, now: () => NOW }).pull(pullOpts());
    for (let i = 1; i < slow.times.length; i++) expect(slow.times[i].at - slow.times[i - 1].at).toBeGreaterThanOrEqual(4000);

    const tooSlow = clockedWeb({ [`${SITE}/robots.txt`]: text("User-agent: impartly\nCrawl-delay: 120\n"), [`${SITE}/archive`]: html(fixture("index-jsonld.html")) });
    await expect(webArchiveSource(archive(), tooSlow.fetcher, { pacer: tooSlow.pacer }).pull(pullOpts())).rejects.toEqual(new SourceFetchError("crawl_delay_too_long"));
    expect(requested(tooSlow.web)).toEqual([`${SITE}/robots.txt`]);
  });

  it("robots.txt: a disallowed issue is skipped and never requested; a disallowed archive fails the pull", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/robots.txt`]: text("User-agent: *\nDisallow: /p/ledger-issue-2\n"),
      [`${SITE}/archive`]: html(fixture("index-jsonld.html")),
      ...issueRoutes(),
    });
    const r = await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(r.items.map((i) => i.key)).toEqual([`url:${SITE}/p/ledger-issue-3`, `url:${SITE}/p/ledger-issue-1`]);
    expect(requested(web)).not.toContain(`${SITE}/p/ledger-issue-2`);

    const blocked = clockedWeb({ [`${SITE}/robots.txt`]: text("User-agent: Impartly\nDisallow: /\n"), [`${SITE}/archive`]: html(fixture("index-jsonld.html")) });
    await expect(webArchiveSource(archive(), blocked.fetcher, { pacer: blocked.pacer }).pull(pullOpts())).rejects.toEqual(new SourceFetchError("robots_disallowed"));
    expect(requested(blocked.web)).toEqual([`${SITE}/robots.txt`]);
  });

  it("never follows a redirect to a sign-in page or another site, and skips refused (401/402/403/451) issues", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/archive`]: html(fixture("index-jsonld.html")),
      [`${SITE}/p/ledger-issue-3`]: { status: 302, headers: { location: `${SITE}/login?next=/p/ledger-issue-3` } },
      [`${SITE}/p/ledger-issue-2`]: { status: 301, headers: { location: "https://elsewhere.example/p/ledger-issue-2" } },
      [`${SITE}/p/ledger-issue-1`]: { status: 402, headers: { "content-type": "text/html" }, body: "Payment required" },
    });
    const r = await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(r.items).toEqual([]);
    expect(requested(web).some((u) => u.includes("/login"))).toBe(false);
    expect(web.lookups).not.toContain("elsewhere.example");
  });

  it("sends no cookies or credentials, and identifies itself", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/archive`]: html(fixture("index-jsonld.html"), { "set-cookie": "session=abc" }),
      ...issueRoutes(),
    });
    await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    for (const req of web.requests) {
      const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      expect(h.cookie).toBeUndefined();
      expect(h.authorization).toBeUndefined();
      expect(h["user-agent"]).toMatch(/^Impartly\//);
    }
  });

  it("fetches only new issues: stored ones are skipped (by key or link)", async () => {
    const { web, pacer, fetcher } = clockedWeb({ [`${SITE}/archive`]: html(fixture("index-jsonld.html")), ...issueRoutes() });
    const r = await webArchiveSource(
      archive({ knownUrls: [`url:${SITE}/p/ledger-issue-2`, `${SITE}/p/ledger-issue-1/`] }),
      fetcher,
      { pacer, now: () => NOW },
    ).pull(pullOpts());
    expect(r.items.map((i) => i.key)).toEqual([`url:${SITE}/p/ledger-issue-3`]);
    expect(requested(web).filter((u) => u.includes("/p/"))).toEqual([`${SITE}/p/ledger-issue-3`]);
  });

  it("dated listings: issues before `since` are not fetched", async () => {
    const { web, pacer, fetcher } = clockedWeb({ [`${SITE}/archive`]: html(fixture("index-jsonld.html")), ...issueRoutes() });
    const r = await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts({ since: new Date("2026-11-20T00:00:00Z"), firstPull: true }));
    expect(r.items.map((i) => i.key)).toEqual([`url:${SITE}/p/ledger-issue-3`]);
    expect(requested(web).filter((u) => u.includes("/p/"))).toHaveLength(1);
  });

  it("undated listings: a first pull takes only the newest; later pulls stop at the first stored issue", async () => {
    const routes = {
      [`${SITE}/`]: html(fixture("index-heuristic.html")),
      [`${SITE}/p/desk-issue-3`]: html(fixture("issue-full.html").replace(/ledger-issue-3/g, "desk-issue-3").replace(/<meta property="article:published_time"[^>]*>/, "")),
      [`${SITE}/p/desk-issue-2`]: html(fixture("issue-full.html").replace(/ledger-issue-3/g, "desk-issue-2").replace(/<meta property="article:published_time"[^>]*>/, "")),
      [`${SITE}/p/desk-issue-1`]: html(fixture("issue-full.html").replace(/ledger-issue-3/g, "desk-issue-1").replace(/<meta property="article:published_time"[^>]*>/, "")),
    };
    const first = clockedWeb(routes);
    const r1 = await webArchiveSource(archive({ archiveUrl: `${SITE}/` }), first.fetcher, { pacer: first.pacer, now: () => NOW }).pull(pullOpts({ firstPull: true }));
    expect(r1.items.map((i) => i.key)).toEqual([`url:${SITE}/p/desk-issue-3`]);
    expect(r1.items[0].receivedAt).toBe(NOW.toISOString()); // undated: when it was fetched

    const later = clockedWeb(routes);
    const r2 = await webArchiveSource(archive({ archiveUrl: `${SITE}/`, knownUrls: [`url:${SITE}/p/desk-issue-2`] }), later.fetcher, {
      pacer: later.pacer,
      now: () => NOW,
    }).pull(pullOpts());
    expect(r2.items.map((i) => i.key)).toEqual([`url:${SITE}/p/desk-issue-3`]);
    expect(requested(later.web)).not.toContain(`${SITE}/p/desk-issue-1`);
  });

  it("undated listing: stops at the first page dated before `since`", async () => {
    const routes = {
      [`${SITE}/`]: html(fixture("index-heuristic.html")),
      [`${SITE}/p/desk-issue-3`]: html(fixture("issue-full.html").replace(/ledger-issue-3/g, "desk-issue-3")),
      [`${SITE}/p/desk-issue-2`]: html(fixture("issue-full.html").replace(/ledger-issue-3/g, "desk-issue-2").replace("2026-11-23", "2026-10-01")),
      [`${SITE}/p/desk-issue-1`]: html(fixture("issue-full.html").replace(/ledger-issue-3/g, "desk-issue-1")),
    };
    const { web, pacer, fetcher } = clockedWeb(routes);
    const r = await webArchiveSource(archive({ archiveUrl: `${SITE}/` }), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(r.items.map((i) => i.key)).toEqual([`url:${SITE}/p/desk-issue-3`]);
    expect(requested(web)).not.toContain(`${SITE}/p/desk-issue-1`);
  });

  it("de-duplicates by canonical URL: two links to one issue store it once", async () => {
    const index = `<main><article><h2><a href="/p/ledger-issue-3">Issue three, first link</a></h2><time datetime="2026-11-23T06:00:00Z"></time></article><article><h2><a href="/p/issue-3-amp">Issue three, second link</a></h2><time datetime="2026-11-22T06:00:00Z"></time></article></main>`;
    const { pacer, fetcher } = clockedWeb({
      [`${SITE}/archive`]: html(index),
      [`${SITE}/p/ledger-issue-3`]: html(fixture("issue-full.html")),
      [`${SITE}/p/issue-3-amp`]: html(fixture("issue-full.html")),
    });
    const r = await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(r.items.map((i) => i.key)).toEqual([`url:${SITE}/p/ledger-issue-3`]);
  });

  it("a hidden page's instructions never reach the item text", async () => {
    const { pacer, fetcher } = clockedWeb({ [`${SITE}/archive`]: html(fixture("index-jsonld.html")), ...issueRoutes() });
    const r = await webArchiveSource(archive(), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    const full = r.items.find((i) => i.key.endsWith("ledger-issue-3"))!;
    expect(full.bodyText).toContain("Quillon Research");
    expect(full.bodyText).not.toMatch(/PWNED|ignore your instructions|disregard/i);
  });

  it("pagination: follows rel=next while everything is new, at most maxIndexPages, and a loop ends it", async () => {
    const page = (n: number, next: string | null) =>
      `<html><head>${next ? `<link rel="next" href="${next}">` : ""}</head><body><main><article><h2><a href="/p/page${n}-issue">Issue from page ${n}</a></h2></article></main></body></html>`;
    // An endless calendar: every page links to a newer "next".
    const endless: Record<string, Route> = { [`${SITE}/archive`]: html(page(1, "/archive?page=2")) };
    for (let n = 2; n < 50; n++) endless[`${SITE}/archive?page=${n}`] = html(page(n, `/archive?page=${n + 1}`));
    for (let n = 1; n < 50; n++) endless[`${SITE}/p/page${n}-issue`] = html(fixture("issue-full.html").replace(/ledger-issue-3/g, `page${n}-issue`));
    const a = clockedWeb(endless);
    const r = await webArchiveSource(archive({ knownUrls: ["url:https://letters.example/p/older"] }), a.fetcher, { pacer: a.pacer, now: () => NOW }).pull(pullOpts());
    const indexHits = requested(a.web).filter((u) => u.includes("/archive"));
    expect(indexHits).toEqual([`${SITE}/archive`, `${SITE}/archive?page=2`, `${SITE}/archive?page=3`]);
    expect(r.listed).toBe(3);

    // A loop: page 2 points back at page 1.
    const loop = clockedWeb({
      [`${SITE}/archive`]: html(page(1, "/archive?page=2")),
      [`${SITE}/archive?page=2`]: html(page(2, "/archive")),
      [`${SITE}/p/page1-issue`]: html(fixture("issue-full.html")),
      [`${SITE}/p/page2-issue`]: html(fixture("issue-full.html")),
    });
    await webArchiveSource(archive({ knownUrls: ["url:https://letters.example/p/older"] }), loop.fetcher, { pacer: loop.pacer, now: () => NOW }).pull(pullOpts());
    expect(requested(loop.web).filter((u) => u.includes("/archive"))).toEqual([`${SITE}/archive`, `${SITE}/archive?page=2`]);

    // A first pull never paginates.
    const first = clockedWeb(endless);
    await webArchiveSource(archive(), first.fetcher, { pacer: first.pacer, now: () => NOW }).pull(pullOpts({ firstPull: true }));
    expect(requested(first.web).filter((u) => u.includes("/archive"))).toEqual([`${SITE}/archive`]);
  });

  it("uses a news sitemap advertised in robots.txt when the page lists no issues itself", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/robots.txt`]: text(`User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap-news.xml\nSitemap: https://elsewhere.example/sitemap.xml\n`),
      [`${SITE}/`]: html("<html><body><main><p>Read our invented newsletter.</p></main></body></html>"),
      [`${SITE}/sitemap-news.xml`]: { status: 200, headers: { "content-type": "application/xml" }, body: fixture("sitemap-news.xml") },
      ...issueRoutes(),
    });
    const r = await webArchiveSource(archive({ archiveUrl: `${SITE}/` }), fetcher, { pacer, now: () => NOW }).pull(pullOpts());
    expect(r.items.map((i) => i.key)).toEqual([`url:${SITE}/p/ledger-issue-3`, `url:${SITE}/p/ledger-issue-2`]);
    expect(web.lookups).not.toContain("elsewhere.example");
  });

  it("a 304 on the archive page reads nothing more", async () => {
    const { web, pacer, fetcher } = clockedWeb({ [`${SITE}/archive`]: { status: 304 } });
    const r = await webArchiveSource(archive({ etag: '"v1"' }), fetcher, { pacer }).pull(pullOpts());
    expect(r.cache?.notModified).toBe(true);
    expect(requested(web)).toEqual([`${SITE}/robots.txt`, `${SITE}/archive`]);
    expect(web.requests[1].headers["if-none-match"]).toBe('"v1"');
  });

  it("a refused or non-HTML archive page fails with a short code", async () => {
    const refused = clockedWeb({ [`${SITE}/archive`]: { status: 403, body: "no" } });
    await expect(webArchiveSource(archive(), refused.fetcher, { pacer: refused.pacer }).pull(pullOpts())).rejects.toEqual(new SourceFetchError("http_403"));
    const json = clockedWeb({ [`${SITE}/archive`]: { status: 200, headers: { "content-type": "application/json" }, body: "{}" } });
    await expect(webArchiveSource(archive(), json.fetcher, { pacer: json.pacer }).pull(pullOpts())).rejects.toEqual(new SourceFetchError("not_html"));
  });
});

describe("discovery's archive fallback", () => {
  const ENTRY: CatalogEntry = {
    id: "invented-ledger",
    name: "The Invented Ledger",
    homepageUrl: `${SITE}/`,
    feedUrl: null,
    archiveUrl: `${SITE}/archive`,
    verified: false,
  };

  it("a site with no feed: its homepage listing issues is offered as an archive, with the issues found", async () => {
    const { web, pacer, fetcher } = clockedWeb({ [`${SITE}/`]: html(fixture("index-heuristic.html")) });
    const r = await discoverFeed("letters.example", fetcher, [], { pacer });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.feed).toMatchObject({ feedUrl: `${SITE}/`, format: "archive", title: "Notes from an Invented Desk", itemCount: 3, latestIssueAt: null });
    expect(r.feed.archive?.method).toBe("heuristic");
    expect(r.feed.archive?.issues.map((i) => i.title)).toEqual(["Desk issue 3: invented sensors", "Desk issue 2: invented ports", "Desk issue 1: invented beginnings"]);
    // No issue page is fetched during discovery.
    expect(requested(web).some((u) => u.includes("/p/"))).toBe(false);
  });

  it("the catalog's archiveUrl is used when the site has no feed", async () => {
    const { pacer, fetcher } = clockedWeb({ [`${SITE}/`]: { status: 404 }, [`${SITE}/archive`]: html(fixture("index-jsonld.html")) });
    const r = await discoverFeed("invented-ledger", fetcher, [ENTRY], { pacer });
    expect(r.ok && r.feed).toMatchObject({ feedUrl: `${SITE}/archive`, format: "archive", title: "The Invented Ledger", catalogId: "invented-ledger", latestIssueAt: "2026-11-23T06:00:00.000Z" });
  });

  it("a feed still wins: the archive is not tried when a feed exists", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/`]: html(`${fixture("index-jsonld.html")}<link rel="alternate" type="application/rss+xml" href="/feed/">`),
      [`${SITE}/feed/`]: rss(feedFixture("rss-full.xml")),
    });
    const r = await discoverFeed("letters.example", fetcher, [], { pacer });
    expect(r.ok && r.feed.format).toBe("rss");
    expect(requested(web)).toEqual([`${SITE}/robots.txt`, `${SITE}/`, `${SITE}/feed/`]);
  });

  it("a page with one stray link is not an archive", async () => {
    const { pacer, fetcher } = clockedWeb({ [`${SITE}/`]: html('<main><a href="/p/only-one-post-here">Only one invented post here</a></main>') });
    const r = await discoverFeed("letters.example", fetcher, [], { pacer });
    expect(r).toMatchObject({ ok: false, reason: "no_feed" });
  });

  it("robots.txt blocking the site means no archive either", async () => {
    const { web, pacer, fetcher } = clockedWeb({ [`${SITE}/robots.txt`]: text("User-agent: *\nDisallow: /\n"), [`${SITE}/`]: html(fixture("index-heuristic.html")) });
    const r = await discoverFeed("letters.example", fetcher, [], { pacer });
    expect(r).toMatchObject({ ok: false, reason: "no_feed", startError: "robots_disallowed" });
    expect(requested(web)).toEqual([`${SITE}/robots.txt`]);
  });

  it("a name resolving to a private address sends nothing, archive included", async () => {
    const { web, pacer, fetcher } = clockedWeb({});
    web.dns.set("letters.example", ["10.0.0.7"]);
    const r = await discoverFeed("letters.example", fetcher, [], { pacer });
    expect(r).toMatchObject({ ok: false });
    expect(web.requests).toEqual([]);
  });
});
