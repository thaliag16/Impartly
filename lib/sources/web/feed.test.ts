// Feed parsing and the web feed source, on invented fixtures (fixtures/feeds) and a fake
// network. No real site is contacted.

import { describe, expect, it } from "vitest";
import { createFakeWeb, feedFixture, rss } from "../../../tests/web/fake-web";
import { SourceFetchError } from "../types";
import { createWebFetcher } from "./fetcher";
import { parseFeed } from "./feed-parser";
import { EXCERPT_MAX_CHARS, isPartial, itemKey, webFeedSource } from "./feed-source";

const NOW = new Date("2026-11-23T14:00:00Z");
const DAY = 24 * 3600_000;
const pullOpts = (overrides: Partial<{ since: Date; limit: number; maxChars: number; firstPull: boolean }> = {}) => ({
  since: new Date(NOW.getTime() - 2 * DAY),
  limit: 50,
  maxChars: 20_000,
  firstPull: false,
  ...overrides,
});

function sourceFor(feedUrl: string, body: string, extra: Record<string, string> = {}) {
  const web = createFakeWeb({ routes: { [feedUrl]: rss(body, extra) } });
  const src = webFeedSource({ id: "feed-1", feedUrl, title: null, etag: null, lastModified: null }, createWebFetcher(web), () => NOW);
  return { web, src };
}

describe("parseFeed", () => {
  it("reads RSS 2.0 with content:encoded, guid, dates and links", () => {
    const f = parseFeed(feedFixture("rss-full.xml"), "https://ledger.example/feed/")!;
    expect(f.format).toBe("rss");
    expect(f.title).toBe("The Invented Ledger");
    expect(f.siteUrl).toBe("https://ledger.example/");
    expect(f.items).toHaveLength(3);
    expect(f.items[0]).toMatchObject({
      id: "ledger-2026-11-23",
      link: "https://ledger.example/2026/11/23/larkspur",
      title: "Larkspur Robotics raises $40M & hires a CFO",
      published: "2026-11-23T12:00:00.000Z",
    });
    expect(f.items[0].content?.value).toContain("Juniper Peak Partners");
    expect(f.items[0].summary?.value).toContain("…");
    expect(f.items[1].published).toBe("2026-11-22T12:00:00.000Z");
  });

  it("reads Atom: xhtml, html and text content, relative links, published or updated", () => {
    const f = parseFeed(feedFixture("atom.xml"), "https://dispatch.example/atom.xml")!;
    expect(f.format).toBe("atom");
    expect(f.title).toBe("Signal & Noise Dispatch");
    expect(f.siteUrl).toBe("https://dispatch.example/");
    expect(f.items[0].link).toBe("https://dispatch.example/2026/fernbrook");
    expect(f.items[0].title).toBe("Fernbrook Energy <em>doubles</em> output");
    expect(f.items[0].content).toMatchObject({ type: "html" });
    expect(f.items[0].content?.value).toContain("<p>Fernbrook Energy doubled solar output");
    expect(f.items[0].published).toBe("2026-11-23T08:00:00.000Z");
    expect(f.items[1].published).toBe("2026-11-22T08:00:00.000Z"); // from <updated>
    expect(f.items[1].content).toEqual({
      type: "text",
      value: "Thistledown Foods recalled 2,000 invented jars of jam. <b>This is text, not markup.</b>",
    });
  });

  it("reads RSS 1.0 (RDF) with items beside the channel", () => {
    const f = parseFeed(feedFixture("rdf.xml"))!;
    expect(f.format).toBe("rss");
    expect(f.items[0]).toMatchObject({ id: "https://rdf.example/one", published: "2026-11-23T07:00:00.000Z" });
  });

  it("survives the usual mistakes: a bare &, HTML entities, no dates", () => {
    const f = parseFeed(feedFixture("malformed.xml"))!;
    expect(f.title).toBe("Bits & Bobs Daily");
    expect(f.items).toHaveLength(2);
    expect(f.items[0].published).toBeUndefined();
    expect(f.items[0].title).toContain("Undated newest item");
  });

  it("never expands DOCTYPE entities (no XXE, no entity bombs)", () => {
    const f = parseFeed(feedFixture("xxe.xml"))!;
    const all = JSON.stringify(f);
    expect(all).not.toContain("root:");
    expect(all).not.toContain("lollol");
    expect(f.items[0].title).toBe("Trap &xxe; &lol2;");
  });

  it("returns null for HTML, JSON or junk", () => {
    expect(parseFeed(feedFixture("homepage.html"))).toBeNull();
    expect(parseFeed('{"version":"https://jsonfeed.org/version/1.1"}')).toBeNull();
    expect(parseFeed("")).toBeNull();
    expect(parseFeed("<rss></rss>")).toBeNull(); // no channel
  });

  it("drops non-http links (javascript:, data:)", () => {
    const f = parseFeed(
      '<rss><channel><title>t</title><item><title>x</title><link>javascript:alert(1)</link></item></channel></rss>',
    )!;
    expect(f.items[0].link).toBeUndefined();
  });
});

describe("isPartial", () => {
  const item = (content?: string) => ({ title: "t", content: content ? { value: content, type: "html" as const } : undefined });

  it("full content with no paywall notice is not partial", () => {
    expect(isPartial(item("x".repeat(50)), "A complete short post.")).toBe(false);
  });
  it.each([
    "This post is for paid subscribers.",
    "Subscribe to continue reading.",
    "Keep reading with a 7-day free trial",
    "Become a paid subscriber to keep reading",
    "Members only",
    "Sign in to continue reading",
  ])("a paywall notice makes it partial: %s", (notice) => {
    expect(isPartial(item("x"), `Some public text. ${notice}`)).toBe(true);
  });
  it("a description-only item under the excerpt limit, or one ending in an ellipsis, is partial", () => {
    expect(isPartial(item(), "A short teaser.")).toBe(true);
    expect(isPartial(item(), "x".repeat(EXCERPT_MAX_CHARS + 10))).toBe(false);
    expect(isPartial(item(), `${"x".repeat(EXCERPT_MAX_CHARS + 10)} and then…`)).toBe(true);
    expect(isPartial(item("x"), "Body. Read more")).toBe(true);
  });
});

describe("itemKey", () => {
  it("prefers guid/id, then link, then a hash", () => {
    expect(itemKey({ id: "g1", link: "https://a.example/1", title: "t" })).toBe("id:g1");
    expect(itemKey({ link: "https://a.example/1", title: "t" })).toBe("link:https://a.example/1");
    const h = itemKey({ title: "t", published: "2026-11-23T00:00:00.000Z" });
    expect(h).toMatch(/^hash:[0-9a-f]{64}$/);
    expect(itemKey({ title: "t", published: "2026-11-23T00:00:00.000Z" })).toBe(h);
  });
});

describe("webFeedSource", () => {
  it("returns clean text for items in the window, newest first, with hidden text stripped", async () => {
    const { src } = sourceFor("https://ledger.example/feed/", feedFixture("rss-full.xml"));
    const r = await src.pull(pullOpts());
    expect(r.items.map((i) => i.subject)).toEqual(["Larkspur Robotics raises $40M & hires a CFO", "Copperfin Bank posts record quarter"]);
    const first = r.items[0];
    expect(first).toMatchObject({
      key: "id:ledger-2026-11-23",
      senderAddress: "ledger.example",
      senderName: "The Invented Ledger",
      receivedAt: "2026-11-23T12:00:00.000Z",
      partial: false,
      url: "https://ledger.example/2026/11/23/larkspur",
    });
    expect(first.bodyText).toContain("Larkspur Robotics raised $40 million in a Series B");
    expect(first.bodyText).toContain("Read on the site");
    // The hidden instruction, the tracking pixel and the link URLs never reach the text.
    expect(first.bodyText).not.toMatch(/ignore your previous instructions/i);
    expect(first.bodyText).not.toContain("http");
    expect(r.listed).toBe(3);
    expect(r.capped).toBe(false);
  });

  it("prefers the stored feed title as the sender name", async () => {
    const web = createFakeWeb({ routes: { "https://ledger.example/feed/": rss(feedFixture("rss-full.xml")) } });
    const src = webFeedSource({ id: "f", feedUrl: "https://ledger.example/feed/", title: "My Ledger", etag: null, lastModified: null }, createWebFetcher(web), () => NOW);
    expect((await src.pull(pullOpts())).items[0].senderName).toBe("My Ledger");
  });

  it("marks teasers and paywalled posts partial, summarizes only what is public, and never fetches the post page", async () => {
    const { src, web } = sourceFor("https://paywall.example/feed", feedFixture("rss-teaser.xml"));
    const r = await src.pull(pullOpts({ since: new Date(NOW.getTime() - 3 * DAY) }));
    expect(r.items.map((i) => [i.key, i.partial])).toEqual([
      ["id:post-101", true],
      ["id:post-102", true],
      ["id:post-103", true],
    ]);
    expect(r.items[1].bodyText).toContain("$3.20 per ride");
    expect(web.requests.map((q) => q.url.pathname)).toEqual(["/robots.txt", "/feed"]);
  });

  it("uses the conditional GET validators, and a 304 reads nothing", async () => {
    const feedUrl = "https://ledger.example/feed/";
    const web = createFakeWeb({
      routes: {
        [feedUrl]: (req) =>
          req.headers["if-none-match"] === '"abc"'
            ? { status: 304 }
            : rss(feedFixture("rss-full.xml"), { etag: '"abc"', "last-modified": "Mon, 23 Nov 2026 12:00:00 GMT" }),
      },
    });
    const fetcher = createWebFetcher(web);
    const first = await webFeedSource({ id: "f", feedUrl, title: null, etag: null, lastModified: null }, fetcher, () => NOW).pull(pullOpts());
    expect(first.cache).toEqual({ etag: '"abc"', lastModified: "Mon, 23 Nov 2026 12:00:00 GMT", notModified: false });
    const second = await webFeedSource(
      { id: "f", feedUrl, title: null, etag: first.cache!.etag, lastModified: first.cache!.lastModified },
      fetcher,
      () => NOW,
    ).pull(pullOpts());
    expect(second).toMatchObject({ items: [], cache: { notModified: true, etag: '"abc"' } });
  });

  it("de-duplicates repeated items within one feed", async () => {
    const xml = feedFixture("rss-full.xml").replace("</channel>", `${feedFixture("rss-full.xml").match(/<item>[\s\S]*?<\/item>/)![0]}</channel>`);
    const { src } = sourceFor("https://ledger.example/feed/", xml);
    const keys = (await src.pull(pullOpts())).items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("caps items per pull and says so", async () => {
    const { src } = sourceFor("https://ledger.example/feed/", feedFixture("rss-full.xml"));
    const r = await src.pull(pullOpts({ limit: 1 }));
    expect(r.items).toHaveLength(1);
    expect(r.capped).toBe(true);
  });

  it("caps each item's text", async () => {
    const { src } = sourceFor("https://ledger.example/feed/", feedFixture("rss-full.xml"));
    const r = await src.pull(pullOpts({ maxChars: 60 }));
    expect(r.items[0].bodyText.length).toBeLessThanOrEqual(60);
    expect(r.items[0].truncated).toBe(true);
  });

  it("undated items: a first pull takes only the top one; later pulls take every unseen one", async () => {
    const { src } = sourceFor("https://bits.example/feed", feedFixture("malformed.xml"));
    const first = await src.pull(pullOpts({ firstPull: true }));
    expect(first.items.map((i) => i.key)).toEqual(["id:https://bits.example/a".replace("id:", "link:")]);
    expect(first.items[0].receivedAt).toBe(NOW.toISOString());
    expect(first.items[0].bodyText).toContain("Gorsehill Software shipped version 3 — with 12 new features & a faster sync engine");
    const later = await src.pull(pullOpts({ firstPull: false }));
    expect(later.items).toHaveLength(2);
  });

  it("reads Atom text content as text, not markup", async () => {
    const { src } = sourceFor("https://dispatch.example/atom.xml", feedFixture("atom.xml"));
    const r = await src.pull(pullOpts());
    expect(r.items[0].subject).toBe("Fernbrook Energy doubles output");
    expect(r.items[1].bodyText).toContain("<b>This is text, not markup.</b>");
  });

  it("fails with a short code for a non-200, a non-feed, or a refused fetch", async () => {
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return "no error";
      } catch (err) {
        return err instanceof SourceFetchError ? err.code : String(err);
      }
    };
    const gone = createFakeWeb({ routes: { "https://gone.example/feed": { status: 410 } } });
    const mk = (url: string, web: ReturnType<typeof createFakeWeb>) =>
      webFeedSource({ id: "f", feedUrl: url, title: null, etag: null, lastModified: null }, createWebFetcher(web), () => NOW);
    expect(await codeOf(mk("https://gone.example/feed", gone).pull(pullOpts()))).toBe("http_410");
    const html = createFakeWeb({ routes: { "https://page.example/feed": { headers: { "content-type": "text/html" }, body: feedFixture("homepage.html") } } });
    expect(await codeOf(mk("https://page.example/feed", html).pull(pullOpts()))).toBe("not_a_feed");
    const paywall = createFakeWeb({ routes: { "https://pay.example/feed": { status: 402 } } });
    expect(await codeOf(mk("https://pay.example/feed", paywall).pull(pullOpts()))).toBe("http_402");
    const rebind = createFakeWeb({ dns: { "rebind.example": ["10.0.0.7"] } });
    expect(await codeOf(mk("https://rebind.example/feed", rebind).pull(pullOpts()))).toBe("blocked_address");
    expect(rebind.requests).toHaveLength(0);
  });
});
