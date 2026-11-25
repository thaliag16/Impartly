import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createFakePostgrest } from "../../tests/supabase/fake-postgrest.mjs";
import { loadLatestBriefing, parseBriefingItem, scriptFor, type RawBriefingItem } from "./load";

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const I1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const I3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const raw = (over: Partial<RawBriefingItem> = {}): RawBriefingItem => ({
  id: I1,
  feed_id: F1,
  source: "Invented Weekly",
  subject: "Larkspur raises a seed round",
  summary: "Larkspur Robotics raised 4 million dollars.",
  partial: false,
  received_at: "2026-11-24T13:00:00+00:00",
  ...over,
});

describe("parseBriefingItem", () => {
  it("turns a merged row into script input", () => {
    expect(parseBriefingItem(raw())).toEqual({
      id: I1,
      feedId: F1,
      source: "Invented Weekly",
      subject: "Larkspur raises a seed round",
      summary: "Larkspur Robotics raised 4 million dollars.",
      partial: false,
      receivedAt: "2026-11-24T13:00:00.000Z",
    });
    expect(parseBriefingItem(raw({ feed_id: null }))?.feedId).toBeNull();
  });

  it.each([
    ["a bad id", { id: "x" }],
    ["a bad feed id", { feed_id: "f1" }],
    ["no source", { source: "  " }],
    ["an empty summary", { summary: "   " }],
    ["a summary that is not text", { summary: 7 }],
    ["no partial flag", { partial: "no" }],
    ["a bad received time", { received_at: "yesterday" }],
    ["an oversized subject", { subject: "x".repeat(1_001) }],
  ])("refuses an item with %s", (_label, over) => {
    expect(parseBriefingItem(raw(over))).toBeNull();
  });
});

/** In-memory stand-ins for the user's client and the server rpc (no database). */
function readers(tables: Record<string, Record<string, unknown>[]>, options: { failOn?: string; due?: unknown } = {}) {
  const reads: string[] = [];
  const rpcCalls: unknown[] = [];
  const user = {
    from(table: string) {
      reads.push(table);
      const result = { data: tables[table] ?? [], error: options.failOn === table ? { code: "42501" } : null };
      const b = {
        select: () => b,
        gte: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => void) => resolve(result),
      };
      return b;
    },
  } as never;
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push([fn, args]);
    if (options.failOn === "rpc") throw new Error("delivery_due_at failed (42501)");
    return options.due ?? "2026-11-24T15:00:00+00:00";
  };
  return { readers: { user, rpc }, reads, rpcCalls };
}

const issue = (id: string, feedId: string | null, received: string, extra: Record<string, unknown> = {}) => ({
  id,
  feed_id: feedId,
  sender_name: "Sender Name",
  sender_address: "news@invented.example",
  subject: `Subject ${id.slice(0, 4)}`,
  partial: false,
  received_at: received,
  ...extra,
});

describe("loadLatestBriefing", () => {
  const NOW = new Date("2026-11-24T16:00:00Z");

  it("asks for the window with the user's settings and the lead, clamped to 0 to 360", async () => {
    const t = readers({ user_settings: [{ delivery_time: "06:45:00", timezone: "Europe/Berlin", summary_length: "deep", feed_order: [] }] });
    await loadLatestBriefing(t.readers, { leadMinutes: 30, now: NOW });
    await loadLatestBriefing(t.readers, { leadMinutes: 9_999, now: NOW });
    await loadLatestBriefing(t.readers, { leadMinutes: -5, now: NOW });
    await loadLatestBriefing(t.readers, { leadMinutes: 1.5, now: NOW });
    const base = { p_now: NOW.toISOString(), p_time: "06:45:00", p_tz: "Europe/Berlin" };
    expect(t.rpcCalls).toEqual([
      ["delivery_due_at", { ...base, p_lead_minutes: 30 }],
      ["delivery_due_at", { ...base, p_lead_minutes: 360 }],
      ["delivery_due_at", { ...base, p_lead_minutes: 0 }],
      ["delivery_due_at", { ...base, p_lead_minutes: 30 }],
    ]);
  });

  it("uses the schedule's defaults (07:00 UTC) when the user has no settings row", async () => {
    const t = readers({});
    const out = await loadLatestBriefing(t.readers, { leadMinutes: 30, now: NOW });
    expect(t.rpcCalls[0]).toEqual(["delivery_due_at", { p_now: NOW.toISOString(), p_time: "07:00", p_tz: "UTC", p_lead_minutes: 30 }]);
    expect(out).toEqual({
      ok: true,
      value: { deliveryAt: "2026-11-24T15:00:00.000Z", windowStart: "2026-11-24T14:30:00.000Z", feedOrder: [], items: [] },
    });
    // No issues: no summary or feed read.
    expect(t.reads).toEqual(["user_settings", "newsletters"]);
  });

  it("picks the user's length, else the newest; names from the feed, else the sender; skips switched-off and unsummarized", async () => {
    const t = readers({
      user_settings: [{ delivery_time: "07:00:00", timezone: "UTC", summary_length: "brief", feed_order: [F2, "junk"] }],
      newsletters: [
        issue(I3, null, "2026-11-24T14:00:00Z"), // mail: named by sender
        issue(I2, F2, "2026-11-24T12:00:00Z"),
        issue(I1, F1, "2026-11-24T10:00:00Z"),
        issue("dddddddd-dddd-4ddd-8ddd-dddddddddddd", F1, "2026-11-24T09:00:00Z"), // no summary
        issue("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff", "2026-11-24T09:00:00Z"), // switched off
      ],
      summaries: [
        // newest first, as read
        { newsletter_id: I1, length: "deep", summary_text: "Deep, newest." },
        { newsletter_id: I1, length: "brief", summary_text: "Brief, chosen." },
        { newsletter_id: I2, length: "headline", summary_text: "Only a headline." },
        { newsletter_id: I3, length: "brief", summary_text: "Mail summary." },
        { newsletter_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", length: "brief", summary_text: "Should not play." },
      ],
      web_feeds: [
        { id: F1, title: "Invented Weekly", included: true },
        { id: F2, title: "  ", included: true },
        { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", title: "Switched Off", included: false },
      ],
    });
    const out = await loadLatestBriefing(t.readers, { leadMinutes: 30, now: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.feedOrder).toEqual([F2]);
    expect(out.value.items.map((i) => [i.id, i.source, i.summary])).toEqual([
      [I1, "Invented Weekly", "Brief, chosen."],
      [I2, "Sender Name", "Only a headline."],
      [I3, "Sender Name", "Mail summary."],
    ]);
  });

  it.each(["user_settings", "newsletters", "summaries", "web_feeds", "rpc"])("a failed read (%s) fails the load", async (failOn) => {
    const t = readers({ newsletters: [issue(I1, F1, "2026-11-24T10:00:00Z")] }, { failOn });
    expect(await loadLatestBriefing(t.readers, { leadMinutes: 30, now: NOW })).toEqual({ ok: false, error: "load_failed" });
  });

  it("a malformed window fails the load", async () => {
    const t = readers({}, { due: "soon" });
    expect(await loadLatestBriefing(t.readers, { leadMinutes: 30, now: NOW })).toEqual({ ok: false, error: "load_failed" });
  });
});

describe("loadLatestBriefing through the fake REST API (the one the UI tests use)", () => {
  const A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
  const B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
  const tokens: Record<string, string> = { "token-a": A, "token-b": B };
  const base = "http://fake.supabase.test";
  const SERVICE = "service-marker";

  function setup() {
    const fake = createFakePostgrest({ serviceKey: SERVICE, userIdForToken: async (token: string) => tokens[token] ?? null });
    const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (await fake.handle(new Request(input, init))) ?? new Response(null, { status: 404 })) as typeof fetch;
    const client = (key: string, token?: string) =>
      createClient(base, key, {
        global: { fetch: fetchFake, headers: token ? { Authorization: `Bearer ${token}` } : {} },
        auth: { persistSession: false, autoRefreshToken: false },
      });
    const admin = client(SERVICE);
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw new Error(`${fn} failed`);
      return data;
    };
    const readersFor = (token: string) => ({ user: client("publishable-marker", token), rpc });
    const seed = (body: Record<string, unknown>) =>
      fake.handle(new Request(`${base}/__e2e/seed-briefing`, { method: "POST", body: JSON.stringify(body) }));
    return { readersFor, seed, client, fetchFake };
  }

  // 08:00 UTC; with no settings row the delivery is 07:00 UTC, the window from 06:30.
  const NOW = new Date("2026-11-24T08:00:00Z");

  it("loads the signed-in user's own issues stored in the latest window, never another user's", async () => {
    const { readersFor, seed } = setup();
    await seed({
      user_id: A,
      feeds: [
        { id: F1, title: "Invented Weekly", feed_url: "https://weekly.invented.example/rss" },
        { id: F2, title: "Quarry Daily", feed_url: "https://quarry.invented.example/rss", included: false },
      ],
      newsletters: [
        { id: I1, feed_id: F1, subject: "First", received_at: "2026-11-23T20:00:00Z", created_at: "2026-11-24T06:40:00Z" },
        { id: I2, feed_id: F1, subject: "Old", received_at: "2026-11-22T20:00:00Z", created_at: "2026-11-23T06:40:00Z" },
        { id: I3, feed_id: F2, subject: "Off", received_at: "2026-11-24T06:00:00Z", created_at: "2026-11-24T06:40:00Z" },
      ],
      summaries: [
        { newsletter_id: I1, summary_text: "Invented news one.", created_at: "2026-11-24T06:41:00Z" },
        { newsletter_id: I2, summary_text: "Stored yesterday.", created_at: "2026-11-23T06:41:00Z" },
        { newsletter_id: I3, summary_text: "Switched off.", created_at: "2026-11-24T06:41:00Z" },
      ],
    });
    await seed({
      user_id: B,
      feeds: [{ id: "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c", title: "Other User Letter", feed_url: "https://other.invented.example/rss" }],
      newsletters: [
        { id: "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d", feed_id: "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c", subject: "B", received_at: "2026-11-24T06:00:00Z", created_at: "2026-11-24T06:45:00Z" },
      ],
      summaries: [{ newsletter_id: "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d", summary_text: "Not for A.", created_at: "2026-11-24T06:46:00Z" }],
    });

    const out = await loadLatestBriefing(readersFor("token-a"), { leadMinutes: 30, now: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.deliveryAt).toBe("2026-11-24T07:00:00.000Z");
    expect(out.value.items.map((i) => [i.id, i.source])).toEqual([[I1, "Invented Weekly"]]);
    const spoken = scriptFor(out.value).sentences.map((s) => s.text).join(" ");
    expect(spoken).toContain("Invented news one.");
    expect(spoken).not.toMatch(/Stored yesterday|Switched off|Not for A/);

    const outB = await loadLatestBriefing(readersFor("token-b"), { leadMinutes: 30, now: NOW });
    expect(outB.ok && outB.value.items.map((i) => i.source)).toEqual(["Other User Letter"]);
  });

  it("an empty window is an empty briefing, and the window needs the server key", async () => {
    const { readersFor, client } = setup();
    const out = await loadLatestBriefing(readersFor("token-a"), { leadMinutes: 30, now: NOW });
    expect(out.ok && out.value.items).toEqual([]);
    if (out.ok) expect(scriptFor(out.value).sentences.map((s) => s.text)).toEqual(["No new newsletters since your last briefing."]);
    // The user's own session cannot call delivery_due_at.
    const asUser = client("publishable-marker", "token-a");
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await asUser.rpc(fn, args);
      if (error) throw new Error(`${fn} failed`);
      return data;
    };
    expect(await loadLatestBriefing({ user: asUser, rpc }, { leadMinutes: 30, now: NOW })).toEqual({ ok: false, error: "load_failed" });
  });
});
