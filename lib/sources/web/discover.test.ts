import { describe, expect, it } from "vitest";
import rawCatalog from "../../../data/newsletter-catalog.json";
import { createFakeWeb, feedFixture, rss } from "../../../tests/web/fake-web";
import { catalogLookup, loadCatalog, searchCatalog, validateCatalog, type CatalogEntry } from "./catalog";
import { COMMON_FEED_PATHS, discoverFeed, feedLinksInHtml, MAX_CANDIDATES, toUrl } from "./discover";
import { createWebFetcher } from "./fetcher";

const html = (body: string) => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body });

const CATALOG: CatalogEntry[] = [
  { id: "invented-ledger", name: "The Invented Ledger", aliases: ["Ledger"], homepageUrl: "https://ledger.example/", feedUrl: "https://ledger.example/feed/", verified: false },
  { id: "bits", name: "Bits & Bobs", homepageUrl: "https://bits.example/", feedUrl: null, verified: false },
];

describe("toUrl", () => {
  it("accepts domains and URLs, refuses free text", () => {
    expect(toUrl("ledger.example")?.toString()).toBe("https://ledger.example/");
    expect(toUrl("http://ledger.example/feed")?.toString()).toBe("http://ledger.example/feed");
    expect(toUrl("Morning Brew")).toBeNull();
    expect(toUrl("intranet")).toBeNull();
    expect(toUrl("")).toBeNull();
  });
});

describe("feedLinksInHtml", () => {
  it("finds RSS and Atom alternates in order, resolved against the page, and ignores other types", () => {
    expect(feedLinksInHtml(feedFixture("homepage.html"), "https://ledger.example/")).toEqual([
      "https://ledger.example/feed/",
      "https://ledger.example/comments/atom.xml",
    ]);
  });
});

describe("discoverFeed", () => {
  it("a URL that is itself a feed is taken as it is (after redirects)", async () => {
    const web = createFakeWeb({
      routes: {
        "https://ledger.example/rss": { status: 301, headers: { location: "https://ledger.example/feed/" } },
        "https://ledger.example/feed/": rss(feedFixture("rss-full.xml")),
      },
    });
    const r = await discoverFeed("https://ledger.example/rss", createWebFetcher(web));
    expect(r).toEqual({
      ok: true,
      feed: {
        feedUrl: "https://ledger.example/feed/",
        format: "rss",
        title: "The Invented Ledger",
        homepageUrl: "https://ledger.example/",
        itemCount: 3,
        catalogId: null,
      },
    });
  });

  it("a homepage: follows its <link rel=alternate> feed", async () => {
    const web = createFakeWeb({
      routes: {
        "https://ledger.example/": html(feedFixture("homepage.html")),
        "https://ledger.example/feed/": rss(feedFixture("rss-full.xml")),
      },
    });
    const r = await discoverFeed("ledger.example", createWebFetcher(web));
    expect(r.ok && r.feed.feedUrl).toBe("https://ledger.example/feed/");
  });

  it("a homepage with no advertised feed: tries the common paths (Ghost /rss)", async () => {
    const web = createFakeWeb({
      routes: {
        "https://ghost.example/": html("<html><head><title>x</title></head></html>"),
        "https://ghost.example/rss": { status: 301, headers: { location: "https://ghost.example/rss/" } },
        "https://ghost.example/rss/": rss(feedFixture("rss-full.xml")),
      },
    });
    const r = await discoverFeed("https://ghost.example/", createWebFetcher(web));
    expect(r.ok && r.feed.feedUrl).toBe("https://ghost.example/rss/");
    expect(web.requests.map((q) => q.url.pathname)).toEqual(["/robots.txt", "/", "/feed", "/rss", "/rss/"]);
  });

  it("Substack-style /feed on a homepage that fails to load", async () => {
    const web = createFakeWeb({
      routes: {
        "https://letter.example/": { status: 503 },
        "https://letter.example/feed": rss(feedFixture("rss-teaser.xml")),
      },
    });
    const r = await discoverFeed("letter.example", createWebFetcher(web));
    expect(r.ok && r.feed.feedUrl).toBe("https://letter.example/feed");
  });

  it("a catalog name uses the catalog's feed URL", async () => {
    const web = createFakeWeb({ routes: { "https://ledger.example/feed/": rss(feedFixture("rss-full.xml")) } });
    const r = await discoverFeed("the invented ledger", createWebFetcher(web), CATALOG);
    expect(r).toMatchObject({ ok: true, feed: { catalogId: "invented-ledger", homepageUrl: "https://ledger.example/" } });
    expect(web.requests.map((q) => q.url.pathname)).toEqual(["/robots.txt", "/feed/"]);
  });

  it("a catalog entry whose feed URL fails falls back to discovering from its homepage", async () => {
    const web = createFakeWeb({
      routes: {
        "https://ledger.example/feed/": { status: 404 },
        "https://ledger.example/": html('<link rel="alternate" type="application/atom+xml" href="/atom.xml">'),
        "https://ledger.example/atom.xml": { status: 200, headers: { "content-type": "application/atom+xml" }, body: feedFixture("atom.xml") },
      },
    });
    const r = await discoverFeed("Ledger", createWebFetcher(web), CATALOG);
    expect(r).toMatchObject({ ok: true, feed: { feedUrl: "https://ledger.example/atom.xml", format: "atom", catalogId: "invented-ledger" } });
  });

  it("free text that is not in the catalog is not_found (no web search)", async () => {
    const web = createFakeWeb();
    expect(await discoverFeed("Some Newsletter I Like", createWebFetcher(web), CATALOG)).toEqual({ ok: false, reason: "not_found" });
    expect(web.requests).toHaveLength(0);
  });

  it("gives up after MAX_CANDIDATES fetches with no feed", async () => {
    const web = createFakeWeb({ routes: { "https://nofeed.example/": html("<p>nothing</p>") } });
    const r = await discoverFeed("nofeed.example", createWebFetcher(web));
    expect(r).toMatchObject({ ok: false, reason: "no_feed" });
    const pages = web.requests.filter((q) => q.url.pathname !== "/robots.txt");
    expect(pages.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(pages.length).toBe(1 + COMMON_FEED_PATHS.length);
  });

  it("refuses private and local targets without fetching them", async () => {
    for (const input of ["http://127.0.0.1/feed", "localhost", "http://[::1]/", "http://169.254.169.254/latest/"]) {
      const web = createFakeWeb();
      const r = await discoverFeed(input, createWebFetcher(web));
      expect(r.ok).toBe(false);
      expect(web.requests).toHaveLength(0);
    }
    const web = createFakeWeb({ dns: { "sneaky.example": ["10.0.0.1"] } });
    const r = await discoverFeed("sneaky.example", createWebFetcher(web));
    expect(r).toMatchObject({ ok: false, reason: "no_feed", lastError: "blocked_address" });
    expect(web.requests).toHaveLength(0);
  });

  it("a feed link on a page that points at a private address is refused", async () => {
    const web = createFakeWeb({
      dns: { "evil.example": ["192.168.0.10"] },
      routes: { "https://page.example/": html('<link rel="alternate" type="application/rss+xml" href="https://evil.example/feed">') },
    });
    const r = await discoverFeed("page.example", createWebFetcher(web));
    expect(r.ok).toBe(false);
    expect(web.requests.map((q) => q.url.hostname)).not.toContain("evil.example");
  });

  it("respects robots.txt during discovery", async () => {
    const web = createFakeWeb({
      routes: {
        "https://ledger.example/robots.txt": { body: "User-agent: *\nDisallow: /\n" },
        "https://ledger.example/feed/": rss(feedFixture("rss-full.xml")),
      },
    });
    const r = await discoverFeed("https://ledger.example/feed/", createWebFetcher(web));
    expect(r).toMatchObject({ ok: false, lastError: "robots_disallowed" });
    expect(web.requests.map((q) => q.url.pathname)).toEqual(["/robots.txt"]);
  });
});

describe("catalog", () => {
  it("data/newsletter-catalog.json is valid and every entry is unverified until checked live", () => {
    expect(validateCatalog(rawCatalog)).toEqual([]);
    const entries = loadCatalog();
    expect(entries.length).toBeGreaterThanOrEqual(13);
    for (const id of ["techcrunch", "strictlyvc", "morning-brew"]) expect(entries.map((e) => e.id)).toContain(id);
    // Nothing was reachable when these were written; only verify:catalog may flip this.
    for (const e of entries) expect(e.verified, e.id).toBe(false);
    for (const e of entries) if (e.feedUrl) expect(e.note, `${e.id} needs a note saying where its feed URL came from`).toBeTruthy();
  });

  it("validation catches malformed entries", () => {
    expect(validateCatalog({ entries: [{ id: "x", name: "", homepageUrl: "http://a.example", feedUrl: "ftp://a", verified: "no" }] })).toEqual(
      expect.arrayContaining([
        expect.stringContaining("id"),
        expect.stringContaining("name"),
        expect.stringContaining("homepageUrl"),
        expect.stringContaining("feedUrl"),
        expect.stringContaining("verified"),
      ]),
    );
    expect(validateCatalog({ entries: [CATALOG[0], CATALOG[0]] })).toEqual([expect.stringContaining("duplicated")]);
    expect(validateCatalog(null)).not.toEqual([]);
  });

  it("looks up by id, name or alias ignoring case and punctuation, or by bare homepage host", () => {
    expect(catalogLookup(CATALOG, "invented-ledger")?.id).toBe("invented-ledger");
    expect(catalogLookup(CATALOG, "THE INVENTED LEDGER")?.id).toBe("invented-ledger");
    expect(catalogLookup(CATALOG, "ledger")?.id).toBe("invented-ledger");
    expect(catalogLookup(CATALOG, "bits and bobs")).toBeNull();
    expect(catalogLookup(CATALOG, "Bits & Bobs")?.id).toBe("bits");
    expect(catalogLookup(CATALOG, "https://www.ledger.example/")?.id).toBe("invented-ledger");
    expect(catalogLookup(CATALOG, "ledger.example/some/other/page")).toBeNull();
    expect(catalogLookup(CATALOG, "")).toBeNull();
  });

  it("searches names and aliases for the picker", () => {
    expect(searchCatalog(loadCatalog(), "brew").map((e) => e.id)).toEqual(["morning-brew"]);
    expect(searchCatalog(loadCatalog(), "strictly").map((e) => e.id)).toEqual(["strictlyvc"]);
    expect(searchCatalog(loadCatalog(), "   ")).toEqual([]);
  });
});
