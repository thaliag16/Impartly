import { describe, expect, it } from "vitest";
import { createFakeWeb, rss } from "../../../tests/web/fake-web";
import { SourceFetchError } from "../types";
import { createWebFetcher, USER_AGENT } from "./fetcher";
import { isAllowedBy, parseRobots, policyAllows, policyFromResponse, rulesFor } from "./robots";

const rules = (text: string) => rulesFor(parseRobots(text), "impartly");

describe("robots.txt parsing and matching (RFC 9309)", () => {
  it("uses the Impartly group when there is one, else the * group", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: Impartly\nDisallow: /private\n";
    expect(isAllowedBy(rules(text), "/feed")).toBe(true);
    expect(isAllowedBy(rules(text), "/private/x")).toBe(false);
    expect(isAllowedBy(rules("User-agent: *\nDisallow: /\n"), "/feed")).toBe(false);
    expect(isAllowedBy(rules("User-agent: OtherBot\nDisallow: /\n"), "/feed")).toBe(true);
  });

  it("matches the product token case-insensitively, and a version suffix", () => {
    expect(isAllowedBy(rules("User-agent: IMPARTLY/1.0\nDisallow: /\n"), "/feed")).toBe(false);
  });

  it("merges groups that list several agents, and several groups for the same agent", () => {
    const text = "User-agent: a\nUser-agent: impartly\nDisallow: /one\n\nUser-agent: impartly\nDisallow: /two\n";
    expect(isAllowedBy(rules(text), "/one")).toBe(false);
    expect(isAllowedBy(rules(text), "/two")).toBe(false);
    expect(isAllowedBy(rules(text), "/three")).toBe(true);
  });

  it("longest match wins; Allow wins a tie", () => {
    const text = "User-agent: *\nDisallow: /news\nAllow: /news/feed\n";
    expect(isAllowedBy(rules(text), "/news/feed")).toBe(true);
    expect(isAllowedBy(rules(text), "/news/2026")).toBe(false);
    expect(isAllowedBy(rules("User-agent: *\nDisallow: /a\nAllow: /a\n"), "/a")).toBe(true);
  });

  it("supports * and $", () => {
    const text = "User-agent: *\nDisallow: /*.xml$\nDisallow: /private*/data\n";
    expect(isAllowedBy(rules(text), "/feed.xml")).toBe(false);
    expect(isAllowedBy(rules(text), "/feed.xml?x=1")).toBe(true);
    expect(isAllowedBy(rules(text), "/private-area/data")).toBe(false);
  });

  it("an empty Disallow allows everything; comments and unknown lines are ignored", () => {
    expect(isAllowedBy(rules("User-agent: * # all\nDisallow:\nCrawl-delay: 5\nSitemap: https://x.example/s.xml\n"), "/x")).toBe(true);
  });

  it("compares percent-encoding the RFC way", () => {
    expect(isAllowedBy(rules("User-agent: *\nDisallow: /%7Euser\n"), "/~user/feed")).toBe(false);
  });

  it("/robots.txt itself is always allowed", () => {
    expect(isAllowedBy(rules("User-agent: *\nDisallow: /\n"), "/robots.txt")).toBe(true);
  });

  it("unavailable (4xx) allows all; unreachable (5xx) disallows all", () => {
    const u = new URL("https://news.example/feed");
    expect(policyAllows(policyFromResponse(404, "", "impartly"), u)).toBe(true);
    expect(policyAllows(policyFromResponse(403, "", "impartly"), u)).toBe(true);
    expect(policyAllows(policyFromResponse(500, "", "impartly"), u)).toBe(false);
    expect(policyAllows(policyFromResponse(503, "", "impartly"), u)).toBe(false);
  });
});

describe("the polite fetcher", () => {
  const fail = async (p: Promise<unknown>) => {
    try {
      await p;
      return "no error";
    } catch (err) {
      return err instanceof SourceFetchError ? err.code : String(err);
    }
  };

  it("identifies itself with a user agent naming Impartly and the repository", async () => {
    const web = createFakeWeb({ routes: { "https://news.example/feed": rss("<rss/>") } });
    await createWebFetcher(web).get("https://news.example/feed", { accept: "*/*", maxBytes: 1000 });
    for (const r of web.requests) expect(r.headers["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^Impartly\/\S+ \(\+https:\/\/github\.com\/thaliag16\/impartly/);
  });

  it("refuses a URL robots.txt disallows for Impartly, and never requests it", async () => {
    const web = createFakeWeb({
      routes: {
        "https://news.example/robots.txt": { body: "User-agent: Impartly\nDisallow: /feed\n" },
        "https://news.example/feed": rss("<rss/>"),
      },
    });
    expect(await fail(createWebFetcher(web).get("https://news.example/feed", { accept: "*/*", maxBytes: 1000 }))).toBe(
      "robots_disallowed",
    );
    expect(web.requests.map((r) => r.url.pathname)).toEqual(["/robots.txt"]);
  });

  it("checks robots.txt of the site a redirect lands on", async () => {
    const web = createFakeWeb({
      routes: {
        "https://news.example/feed": { status: 301, headers: { location: "https://feeds.example/news" } },
        "https://feeds.example/robots.txt": { body: "User-agent: *\nDisallow: /\n" },
      },
    });
    expect(await fail(createWebFetcher(web).get("https://news.example/feed", { accept: "*/*", maxBytes: 1000 }))).toBe(
      "robots_disallowed",
    );
    expect(web.requests.map((r) => r.url.toString())).not.toContain("https://feeds.example/news");
  });

  it("treats a failing robots.txt (5xx or timeout) as disallow-all and says why", async () => {
    const web = createFakeWeb({ routes: { "https://down.example/robots.txt": { status: 503 }, "https://down.example/feed": rss("<rss/>") } });
    expect(await fail(createWebFetcher(web).get("https://down.example/feed", { accept: "*/*", maxBytes: 1000 }))).toBe(
      "robots_unreachable",
    );
  });

  it("reads robots.txt once per site per fetcher", async () => {
    const web = createFakeWeb({ routes: { "https://news.example/a": rss("<rss/>"), "https://news.example/b": rss("<rss/>") } });
    const f = createWebFetcher(web);
    await f.get("https://news.example/a", { accept: "*/*", maxBytes: 1000 });
    await f.get("https://news.example/b", { accept: "*/*", maxBytes: 1000 });
    expect(web.requests.filter((r) => r.url.pathname === "/robots.txt")).toHaveLength(1);
  });

  it("sends conditional GET validators and returns a 304 as it is", async () => {
    const web = createFakeWeb({
      routes: {
        "https://news.example/feed": (req) =>
          req.headers["if-none-match"] === '"v1"' ? { status: 304 } : rss("<rss/>", { etag: '"v1"' }),
      },
    });
    const res = await createWebFetcher(web).get("https://news.example/feed", {
      accept: "*/*",
      maxBytes: 1000,
      etag: '"v1"',
      lastModified: "Mon, 23 Nov 2026 10:00:00 GMT",
    });
    expect(res.status).toBe(304);
    const req = web.requests.at(-1)!;
    expect(req.headers["if-none-match"]).toBe('"v1"');
    expect(req.headers["if-modified-since"]).toBe("Mon, 23 Nov 2026 10:00:00 GMT");
  });

  it("sends no cookies or authorization", async () => {
    const web = createFakeWeb({ routes: { "https://news.example/feed": rss("<rss/>") } });
    await createWebFetcher(web).get("https://news.example/feed", { accept: "*/*", maxBytes: 1000 });
    for (const r of web.requests) {
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toEqual(expect.arrayContaining(["cookie"]));
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
  });
});
