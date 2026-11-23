import { describe, expect, it } from "vitest";
import { createFakeGoogle, gmailFixture } from "../../tests/mail/fake-gmail";
import { createGmailAdapter, parseGmailMessage, type GmailMessage } from "./gmail/adapter";
import { detectNewsletter, pullNewsletters, selectNewsletters, toSummarizerInput, type NewsletterSource } from "./newsletters";
import type { MailMessage } from "./types";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const SINCE = new Date(NOW - 24 * 3600 * 1000);
const fixture = (id: string) => parseGmailMessage(gmailFixture<GmailMessage>(`messages/19a0c0ffee00000${id}.json`));
const none = new Set<string>();

const SOURCES: NewsletterSource[] = [
  { senderAddress: "almanac@tidewater.example", included: true },
  { senderAddress: "deals@gadget-deals.example", included: false },
  { senderAddress: "Editor@Harbor-Notes.example", included: true }, // case-insensitive
];

const base: MailMessage = {
  id: "x",
  from: { address: "someone@mail.example" },
  subject: "s",
  receivedAt: "2026-11-23T10:00:00.000Z",
  headers: {},
  bulkCategory: false,
  html: "<p>Hello there.</p>",
};

describe("newsletter detection", () => {
  it("List-Unsubscribe or List-Id alone is enough", () => {
    expect(detectNewsletter(fixture("1"), none)).toEqual({
      isNewsletter: true,
      reasons: ["list-unsubscribe header", "list-id header"],
    });
    expect(detectNewsletter({ ...base, headers: { "list-id": "<x.list.example>" } }, none).isNewsletter).toBe(true);
  });

  it("a known sender is a newsletter without any list header", () => {
    const m = fixture("5");
    expect(detectNewsletter(m, none).isNewsletter).toBe(false);
    expect(detectNewsletter(m, new Set(["almanac@tidewater.example"]))).toEqual({ isNewsletter: true, reasons: ["known sender"] });
  });

  it("heuristics need two weak signals", () => {
    expect(detectNewsletter(fixture("8"), none)).toEqual({
      isNewsletter: true,
      reasons: ["precedence bulk", "bulk category", "unsubscribe link"],
    });
    // One weak signal is not enough.
    expect(detectNewsletter({ ...base, bulkCategory: true }, none).isNewsletter).toBe(false);
    expect(detectNewsletter({ ...base, html: "<p>To unsubscribe, reply.</p>" }, none).isNewsletter).toBe(false);
    // Two are.
    expect(
      detectNewsletter({ ...base, from: { address: "digest@x.example" }, html: "<p>View this email in your browser</p>" }, none),
    ).toEqual({ isNewsletter: true, reasons: ["newsletter sender name", "view in browser link"] });
  });

  it("a personal message is not a newsletter", () => {
    expect(detectNewsletter(fixture("4"), none).isNewsletter).toBe(false);
  });

  it("an auto-reply is never a newsletter, even with list headers", () => {
    const m = { ...base, headers: { "auto-submitted": "auto-replied", "list-id": "<x.example>" } };
    expect(detectNewsletter(m, none).isNewsletter).toBe(false);
  });
});

describe("selecting the user's newsletters", () => {
  const all = ["1", "2", "3", "4", "5", "6", "7", "8"].map(fixture);
  const sources = SOURCES.map((s) => ({ ...s, senderAddress: s.senderAddress.toLowerCase() }));

  it("keeps included and new newsletter senders, drops switched-off senders, personal mail and old mail", () => {
    const r = selectNewsletters(all, { sources, since: SINCE });
    expect(r.newsletters.map((n) => n.providerMessageId).sort()).toEqual([
      "19a0c0ffee000001", // list headers, new sender
      "19a0c0ffee000002", // known, included
      "19a0c0ffee000003", // list header, new sender
      "19a0c0ffee000005", // known, included, no headers
      "19a0c0ffee000008", // heuristics, new sender
    ]);
    expect(r.skipped).toEqual({ beforeSince: 1, notNewsletter: 1, excluded: 1, empty: 0 });
    expect(r.discoveredSenders).toEqual([
      { address: "news@brightline-weekly.example", name: "Brightline Weekly" },
      { address: "digest@quarry-ledger.example", name: "Quarry Ledger" },
      { address: "lettre@cafe-lettre.example", name: "Café Lettre" },
    ]);
  });

  it("sources match case-insensitively", () => {
    const r = selectNewsletters([fixture("2")], { sources: SOURCES, since: SINCE });
    expect(r.newsletters).toHaveLength(1);
    expect(r.discoveredSenders).toEqual([]);
  });

  it("the since window is inclusive and applies even if the provider returned older mail", () => {
    const m = { ...base, headers: { "list-id": "<x.example>" } };
    const at = (iso: string) => ({ ...m, id: iso, receivedAt: iso });
    const r = selectNewsletters([at("2026-11-22T12:00:00.000Z"), at("2026-11-22T11:59:59.999Z")], { sources: [], since: SINCE });
    expect(r.newsletters.map((n) => n.providerMessageId)).toEqual(["2026-11-22T12:00:00.000Z"]);
  });

  it("duplicate message ids are kept once; a newsletter with no visible text is skipped", () => {
    const m = { ...base, headers: { "list-id": "<x.example>" } };
    const hiddenOnly = { ...m, id: "h", html: `<div style="display:none">only hidden</div>` };
    const r = selectNewsletters([m, m, hiddenOnly], { sources: [], since: SINCE });
    expect(r.newsletters).toHaveLength(1);
    expect(r.skipped.empty).toBe(1);
  });

  it("produces summarizer input with visible text only", () => {
    const r = selectNewsletters([fixture("2")], { sources: [], since: SINCE });
    const input = toSummarizerInput(r.newsletters[0]);
    expect(input.from).toBe("Harbor Notes <editor@harbor-notes.example>");
    expect(input.subject).toBe("Two more evening ferries");
    expect(input.receivedAt).toBe("2026-11-23T07:30:00.000Z");
    expect(input.text).not.toContain("HIDDEN-MARKER");
    expect(input.text).toContain("Westport ferry");
  });

  it("caps body length", () => {
    const m = { ...base, headers: { "list-id": "<x.example>" }, html: `<p>${"Long sentence here. ".repeat(500)}</p>` };
    const r = selectNewsletters([m], { sources: [], since: SINCE, maxChars: 200 });
    expect(r.newsletters[0].truncated).toBe(true);
    expect(r.newsletters[0].bodyText.length).toBeLessThanOrEqual(200);
  });

  it("end to end through the Gmail adapter and the fake Gmail API", async () => {
    const google = createFakeGoogle({ accessToken: "invented-access-token-1" });
    const adapter = createGmailAdapter({
      tokens: { get: async () => "invented-access-token-1", refresh: async () => "invented-access-token-1" },
      fetch: google.fetch,
    });
    const r = await pullNewsletters(adapter, { sources, since: SINCE });
    expect(r.newsletters.map((n) => n.senderAddress)).toEqual([
      "lettre@cafe-lettre.example",
      "digest@quarry-ledger.example",
      "editor@harbor-notes.example",
      "news@brightline-weekly.example",
      "almanac@tidewater.example",
    ]);
    // Old mail was filtered by the adapter itself here.
    expect(r.skipped).toEqual({ beforeSince: 0, notNewsletter: 1, excluded: 1, empty: 0 });
    for (const n of r.newsletters) {
      expect(n.bodyText).not.toMatch(/HIDDEN-MARKER|PLAINONLY-MARKER|https?:\/\//);
      expect(n.bodyText.length).toBeGreaterThan(20);
    }
  });
});
