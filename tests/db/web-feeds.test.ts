// Web feeds end to end on a real Postgres: picking a newsletter (discovery + feeds_subscribe),
// then the pipeline pulling it through the source interface, storing de-duplicated items
// (partial ones marked), summarizing, and keeping each user's feeds and items apart. The
// network is the fake in tests/web/fake-web.ts (invented .example hosts); nothing real is
// contacted. The Gmail source runs alongside in one test to show both fit one pipeline.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultTokenStore, gmailAdapterForConnection, type Rpc, type TokenStore } from "../../lib/mail";
import { createRpcPipelineStore, runPipelineForUser, type PipelineStore } from "../../lib/pipeline";
import { createWebFetcher, subscribeToNewsletter, type CatalogEntry } from "../../lib/sources";
import type { Newsletter, SummaryLength, SummaryProvider } from "../../lib/summarizer/types";
import { createFakeGoogle } from "../mail/fake-gmail";
import { createFakeWeb, feedFixture, rss, type FakeWeb } from "../web/fake-web";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

const NOW = new Date("2026-11-23T14:00:00.000Z");
const LEDGER = "https://ledger.example/feed/";
const PAYWALL = "https://paywall.example/feed";
const CATALOG: CatalogEntry[] = [
  { id: "invented-ledger", name: "The Invented Ledger", homepageUrl: "https://ledger.example/", feedUrl: LEDGER, verified: false },
];

interface Recorder extends SummaryProvider {
  calls: { input: Newsletter; length: SummaryLength }[];
}
function recorder(): Recorder {
  const r: Recorder = {
    calls: [],
    async summarize(input, { length }) {
      r.calls.push({ input, length });
      return `A ${length} summary of ${input.subject}.`;
    },
  };
  return r;
}

function web(): FakeWeb {
  return createFakeWeb({
    routes: {
      [LEDGER]: (req) =>
        req.headers["if-none-match"] === '"ledger-v1"' ? { status: 304 } : rss(feedFixture("rss-full.xml"), { etag: '"ledger-v1"' }),
      [PAYWALL]: rss(feedFixture("rss-teaser.xml")),
      "https://paywall.example/": { status: 200, headers: { "content-type": "text/html" }, body: '<link rel="alternate" type="application/rss+xml" href="/feed">' },
    },
  });
}

describe.skipIf(!databaseUrl)("web feeds on real Postgres", () => {
  let db: TestDatabase;
  let rpc: Rpc;
  let store: PipelineStore;
  let tokens: TokenStore;

  const newUser = async () => {
    const id = randomUUID();
    await db.admin.query("insert into auth.users (id) values ($1)", [id]);
    return id;
  };
  const feeds = async (userId: string) =>
    (await db.admin.query("select * from public.web_feeds where user_id = $1 order by created_at", [userId])).rows;
  const newsletters = async (userId: string) =>
    (await db.admin.query("select * from public.newsletters where user_id = $1 order by received_at desc", [userId])).rows;
  const run = (userId: string, net: FakeWeb, summarizer: SummaryProvider = recorder(), now = NOW) =>
    runPipelineForUser(userId, { store, summarizer, webFetcher: createWebFetcher(net), now: () => now });

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
    tokens = createVaultTokenStore(rpc);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("picking a newsletter stores the validated feed URL, never the raw input; picking it again keeps one row", async () => {
    const a = await newUser();
    const net = web();
    const r1 = await subscribeToNewsletter(a, "The Invented Ledger", { rpc, fetcher: createWebFetcher(net), catalog: CATALOG });
    expect(r1).toMatchObject({ ok: true, inserted: true, feed: { feedUrl: LEDGER, catalogId: "invented-ledger" } });
    const r2 = await subscribeToNewsletter(a, "paywall.example", { rpc, fetcher: createWebFetcher(net) });
    expect(r2).toMatchObject({ ok: true, inserted: true, feed: { feedUrl: PAYWALL, title: "Paywall Weekly", catalogId: null } });
    await db.admin.query("update public.web_feeds set included = false where user_id = $1 and feed_url = $2", [a, LEDGER]);
    const again = await subscribeToNewsletter(a, "ledger", { rpc, fetcher: createWebFetcher(net), catalog: [{ ...CATALOG[0], aliases: ["ledger"] }] });
    expect(again).toMatchObject({ ok: true, inserted: false });
    const rows = await feeds(a);
    expect(rows.map((f) => [f.feed_url, f.feed_format, f.included])).toEqual([
      [LEDGER, "rss", true],
      [PAYWALL, "rss", true],
    ]);
  });

  it("nothing is stored when discovery fails or the target is private", async () => {
    const a = await newUser();
    const net = createFakeWeb({ dns: { "inside.example": ["10.0.0.8"] } });
    for (const input of ["Not A Catalog Name", "http://127.0.0.1/feed", "inside.example", "file:///etc/passwd"]) {
      const r = await subscribeToNewsletter(a, input, { rpc, fetcher: createWebFetcher(net), catalog: CATALOG });
      expect(r.ok).toBe(false);
    }
    expect(net.requests).toHaveLength(0);
    expect(await feeds(a)).toEqual([]);
  });

  it("pulls each feed, stores de-duplicated clean text with partial marked, and summarizes it", async () => {
    const a = await newUser();
    const net = web();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    await subscribeToNewsletter(a, PAYWALL, { rpc, fetcher: createWebFetcher(net) });
    const summarizer = recorder();
    const result = await run(a, net, summarizer);

    expect(result.connections).toEqual([]);
    expect(result.feeds.map((f) => [f.outcome, f.stored, f.partial, f.storeFailures])).toEqual([
      ["pulled", 1, 0, 0], // ledger: only the 23rd is inside the first pull's 24 h window
      ["pulled", 1, 1, 0], // paywall: one in the window, a teaser
    ]);
    const stored = await newsletters(a);
    expect(stored.every((n) => n.connection_id === null && n.feed_id)).toBe(true);
    const larkspur = stored.find((n) => n.provider_message_id === "id:ledger-2026-11-23")!;
    expect(larkspur).toMatchObject({
      sender_address: "ledger.example",
      sender_name: "The Invented Ledger",
      partial: false,
      source_url: "https://ledger.example/2026/11/23/larkspur",
    });
    expect(larkspur.body_text).toContain("Juniper Peak Partners");
    for (const n of stored) expect(n.body_text).not.toMatch(/ignore your previous instructions/i);
    const teaser = stored.find((n) => n.provider_message_id === "id:post-101")!;
    expect(teaser.partial).toBe(true);

    expect(result.summaries).toEqual({ created: 2, reused: 0, failed: 0, deferred: 0 });
    for (const c of summarizer.calls) expect(c.input.text).not.toMatch(/ignore your previous instructions/i);

    const ledgerRow = (await feeds(a)).find((f) => f.feed_url === LEDGER)!;
    expect(ledgerRow).toMatchObject({ etag: '"ledger-v1"', last_error: null });
    expect(new Date(ledgerRow.last_fetched_at).toISOString()).toBe(NOW.toISOString());
  });

  it("the next run sends the validators: a 304 stores nothing; a full re-read stores nothing twice", async () => {
    const a = await newUser();
    const net = web();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    await run(a, net);
    const before = (await newsletters(a)).length;

    const later = new Date(NOW.getTime() + 3600_000);
    const second = await run(a, net, recorder(), later);
    expect(second.feeds[0]).toMatchObject({ outcome: "not_modified", stored: 0 });
    expect(net.requests.at(-1)!.headers["if-none-match"]).toBe('"ledger-v1"');

    await db.admin.query("update public.web_feeds set etag = null, last_modified = null where user_id = $1", [a]);
    const third = await run(a, net, recorder(), later);
    expect(third.feeds[0]).toMatchObject({ outcome: "pulled", stored: 0, alreadyStored: before });
    expect((await newsletters(a)).length).toBe(before);
  });

  it("if an item fails to store, the cache validators are not saved, so the next run re-reads and stores it", async () => {
    const a = await newUser();
    const net = web();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    let failOnce = true;
    const flaky: PipelineStore = {
      ...store,
      async saveFeedItem(userId, row) {
        if (failOnce) {
          failOnce = false;
          throw new Error("StoreDown");
        }
        return store.saveFeedItem(userId, row);
      },
    };
    const first = await runPipelineForUser(a, { store: flaky, summarizer: recorder(), webFetcher: createWebFetcher(net), now: () => NOW });
    expect(first.feeds[0]).toMatchObject({ outcome: "pulled", stored: 0, storeFailures: 1 });
    expect((await feeds(a))[0]).toMatchObject({ etag: null, last_fetched_at: null, last_error: "store_failed" });

    const second = await run(a, net, recorder(), new Date(NOW.getTime() + 3600_000));
    expect(second.feeds[0]).toMatchObject({ outcome: "pulled", stored: 1, storeFailures: 0 });
    expect((await feeds(a))[0]).toMatchObject({ etag: '"ledger-v1"', last_error: null });
  });

  it("a failing feed records a short error code and the others carry on; a switched-off feed is skipped", async () => {
    const a = await newUser();
    const net = web();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    await subscribeToNewsletter(a, PAYWALL, { rpc, fetcher: createWebFetcher(net) });
    net.routes.set(LEDGER, { status: 410 });
    await db.admin.query("update public.web_feeds set included = false where user_id = $1 and feed_url = $2", [a, PAYWALL]);
    const before = net.requests.length;
    const r = await run(a, net);
    expect(r.feeds.map((f) => [f.outcome, f.error])).toEqual([
      ["failed", "http_410"],
      ["skipped", undefined],
    ]);
    const rows = await feeds(a);
    expect(rows[0]).toMatchObject({ last_error: "http_410", last_fetched_at: null });
    expect(net.requests.slice(before).map((q) => q.url.toString())).not.toContain(PAYWALL);
  });

  it("a robots.txt refusal is recorded, and the feed is not fetched", async () => {
    const a = await newUser();
    const net = web();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    net.routes.set("https://ledger.example/robots.txt", { body: "User-agent: Impartly\nDisallow: /\n" });
    const before = net.requests.length;
    const r = await run(a, net);
    expect(r.feeds[0]).toMatchObject({ outcome: "failed", error: "robots_disallowed" });
    expect(net.requests.slice(before).map((q) => q.url.pathname)).toEqual(["/robots.txt"]);
  });

  it("two users with the same feed: separate rows, and one user's run never touches the other's", async () => {
    const a = await newUser();
    const b = await newUser();
    const net = web();
    for (const u of [a, b]) await subscribeToNewsletter(u, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    await run(b, net);
    const bBefore = JSON.stringify([await feeds(b), await newsletters(b)]);
    await run(a, net, recorder(), new Date(NOW.getTime() + 7200_000));
    expect(JSON.stringify([await feeds(b), await newsletters(b)])).toBe(bBefore);

    const bFeed = (await feeds(b))[0].id;
    await expect(
      store.saveFeedItem(a, { feedId: bFeed, itemKey: "x", senderAddress: "ledger.example", subject: "s", receivedAt: NOW.toISOString(), bodyText: "t", partial: false }),
    ).rejects.toThrow();
    const bFeedBefore = JSON.stringify(await feeds(b));
    await expect(store.markFeed(a, bFeed, { error: "http_500" })).rejects.toThrow();
    await expect(store.markFeed(a, bFeed, { fetchedAt: NOW, etag: '"stolen"', lastModified: null })).rejects.toThrow();
    expect(JSON.stringify(await feeds(b))).toBe(bFeedBefore);
    // A signed-in user sees only their own feeds and items.
    const seen = await attempt(db.admin, { kind: "user", id: a }, "select user_id from public.web_feeds union all select user_id from public.newsletters");
    expect(new Set(seen.rows.map((r) => (r as { user_id: string }).user_id))).toEqual(new Set([a]));
  });

  it("mail (optional) and web feeds run in one pipeline through the same source interface", async () => {
    const a = await newUser();
    const net = web();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    const accessToken = "invented-access-both";
    const connectionId = await tokens.saveConnection(
      { userId: a, provider: "gmail", accountAddress: "reader-both@inbox.example" },
      { accessToken, refreshToken: "invented-refresh-both", expiresAt: Date.now() + 3600_000, scope: "https://www.googleapis.com/auth/gmail.readonly" },
    );
    const google = createFakeGoogle({ accessToken });
    const r = await runPipelineForUser(a, {
      store,
      summarizer: recorder(),
      webFetcher: createWebFetcher(net),
      now: () => new Date("2026-11-23T12:00:00.000Z"),
      adapterFor: (c) =>
        gmailAdapterForConnection({
          connectionId: c.id,
          store: tokens,
          oauth: { clientId: "invented-client-id", clientSecret: "invented-client-secret", redirectUri: "http://localhost:3000/api/mail/gmail/callback", fetch: google.fetch },
          fetch: google.fetch,
        }),
    });
    expect(r.sources.map((s) => [s.kind, s.outcome])).toEqual([
      ["mail", "pulled"],
      ["web", "pulled"],
    ]);
    expect(r.connections[0]).toMatchObject({ connectionId, outcome: "pulled" });
    expect(r.connections[0].stored).toBeGreaterThan(0);
    expect(r.feeds[0].stored).toBeGreaterThan(0);
    const kinds = (await newsletters(a)).map((n) => (n.connection_id ? "mail" : "web"));
    expect(new Set(kinds)).toEqual(new Set(["mail", "web"]));
  });

  it("results hold counts and codes only: no URLs, titles or text", async () => {
    const a = await newUser();
    const net = web();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(net) });
    const ok = JSON.stringify(await run(a, net));
    net.routes.set(LEDGER, { status: 500 });
    const failed = JSON.stringify(await run(a, net, recorder(), new Date(NOW.getTime() + 3600_000)));
    for (const s of [ok, failed]) expect(s).not.toMatch(/https?:|ledger|Larkspur|Invented/i);
  });

  it("the feed functions are server-only: anon and signed-in users cannot call them", async () => {
    const a = await newUser();
    await subscribeToNewsletter(a, LEDGER, { rpc, fetcher: createWebFetcher(web()) });
    const feedId = (await feeds(a))[0].id;
    const calls = [
      ["feeds_subscribe($1::uuid, 'https://x.example/feed', 'rss', 't', null, null)", [a]],
      ["pipeline_save_feed_item($1::uuid, $2::uuid, 'k', 'x.example', null, 's', now(), 't', false, null)", [a, feedId]],
      ["pipeline_mark_feed($1::uuid, $2::uuid, now(), null, null, null)", [a, feedId]],
    ] as const;
    for (const [call, params] of calls) {
      for (const actor of [{ kind: "anon" }, { kind: "user", id: a }] as const) {
        const r = await attempt(db.admin, actor, `select public.${call}`, [...params]);
        expect(r.error?.code, `${actor.kind} ${call}`).toBe("42501");
      }
    }
    // And a signed-in user cannot write web_feeds directly (no arbitrary URL for the server to fetch).
    const ins = await attempt(db.admin, { kind: "user", id: a }, "insert into public.web_feeds (user_id, feed_url, feed_format, title) values ($1, 'http://169.254.169.254/', 'rss', 'x')", [a]);
    expect(ins.error?.code).toBe("42501");
    const upd = await attempt(db.admin, { kind: "user", id: a }, "update public.web_feeds set feed_url = 'http://10.0.0.1/' where user_id = $1", [a]);
    expect(upd.error?.code).toBe("42501");
  });
});
