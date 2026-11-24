import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import rawCatalog from "../../../data/newsletter-catalog.json";
import { createFakeWeb, feedFixture, rss } from "../../../tests/web/fake-web";
import { catalogLookup, loadCatalog, searchCatalog, validateCatalog, type CatalogEntry } from "./catalog";
import { COMMON_FEED_PATHS, discoverFeed, feedLinksInHtml, latestDate, MAX_CANDIDATES, toUrl } from "./discover";
import { createPacer } from "./archive-source";
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
        latestIssueAt: "2026-11-23T12:00:00.000Z",
        catalogId: null,
      },
    });
  });

  it("latestDate picks the newest parseable date, or null", () => {
    expect(latestDate(["2026-11-22T08:00:00Z", undefined, "2026-11-23T09:00:00Z", "not a date"])).toBe("2026-11-23T09:00:00.000Z");
    expect(latestDate([undefined, "nope"])).toBeNull();
    expect(latestDate([])).toBeNull();
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

  it("an archive-only catalog entry reads its archive page and never tries the site's own feeds", async () => {
    // A site-wide feed advertised on every page is not the newsletter (Fortune / Term Sheet,
    // run 20): discovery must go straight to the archive the catalog names.
    const sheet: CatalogEntry = {
      id: "invented-sheet",
      name: "Invented Sheet",
      homepageUrl: "https://bigmag.example/newsletters/sheet/",
      feedUrl: null,
      archiveUrl: "https://bigmag.example/topic/invented-sheet/",
      archiveOnly: true,
      verified: false,
    };
    const siteFeed = '<link rel="alternate" type="application/rss+xml" href="https://bigmag.example/feed/">';
    const web = createFakeWeb({
      routes: {
        "https://bigmag.example/newsletters/sheet/": html(siteFeed),
        "https://bigmag.example/feed/": rss(feedFixture("rss-full.xml")),
        "https://bigmag.example/topic/invented-sheet/": html(`${siteFeed}
          <article><h2><a href="/2026/11/23/invented-sheet-recap/">Recap: an invented week</a></h2><time datetime="2026-11-23T12:00:00Z">Nov 23</time></article>
          <article><h2><a href="/2026/11/20/invented-sheet-bellwether/">An invented bellwether</a></h2><time datetime="2026-11-20T12:00:00Z">Nov 20</time></article>`),
      },
    });
    const r = await discoverFeed("Invented Sheet", createWebFetcher(web), [sheet], { pacer: createPacer({ sleep: async () => {} }) });
    expect(r).toMatchObject({
      ok: true,
      feed: { format: "archive", feedUrl: "https://bigmag.example/topic/invented-sheet", catalogId: "invented-sheet", itemCount: 2, homepageUrl: "https://bigmag.example/newsletters/sheet/" },
    });
    const paths = web.requests.map((q) => q.url.pathname);
    expect(paths).not.toContain("/feed/");
    expect(paths).not.toContain("/newsletters/sheet/");
    for (const p of COMMON_FEED_PATHS) expect(paths).not.toContain(p);
  });

  it("an archive-only entry whose archive lists nothing is no_feed, not the site's feed", async () => {
    const sheet: CatalogEntry = { id: "invented-sheet", name: "Invented Sheet", homepageUrl: "https://bigmag.example/", feedUrl: null, archiveUrl: "https://bigmag.example/topic/invented-sheet/", archiveOnly: true, verified: false };
    const web = createFakeWeb({
      routes: {
        "https://bigmag.example/": html('<link rel="alternate" type="application/rss+xml" href="/feed/">'),
        "https://bigmag.example/feed/": rss(feedFixture("rss-full.xml")),
        "https://bigmag.example/topic/invented-sheet/": html("<p>Nothing listed today.</p>"),
      },
    });
    const r = await discoverFeed("invented-sheet", createWebFetcher(web), [sheet], { pacer: createPacer({ sleep: async () => {} }) });
    expect(r).toMatchObject({ ok: false, reason: "no_feed" });
    expect(web.requests.map((q) => q.url.pathname)).not.toContain("/feed/");
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
  // The entries a live catalog check (`npm run verify:catalog`, a GitHub Actions run) showed
  // working, with the run that showed it. Changing this list is a reviewed edit: add an id
  // here only with the run id and date in the catalog and the run named in PROGRESS.md.
  const VERIFIED: Record<string, number> = {
    techcrunch: 45333404039,
    stratechery: 45333404039,
    "lennys-newsletter": 45333404039,
    "not-boring": 45333404039,
    platformer: 45333404039,
    "exponential-view": 45333404039,
    "pragmatic-engineer": 45333404039,
    "tomasz-tunguz": 45333404039,
    "the-generalist": 45333404039,
    "benedict-evans": 45333404039,
    strictlyvc: 45337784590,
  };

  it("data/newsletter-catalog.json is valid, and its verified entries are exactly the ones a recorded live run backs", () => {
    expect(validateCatalog(rawCatalog)).toEqual([]);
    const entries = loadCatalog();
    expect(entries.length).toBeGreaterThanOrEqual(13);
    for (const id of ["techcrunch", "strictlyvc", "morning-brew"]) expect(entries.map((e) => e.id)).toContain(id);
    expect(entries.filter((e) => e.verified).map((e) => e.id).sort()).toEqual(Object.keys(VERIFIED).sort());
    const progress = readFileSync(new URL("../../../PROGRESS.md", import.meta.url), "utf8");
    // The first catalog check ran on 2026-11-23 (UTC); nothing can be verified before it or in the future.
    const first = Date.parse("2026-11-23T00:00:00Z");
    for (const e of entries.filter((x) => x.verified)) {
      expect(e.verifiedRunId, e.id).toBe(VERIFIED[e.id]);
      expect(e.verifiedAt, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const at = Date.parse(`${e.verifiedAt}T00:00:00Z`);
      expect(at >= first && at <= Date.now(), `${e.id} verifiedAt ${e.verifiedAt}`).toBe(true);
      expect(progress, `${e.id}: run ${e.verifiedRunId} must be logged in PROGRESS.md`).toContain(String(e.verifiedRunId));
      expect(e.unavailable, e.id).toBeUndefined();
      // A verified feed entry names its feed; a verified archive entry names its archive.
      expect(e.feedUrl ?? e.archiveUrl, e.id).toBeTruthy();
    }
    for (const e of entries.filter((x) => !x.verified)) {
      expect(e.verifiedAt, e.id).toBeUndefined();
      expect(e.verifiedRunId, e.id).toBeUndefined();
    }
    for (const e of entries) if (e.feedUrl) expect(e.note, `${e.id} needs a note saying where its feed URL came from`).toBeTruthy();
  });

  it("Benedict Evans is labelled as his essays, not the weekly email, for the picker", () => {
    const be = loadCatalog().find((e) => e.id === "benedict-evans")!;
    expect(be.archiveUrl).toBe("https://www.ben-evans.com/benedictevans");
    expect(be.pickerNote).toMatch(/essays/i);
    expect(be.pickerNote).toMatch(/not the weekly (email )?newsletter/i);
  });

  it("StrictlyVC points at its beehiiv publication's public archive, not the stale strictlyvc.com feed", () => {
    const sv = loadCatalog().find((e) => e.id === "strictlyvc")!;
    expect(sv.homepageUrl).toBe("https://newsletter.strictlyvc.com/");
    expect(sv.archiveUrl).toBe("https://newsletter.strictlyvc.com/archive");
    expect(sv.feedUrl).toBeNull();
    for (const u of [sv.homepageUrl, sv.feedUrl, sv.archiveUrl]) expect(u ?? "").not.toMatch(/^https:\/\/strictlyvc\.com/);
  });

  it("Morning Brew is marked not readable on the web, with a picker note and no feed (the /stories feed stays out)", () => {
    const mb = loadCatalog().find((e) => e.id === "morning-brew")!;
    expect(mb.unavailable).toBe("not_on_web");
    expect(mb.verified).toBe(false);
    expect(mb.feedUrl).toBeNull();
    expect(mb.archiveUrl).toBeUndefined();
    expect(mb.pickerNote).toMatch(/forwarding is coming later/i);
    expect(JSON.stringify(mb)).not.toMatch(/utm_|mbcid|[?&][a-z_]+=/i);
  });

  it("Term Sheet reads Fortune's Term Sheet topic page as an archive only; the general Fortune feed is out of its path", () => {
    const ts = loadCatalog().find((e) => e.id === "fortune-term-sheet")!;
    expect(ts).toMatchObject({ feedUrl: null, archiveUrl: "https://fortune.com/topic/term-sheet/", archiveOnly: true, homepageUrl: "https://fortune.com/newsletters/termsheet/" });
    expect(ts.unavailable).toBeUndefined();
    expect(JSON.stringify(ts)).not.toContain("fortune-feeds");
    expect(JSON.stringify(ts)).not.toMatch(/utm_|[?&][a-z_]+=/i);
  });

  it("Axios Pro Rata stays findable but is marked unavailable, with no feed and no archive", () => {
    const ax = loadCatalog().find((e) => e.id === "axios-pro-rata")!;
    expect(ax.unavailable).toBe("refuses_automated_access");
    expect(ax.verified).toBe(false);
    expect(ax.feedUrl).toBeNull();
    expect(ax.archiveUrl).toBeUndefined();
  });

  it("verification fields, unavailable and pickerNote are checked", () => {
    const base = { id: "x-1", name: "X", homepageUrl: "https://x.example/", feedUrl: null };
    expect(validateCatalog({ entries: [{ ...base, verified: true }] })).toEqual([expect.stringContaining("verifiedAt"), expect.stringContaining("verifiedRunId")]);
    expect(validateCatalog({ entries: [{ ...base, verified: true, verifiedAt: "2026-11-24", verifiedRunId: 0 }] })).toEqual([expect.stringContaining("verifiedRunId")]);
    expect(validateCatalog({ entries: [{ ...base, verified: true, verifiedAt: "24/11/2026", verifiedRunId: 1 }] })).toEqual([expect.stringContaining("verifiedAt")]);
    expect(validateCatalog({ entries: [{ ...base, verified: true, verifiedAt: "2026-11-24", verifiedRunId: 1 }] })).toEqual([]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, verifiedAt: "2026-11-24", verifiedRunId: 1 }] })).toEqual([expect.stringContaining("unverified")]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, unavailable: "refuses_automated_access" }] })).toEqual([]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, unavailable: "not_on_web" }] })).toEqual([]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, unavailable: "down" }] })).toEqual([expect.stringContaining("unavailable")]);
    expect(validateCatalog({ entries: [{ ...base, verified: true, verifiedAt: "2026-11-24", verifiedRunId: 1, unavailable: "refuses_automated_access" }] })).toEqual([expect.stringContaining("unavailable")]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, pickerNote: "x".repeat(201) }] })).toEqual([expect.stringContaining("pickerNote")]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, archiveOnly: true }] })).toEqual([expect.stringContaining("archiveOnly")]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, archiveOnly: true, archiveUrl: "https://a.example/archive", feedUrl: "https://a.example/feed" }] })).toEqual([expect.stringContaining("archiveOnly")]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, archiveOnly: "yes", archiveUrl: "https://a.example/archive" }] })).toEqual([expect.stringContaining("archiveOnly")]);
    expect(validateCatalog({ entries: [{ ...base, verified: false, archiveOnly: true, archiveUrl: "https://a.example/archive" }] })).toEqual([]);
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
