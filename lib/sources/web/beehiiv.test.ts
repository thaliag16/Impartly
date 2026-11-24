// beehiiv-hosted newsletters: platform detection, the publication's rss.beehiiv.com feed
// when the publisher links one, the /archive page, and the site's /sitemap.xml with its
// /p/<slug> issue URLs. Every page is invented (fixtures/archives/beehiiv-*, .example
// hosts); the only real host name is beehiiv's own, given to the fake DNS so nothing
// connects anywhere. Time is a fake clock: the pacer's waits are recorded, never slept.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeWeb, feedFixture, PUBLIC_V4, rss, type Route } from "../../../tests/web/fake-web";
import { issueLinksFromSitemap, parseSitemap } from "./archive";
import { createPacer, webArchiveSource, type StoredArchive } from "./archive-source";
import { discoverFeed } from "./discover";
import { createWebFetcher } from "./fetcher";
import { BEEHIIV_ISSUE_PATH, beehiivFeedLinks, detectPlatform } from "./platforms";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/archives");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
const html = (body: string): Route => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body });
const xml = (body: string): Route => ({ status: 200, headers: { "content-type": "application/xml" }, body });
const text = (body: string): Route => ({ status: 200, headers: { "content-type": "text/plain" }, body });

const SITE = "https://brief.example";
const NOW = new Date("2026-11-23T12:00:00Z");
const RSS_HOST = "rss.beehiiv.com";

function clockedWeb(routes: Record<string, Route>) {
  let t = 1_000_000;
  const web = createFakeWeb({ routes, dns: { [RSS_HOST]: [PUBLIC_V4] } });
  const pacer = createPacer({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  return { web, pacer, fetcher: createWebFetcher(web) };
}
const requested = (web: { requests: { url: URL }[] }) => web.requests.map((r) => r.url.toString());

describe("detectPlatform", () => {
  it("recognises a beehiiv page by its generator tag or beehiiv-hosted assets", () => {
    expect(detectPlatform(fixture("beehiiv-home.html"), `${SITE}/`)).toBe("beehiiv");
    expect(detectPlatform(fixture("beehiiv-archive-shell.html"), `${SITE}/archive`)).toBe("beehiiv");
    expect(detectPlatform('<img src="https://media.beehiiv.com/uploads/x.png">', `${SITE}/`)).toBe("beehiiv");
    expect(detectPlatform('<meta name="generator" content="beehiiv">', `${SITE}/`)).toBe("beehiiv");
  });

  it("a page on a *.beehiiv.com subdomain is beehiiv", () => {
    expect(detectPlatform("<p>hi</p>", "https://invented.beehiiv.com/")).toBe("beehiiv");
  });

  it("other pages are not, even ones that mention beehiiv in text or link to its homepage", () => {
    expect(detectPlatform(fixture("index-heuristic.html"), `${SITE}/`)).toBeNull();
    expect(detectPlatform("<p>We read https://media.beehiiv.com/ posts and love beehiiv.</p>", `${SITE}/`)).toBeNull();
    expect(detectPlatform('<a href="https://www.beehiiv.com/">Start your own newsletter</a>', `${SITE}/`)).toBeNull();
    expect(detectPlatform('<img src="https://media.beehiiv.com.evil.example/x.png">', `${SITE}/`)).toBeNull();
    expect(detectPlatform("<p>hi</p>", "https://notbeehiiv.com/")).toBeNull();
  });
});

describe("beehiivFeedLinks", () => {
  it("finds links to the publication's rss.beehiiv.com feed, and nothing else", () => {
    const page = `
      <a href="https://rss.beehiiv.com/feeds/AbC123xyz.xml">RSS</a>
      <a href="https://rss.beehiiv.com/feeds/AbC123xyz.xml">RSS again</a>
      <a href="http://rss.beehiiv.com/feeds/plain.xml">Plain http</a>
      <a href="https://rss.beehiiv.com/other/thing.xml">Not a feed path</a>
      <a href="https://rss.beehiiv.com.evil.example/feeds/x.xml">Look-alike host</a>
      <a href="https://brief.example/feeds/x.xml">Same site, not beehiiv</a>`;
    expect(beehiivFeedLinks(page)).toEqual(["https://rss.beehiiv.com/feeds/AbC123xyz.xml"]);
  });
});

describe("sitemaps on a beehiiv site", () => {
  it("with the beehiiv issue path, /p/<slug> entries count as issues, newest first; pages, comments and other sites do not", () => {
    const sm = parseSitemap(fixture("beehiiv-sitemap.xml"));
    expect(issueLinksFromSitemap(sm, `${SITE}/archive`)).toEqual([]);
    const links = issueLinksFromSitemap(sm, `${SITE}/archive`, { issuePath: BEEHIIV_ISSUE_PATH });
    expect(links.map((l) => [l.url, l.published])).toEqual([
      [`${SITE}/p/invented-markets-slide`, "2026-11-20T06:00:00.000Z"],
      [`${SITE}/p/invented-fund-closes`, "2026-11-19T06:00:00.000Z"],
      [`${SITE}/p/invented-round-up`, "2026-11-18T06:00:00.000Z"],
    ]);
  });
});

describe("discovery on a beehiiv site", () => {
  it("follows the publication's rss.beehiiv.com feed linked from the homepage", async () => {
    const page = fixture("beehiiv-home.html").replace("</footer>", '<a href="https://rss.beehiiv.com/feeds/AbC123xyz.xml">RSS</a></footer>');
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/`]: html(page),
      [`https://${RSS_HOST}/feeds/AbC123xyz.xml`]: rss(feedFixture("rss-full.xml")),
    });
    const r = await discoverFeed("brief.example", fetcher, [], { pacer });
    expect(r.ok && r.feed).toMatchObject({ feedUrl: `https://${RSS_HOST}/feeds/AbC123xyz.xml`, format: "rss" });
    expect(requested(web)).not.toContain(`${SITE}/archive`);
  });

  it("no feed and a homepage showing only the latest issue: the /archive page is offered as the archive", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/`]: html(fixture("beehiiv-home.html")),
      [`${SITE}/archive`]: html(fixture("beehiiv-archive.html")),
    });
    const r = await discoverFeed("brief.example", fetcher, [], { pacer });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.feed).toMatchObject({ feedUrl: `${SITE}/archive`, format: "archive", homepageUrl: `${SITE}/`, itemCount: 3 });
    expect(r.feed.archive?.issues.map((i) => i.url)).toEqual([
      `${SITE}/p/invented-markets-slide`,
      `${SITE}/p/invented-fund-closes`,
      `${SITE}/p/invented-round-up`,
    ]);
    // Sign-in and subscribe pages are never requested; no issue page is fetched in discovery.
    expect(requested(web).some((u) => /\/(login|subscribe)|\/p\//.test(u))).toBe(false);
  });

  it("an archive page with no links in its HTML: the site's /sitemap.xml gives the dated issues", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/`]: html(fixture("beehiiv-home.html")),
      [`${SITE}/archive`]: html(fixture("beehiiv-archive-shell.html")),
      [`${SITE}/sitemap.xml`]: xml(fixture("beehiiv-sitemap.xml")),
    });
    const r = await discoverFeed("brief.example", fetcher, [], { pacer });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.feed).toMatchObject({ feedUrl: `${SITE}/archive`, format: "archive", itemCount: 3, latestIssueAt: "2026-11-20T06:00:00.000Z" });
    expect(r.feed.archive?.method).toBe("sitemap");
    expect(requested(web).filter((u) => u === `${SITE}/sitemap.xml`)).toHaveLength(1);
  });

  it("robots.txt is respected: a disallowed /archive and /sitemap.xml are never requested", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/robots.txt`]: text("User-agent: *\nDisallow: /archive\nDisallow: /sitemap.xml\n"),
      [`${SITE}/`]: html(fixture("beehiiv-home.html")),
      [`${SITE}/archive`]: html(fixture("beehiiv-archive.html")),
      [`${SITE}/sitemap.xml`]: xml(fixture("beehiiv-sitemap.xml")),
    });
    const r = await discoverFeed("brief.example", fetcher, [], { pacer });
    expect(r).toMatchObject({ ok: false, reason: "no_feed" });
    expect(requested(web)).not.toContain(`${SITE}/archive`);
    expect(requested(web)).not.toContain(`${SITE}/sitemap.xml`);
  });

  it("a site that is not beehiiv gets no /archive or /sitemap.xml guesses", async () => {
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/`]: html('<main><a href="/p/only-one-post-here">Only one invented post here</a></main>'),
      [`${SITE}/archive`]: html(fixture("beehiiv-archive.html")),
      [`${SITE}/sitemap.xml`]: xml(fixture("beehiiv-sitemap.xml")),
    });
    const r = await discoverFeed("brief.example", fetcher, [], { pacer });
    expect(r).toMatchObject({ ok: false, reason: "no_feed" });
    expect(requested(web)).not.toContain(`${SITE}/archive`);
    expect(requested(web)).not.toContain(`${SITE}/sitemap.xml`);
  });
});

describe("the archive source on a beehiiv archive", () => {
  const stored = (o: Partial<StoredArchive> = {}): StoredArchive => ({
    id: "b1",
    archiveUrl: `${SITE}/archive`,
    title: "The Invented Brief",
    etag: null,
    lastModified: null,
    knownUrls: [],
    ...o,
  });

  it("reads issues from the sitemap when the archive page has no links, newest first, by /p/ URL", async () => {
    const issue = fixture("issue-full.html");
    const { web, pacer, fetcher } = clockedWeb({
      [`${SITE}/archive`]: html(fixture("beehiiv-archive-shell.html")),
      [`${SITE}/sitemap.xml`]: xml(fixture("beehiiv-sitemap.xml")),
      [`${SITE}/p/invented-markets-slide`]: html(issue.replace(/https:\/\/letters\.example\/p\/ledger-issue-3/g, `${SITE}/p/invented-markets-slide`)),
      [`${SITE}/p/invented-fund-closes`]: html(issue.replace(/https:\/\/letters\.example\/p\/ledger-issue-3/g, `${SITE}/p/invented-fund-closes`)),
    });
    const r = await webArchiveSource(stored({ knownUrls: [`${SITE}/p/invented-round-up`] }), fetcher, { pacer, now: () => NOW }).pull({
      since: new Date("2026-11-01T00:00:00Z"),
      limit: 50,
      maxChars: 20_000,
      firstPull: false,
    });
    expect(r.items.map((i) => i.key)).toEqual([`url:${SITE}/p/invented-markets-slide`, `url:${SITE}/p/invented-fund-closes`]);
    expect(requested(web).every((u) => u.startsWith(`${SITE}/`))).toBe(true);
    expect(requested(web)).not.toContain(`${SITE}/p/invented-round-up`);
  });
});
