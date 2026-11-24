// Public web archives end to end on a real Postgres: picking a newsletter that has no feed
// stores its archive page (format 'archive'), and the pipeline reads new issue pages from
// it through the source interface, de-duplicated by canonical URL, with paywalled pages
// marked partial and hidden instructions never reaching the summarizer or the database.
// The network is the fake in tests/web/fake-web.ts (invented .example hosts); the pacer
// runs on a fake clock, so nothing sleeps and nothing real is contacted.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rpc } from "../../lib/mail";
import { createRpcPipelineStore, runPipelineForUser, type PipelineStore } from "../../lib/pipeline";
import { createPacer, createWebFetcher, subscribeToNewsletter } from "../../lib/sources";
import type { Newsletter, SummaryProvider } from "../../lib/summarizer/types";
import { createFakeWeb, type FakeWeb, type Route } from "../web/fake-web";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const fixture = (name: string) => readFileSync(path.join(ROOT, "fixtures", "archives", name), "utf8");
const html = (body: string): Route => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body });

const SITE = "https://letters.example";
const NOW = new Date("2026-11-23T14:00:00.000Z");

function fakeClockPacer() {
  let t = 0;
  return createPacer({ now: () => t, sleep: async (ms) => void (t += ms) });
}

/** The archive lists issues 1 to 3; with `withIssue4`, a new paywalled issue 4 on top. */
function web(withIssue4 = false): FakeWeb {
  const index = fixture("index-jsonld.html").replace(
    '"itemListElement": [',
    withIssue4
      ? `"itemListElement": [{"@type": "ListItem", "position": 0, "item": {"@type": "BlogPosting", "url": "${SITE}/p/ledger-issue-4", "headline": "Issue 4", "datePublished": "2026-11-24T06:00:00Z"}},`
      : '"itemListElement": [',
  );
  return createFakeWeb({
    routes: {
      [`${SITE}/`]: html(index),
      [`${SITE}/p/ledger-issue-3`]: html(fixture("issue-full.html")),
      [`${SITE}/p/ledger-issue-2`]: html(fixture("issue-paywall.html")),
      [`${SITE}/p/ledger-issue-1`]: html(fixture("issue-teaser.html")),
      [`${SITE}/p/ledger-issue-4`]: html(
        fixture("issue-paywall.html").replace(/Issue 2: An invented fund closes/g, "Issue 4: An invented fund reopens").replace("2026-11-16", "2026-11-24"),
      ),
    },
  });
}

describe.skipIf(!databaseUrl)("public web archives on real Postgres", () => {
  let db: TestDatabase;
  let rpc: Rpc;
  let store: PipelineStore;

  const newUser = async () => {
    const id = randomUUID();
    await db.admin.query("insert into auth.users (id) values ($1)", [id]);
    return id;
  };
  const newsletters = async (userId: string) =>
    (await db.admin.query("select * from public.newsletters where user_id = $1 order by received_at desc", [userId])).rows;
  const summarizer = () => {
    const calls: Newsletter[] = [];
    const s: SummaryProvider & { calls: Newsletter[] } = {
      calls,
      async summarize(input) {
        calls.push(input);
        return `A summary of ${input.subject}.`;
      },
    };
    return s;
  };
  const run = (userId: string, net: FakeWeb, sum = summarizer(), now = NOW) =>
    runPipelineForUser(userId, { store, summarizer: sum, webFetcher: createWebFetcher(net), pacer: fakeClockPacer(), now: () => now });

  beforeAll(async () => {
    db = await createTestDatabase();
    rpc = async (fn, args) => {
      const names = Object.keys(args);
      const params = names.map((n) => {
        const v = args[n];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as result`;
      const r = await as(db.admin, { kind: "service" }, (q) => q(sql, params));
      return r.rows[0].result;
    };
    store = createRpcPipelineStore(rpc);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("a site with no feed is stored as its archive page, format 'archive'", async () => {
    const a = await newUser();
    const r = await subscribeToNewsletter(a, "letters.example", { rpc, fetcher: createWebFetcher(web()) });
    expect(r).toMatchObject({ ok: true, inserted: true, feed: { feedUrl: `${SITE}/`, format: "archive", title: "The Invented Ledger" } });
    const rows = (await db.admin.query("select feed_url, feed_format, title from public.web_feeds where user_id = $1", [a])).rows;
    expect(rows).toEqual([{ feed_url: `${SITE}/`, feed_format: "archive", title: "The Invented Ledger" }]);
  });

  it("feed_format accepts only rss, atom and archive", async () => {
    const a = await newUser();
    const r = await attempt(db.admin, { kind: "service" }, "insert into public.web_feeds (user_id, feed_url, feed_format, title) values ($1, 'https://x.example/', 'html', 'X')", [a]);
    expect(r.error?.code).toBe("23514");
  });

  it("pulls new issue pages, stores clean text (hidden instructions gone, paywalls partial), and fetches only new pages next time", async () => {
    const a = await newUser();
    await subscribeToNewsletter(a, "letters.example", { rpc, fetcher: createWebFetcher(web()) });

    // First pull: the last 24 hours only (issue 3).
    const net1 = web();
    const sum1 = summarizer();
    const r1 = await run(a, net1, sum1);
    expect(r1.feeds).toEqual([expect.objectContaining({ outcome: "pulled", stored: 1, partial: 0, listed: 3 })]);
    let rows = await newsletters(a);
    expect(rows.map((n) => [n.provider_message_id, n.subject, n.partial, n.source_url])).toEqual([
      [`url:${SITE}/p/ledger-issue-3`, "Issue 3: Invented lenders cut rates", false, `${SITE}/p/ledger-issue-3`],
    ]);
    expect(rows[0].body_text).toContain("Larkspur Lending");
    expect(rows[0].body_text).not.toMatch(/PWNED/);
    expect(sum1.calls.map((c) => c.text).join("\n")).not.toMatch(/PWNED/);
    expect(net1.requests.map((q) => q.url.pathname)).toEqual(["/robots.txt", "/", "/p/ledger-issue-3"]);

    // Its stored links come back for the next pull.
    const loaded = await store.load(a);
    expect(loaded.feeds[0]).toMatchObject({ format: "archive", knownUrls: expect.arrayContaining([`url:${SITE}/p/ledger-issue-3`, `${SITE}/p/ledger-issue-3`]) });

    // A day later a paywalled issue 4 appears: only its page is fetched, issue 3 is not re-read.
    const net2 = web(true);
    const r2 = await run(a, net2, summarizer(), new Date("2026-11-24T14:00:00.000Z"));
    expect(r2.feeds).toEqual([expect.objectContaining({ outcome: "pulled", stored: 1, partial: 1 })]);
    expect(net2.requests.map((q) => q.url.pathname)).toEqual(["/robots.txt", "/", "/p/ledger-issue-4"]);
    rows = await newsletters(a);
    expect(rows.map((n) => [n.subject, n.partial])).toEqual([
      ["Issue 4: An invented fund reopens", true],
      ["Issue 3: Invented lenders cut rates", false],
    ]);

    // Running again stores nothing twice.
    const r3 = await run(a, web(true), summarizer(), new Date("2026-11-24T15:00:00.000Z"));
    expect(r3.feeds[0]).toMatchObject({ stored: 0 });
    expect(await newsletters(a)).toHaveLength(2);
  });

  it("each user's archive keeps its own known issues", async () => {
    const a = await newUser();
    const b = await newUser();
    for (const u of [a, b]) await subscribeToNewsletter(u, "letters.example", { rpc, fetcher: createWebFetcher(web()) });
    await run(a, web());
    expect((await store.load(b)).feeds[0].knownUrls).toEqual([]);
    const netB = web();
    const rb = await run(b, netB);
    expect(rb.feeds[0]).toMatchObject({ stored: 1 });
    expect(await newsletters(b)).toHaveLength(1);
    expect(await newsletters(a)).toHaveLength(1);
  });

  it("a robots.txt refusal is recorded as a short code and stores nothing", async () => {
    const a = await newUser();
    await subscribeToNewsletter(a, "letters.example", { rpc, fetcher: createWebFetcher(web()) });
    const net = web();
    net.routes.set(`${SITE}/robots.txt`, { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /\n" });
    const r = await run(a, net);
    expect(r.feeds[0]).toMatchObject({ outcome: "failed", error: "robots_disallowed" });
    const row = (await db.admin.query("select last_error from public.web_feeds where user_id = $1", [a])).rows[0];
    expect(row.last_error).toBe("robots_disallowed");
    expect(await newsletters(a)).toEqual([]);
  });
});
