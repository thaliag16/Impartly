// The picker's server logic with fakes: an in-memory RPC (the SQL functions are tested on
// real Postgres in tests/db/feed-picker.test.ts) and the fake internet from
// tests/web/fake-web.ts. Nothing real is contacted.

import { describe, expect, it } from "vitest";
import { createFakeWeb, feedFixture, rss, type FakeWeb } from "../../tests/web/fake-web";
import type { Rpc } from "../mail/token-store";
import { loadCatalog, type CatalogEntry } from "../sources/web/catalog";
import { createWebFetcher } from "../sources/web/fetcher";
import { fakeResolve, fakeTransport, fakeWebEnabled } from "./e2e-fake-web";
import { matchPicks } from "./search";
import {
  addNewsletter,
  catalogPicks,
  DISCOVERY_LIMIT,
  DISCOVERY_WINDOW_SECONDS,
  MAX_QUERY_LENGTH,
  previewNewsletter,
  removeFeed,
  setFeedIncluded,
  validateFeedId,
  validateQuery,
  type PickerDeps,
} from "./picker";

const USER = "11111111-1111-4111-8111-111111111111";
const FEED = "22222222-2222-4222-8222-222222222222";
const LEDGER = "https://ledger.example/feed/";
const CATALOG: CatalogEntry[] = [
  { id: "invented-ledger", name: "The Invented Ledger", aliases: ["Ledger"], homepageUrl: "https://ledger.example/", feedUrl: LEDGER, verified: false },
];

interface FakeRpc {
  rpc: Rpc;
  calls: { fn: string; args: Record<string, unknown> }[];
  slots: number;
  owned: Set<string>;
  fail: boolean;
}

function fakeRpc(slots = DISCOVERY_LIMIT): FakeRpc {
  const f: FakeRpc = {
    calls: [],
    slots,
    owned: new Set([FEED]),
    fail: false,
    rpc: async (fn, args) => {
      f.calls.push({ fn, args });
      if (f.fail) throw new Error(`${fn} failed (XX000)`);
      if (fn === "feeds_discovery_take") {
        if (f.slots <= 0) return false;
        f.slots--;
        return true;
      }
      if (fn === "feeds_subscribe") return { id: "33333333-3333-4333-8333-333333333333", inserted: true };
      if (fn === "feeds_set_included" || fn === "feeds_remove") return f.owned.has(String(args.p_feed_id));
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return f;
}

function deps(web: FakeWeb, r: FakeRpc, catalog: readonly CatalogEntry[] = CATALOG): PickerDeps {
  return { rpc: r.rpc, fetcher: () => createWebFetcher(web), catalog };
}

const ledgerWeb = () => createFakeWeb({ routes: { [LEDGER]: rss(feedFixture("rss-full.xml")) } });

describe("input validation", () => {
  it("accepts names, domains and URLs; refuses empty, too long, control characters and non-strings", () => {
    expect(validateQuery("  Morning Brew ")).toBe("Morning Brew");
    expect(validateQuery("ledger.example")).toBe("ledger.example");
    expect(validateQuery("")).toBeNull();
    expect(validateQuery("   ")).toBeNull();
    expect(validateQuery("x".repeat(MAX_QUERY_LENGTH + 1))).toBeNull();
    expect(validateQuery("a\u0000b")).toBeNull();
    expect(validateQuery("line\nbreak")).toBeNull();
    expect(validateQuery(42)).toBeNull();
    expect(validateQuery({ toString: () => "x" })).toBeNull();
    expect(validateQuery(undefined)).toBeNull();
  });

  it("feed ids must be UUIDs", () => {
    expect(validateFeedId(FEED)).toBe(FEED);
    expect(validateFeedId(FEED.toUpperCase())).toBe(FEED);
    expect(validateFeedId("1; drop table web_feeds")).toBeNull();
    expect(validateFeedId(null)).toBeNull();
  });
});

describe("previewNewsletter", () => {
  it("finds a catalog newsletter by name and shows title, site and last issue date without storing anything", async () => {
    const web = ledgerWeb();
    const r = fakeRpc();
    const out = await previewNewsletter(USER, "ledger", deps(web, r));
    expect(out).toEqual({
      ok: true,
      preview: {
        query: "invented-ledger",
        title: "The Invented Ledger",
        site: "ledger.example",
        siteUrl: "https://ledger.example/",
        feedUrl: LEDGER,
        lastIssueAt: "2026-11-23T12:00:00.000Z",
        itemCount: 3,
        fromCatalog: true,
      },
    });
    expect(r.calls.map((c) => c.fn)).toEqual(["feeds_discovery_take"]);
    expect(r.calls[0].args).toEqual({ p_user_id: USER, p_limit: DISCOVERY_LIMIT, p_window_seconds: DISCOVERY_WINDOW_SECONDS });
  });

  it("a pasted URL keeps the URL as the query to add", async () => {
    const out = await previewNewsletter(USER, LEDGER, deps(ledgerWeb(), fakeRpc(), []));
    expect(out.ok && out.preview.query).toBe(LEDGER);
    expect(out.ok && out.preview.fromCatalog).toBe(false);
  });

  it("over the rate limit: refused before any request is made", async () => {
    const web = ledgerWeb();
    const out = await previewNewsletter(USER, "ledger", deps(web, fakeRpc(0)));
    expect(out).toEqual({ ok: false, error: "rate_limited" });
    expect(web.requests).toEqual([]);
  });

  it("invalid input is refused before the rate limit or the network", async () => {
    const web = ledgerWeb();
    const r = fakeRpc();
    expect(await previewNewsletter(USER, "", deps(web, r))).toEqual({ ok: false, error: "invalid_input" });
    expect(r.calls).toEqual([]);
    expect(web.requests).toEqual([]);
  });

  it.each([
    ["a name not in the catalog", "Some Unknown Weekly", {}, "not_found"],
    ["a site whose robots.txt disallows us", "https://robots.example/", { "https://robots.example/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /" } }, "robots"],
    ["a site that answers 403", "https://forbidden.example/", { "https://forbidden.example/": { status: 403 } }, "refused"],
    ["a site with no feed", "https://plain.example/", { "https://plain.example/": { status: 200, headers: { "content-type": "text/html" }, body: "<p>hi</p>" } }, "no_feed"],
    ["a private address", "http://10.0.0.1/", {}, "blocked"],
    ["localhost", "http://localhost:3000/", {}, "invalid_input"],
  ] as const)("%s → %s", async (_label, input, routes, expected) => {
    const out = await previewNewsletter(USER, input, deps(createFakeWeb({ routes: routes as never }), fakeRpc()));
    expect(out).toEqual({ ok: false, error: expected });
  });

  it("a name that resolves to a private address is blocked and never requested", async () => {
    const web = createFakeWeb({ dns: { "inside.example": ["192.168.1.10"] } });
    const out = await previewNewsletter(USER, "inside.example", deps(web, fakeRpc()));
    expect(out).toEqual({ ok: false, error: "blocked" });
    expect(web.requests).toEqual([]);
  });

  it("an unreachable site", async () => {
    const web = createFakeWeb({ dns: {} });
    const out = await previewNewsletter(USER, "https://gone.invalid-tld-name/", deps(web, fakeRpc()));
    expect(out).toEqual({ ok: false, error: "unreachable" });
  });

  it("a storage failure is a generic error, with nothing from it shown", async () => {
    const r = fakeRpc();
    r.fail = true;
    expect(await previewNewsletter(USER, "ledger", deps(ledgerWeb(), r))).toEqual({ ok: false, error: "failed" });
  });
});

describe("addNewsletter", () => {
  it("stores only the feed URL the server found, with the catalog id", async () => {
    const r = fakeRpc();
    const out = await addNewsletter(USER, "invented-ledger", deps(ledgerWeb(), r));
    expect(out).toEqual({ ok: true, feedId: "33333333-3333-4333-8333-333333333333", title: "The Invented Ledger", inserted: true });
    expect(r.calls.map((c) => c.fn)).toEqual(["feeds_discovery_take", "feeds_subscribe"]);
    expect(r.calls[1].args).toEqual({
      p_user_id: USER,
      p_feed_url: LEDGER,
      p_feed_format: "rss",
      p_title: "The Invented Ledger",
      p_homepage_url: "https://ledger.example/",
      p_catalog_id: "invented-ledger",
    });
  });

  it("stores nothing when discovery fails or the limit is hit", async () => {
    const r = fakeRpc();
    expect(await addNewsletter(USER, "https://plain.example/", deps(createFakeWeb(), r))).toEqual({ ok: false, error: "no_feed" });
    const limited = fakeRpc(0);
    expect(await addNewsletter(USER, "ledger", deps(ledgerWeb(), limited))).toEqual({ ok: false, error: "rate_limited" });
    for (const x of [r, limited]) expect(x.calls.map((c) => c.fn)).not.toContain("feeds_subscribe");
  });
});

describe("setFeedIncluded and removeFeed", () => {
  it("call the server-only functions with the user's id for their own feed", async () => {
    const r = fakeRpc();
    expect(await setFeedIncluded(USER, FEED, false, r)).toEqual({ ok: true });
    expect(await removeFeed(USER, FEED, r)).toEqual({ ok: true });
    expect(r.calls).toEqual([
      { fn: "feeds_set_included", args: { p_user_id: USER, p_feed_id: FEED, p_included: false } },
      { fn: "feeds_remove", args: { p_user_id: USER, p_feed_id: FEED } },
    ]);
  });

  it("a feed that is not the user's is reported, not changed", async () => {
    const r = fakeRpc();
    const other = "44444444-4444-4444-8444-444444444444";
    expect(await setFeedIncluded(USER, other, true, r)).toEqual({ ok: false, error: "not_yours" });
    expect(await removeFeed(USER, other, r)).toEqual({ ok: false, error: "not_yours" });
  });

  it("refuses malformed ids and non-boolean switches without calling the database", async () => {
    const r = fakeRpc();
    expect(await setFeedIncluded(USER, "nope", true, r)).toEqual({ ok: false, error: "invalid_input" });
    expect(await setFeedIncluded(USER, FEED, "false", r)).toEqual({ ok: false, error: "invalid_input" });
    expect(await removeFeed(USER, { id: FEED }, r)).toEqual({ ok: false, error: "invalid_input" });
    expect(r.calls).toEqual([]);
  });
});

describe("the real catalog and the UI tests' fake web", () => {
  const catalog = loadCatalog();
  const fakeDeps = (r: FakeRpc): PickerDeps => ({
    rpc: r.rpc,
    fetcher: () => createWebFetcher({ resolve: fakeResolve, transport: fakeTransport }),
    catalog,
  });

  it("Thalia's examples are findable by name in the catalog picks", () => {
    const names = catalogPicks(catalog).map((p) => p.name);
    for (const n of ["TechCrunch", "StrictlyVC", "Morning Brew"]) expect(names).toContain(n);
    expect(catalogPicks(catalog).find((p) => p.id === "techcrunch")?.site).toBe("techcrunch.com");
  });

  it.each(["TechCrunch", "StrictlyVC", "Morning Brew"])("%s previews through the e2e fake web (catalog feed, page link, common path)", async (name) => {
    const out = await previewNewsletter(USER, name, fakeDeps(fakeRpc()));
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.ok && out.preview.title).toBe(name);
  });

  it("the e2e fake web covers robots, refused, no-feed and private-address errors", async () => {
    const cases: [string, string][] = [
      ["robots-blocked.example", "robots"],
      ["refused.example", "refused"],
      ["no-feed.example", "no_feed"],
      ["intranet.example", "blocked"],
    ];
    for (const [q, error] of cases) expect(await previewNewsletter(USER, q, fakeDeps(fakeRpc())), q).toEqual({ ok: false, error });
  });

  it("the fake web is only switched on by its env flag, and never on Vercel", () => {
    expect(fakeWebEnabled({})).toBe(false);
    expect(fakeWebEnabled({ IMPARTLY_E2E_FAKE_WEB: "true" })).toBe(false);
    expect(fakeWebEnabled({ IMPARTLY_E2E_FAKE_WEB: "1" })).toBe(true);
    expect(fakeWebEnabled({ IMPARTLY_E2E_FAKE_WEB: "1", VERCEL: "1" })).toBe(false);
  });
});

describe("matchPicks (catalog search in the browser)", () => {
  const picks = catalogPicks(loadCatalog());
  it("finds Thalia's examples by partial name, ignoring case, spaces and punctuation", () => {
    expect(matchPicks(picks, "tech").map((p) => p.name)).toContain("TechCrunch");
    expect(matchPicks(picks, "strictly vc").map((p) => p.name)).toEqual(["StrictlyVC"]);
    expect(matchPicks(picks, "MORNING-brew").map((p) => p.name)).toEqual(["Morning Brew"]);
    expect(matchPicks(picks, "morningbrew.com").map((p) => p.name)).toEqual(["Morning Brew"]);
  });
  it("empty or punctuation-only queries match nothing; results are capped", () => {
    expect(matchPicks(picks, "")).toEqual([]);
    expect(matchPicks(picks, " .. ")).toEqual([]);
    expect(matchPicks(picks, "e", 3)).toHaveLength(3);
  });
});
