import { describe, expect, it } from "vitest";
import { MAX_CHUNK_CHARS } from "../speech/sentences";
import { assembleBriefing, type BriefingItem } from "./script";

// Invented newsletters and summaries only.
const item = (over: Partial<BriefingItem> & Pick<BriefingItem, "id" | "feedId" | "source">): BriefingItem => ({
  subject: "",
  summary: "A summary sentence.",
  partial: false,
  receivedAt: "2026-11-24T05:00:00Z",
  ...over,
});

const FEED_A = "11111111-1111-4111-8111-111111111111";
const FEED_B = "22222222-2222-4222-8222-222222222222";
const FEED_C = "33333333-3333-4333-8333-333333333333";

const ITEMS: BriefingItem[] = [
  item({
    id: "n1",
    feedId: FEED_A,
    source: "The Invented Ledger",
    subject: "Larkspur Robotics raises a Series B",
    summary: "Larkspur Robotics raised $40 million. The round was led by Fernhill Capital.",
    receivedAt: "2026-11-24T06:00:00Z",
  }),
  item({
    id: "n2",
    feedId: FEED_B,
    source: "Quarry Weekly",
    summary: "Chip makers rallied on Friday. Sales may grow about 40%.",
    receivedAt: "2026-11-24T04:00:00Z",
  }),
  item({
    id: "n3",
    feedId: FEED_A,
    source: "The Invented Ledger",
    subject: "Morning notes",
    summary: "Two funds closed this week.",
    receivedAt: "2026-11-24T03:00:00Z",
  }),
];

const texts = (script: ReturnType<typeof assembleBriefing>) => script.sentences.map((s) => s.text);

describe("assembleBriefing", () => {
  it("groups issues by newsletter, with spoken transitions, an intro and an outro", () => {
    const script = assembleBriefing(ITEMS);
    expect(texts(script)).toEqual([
      "Here is your briefing: 3 stories from 2 newsletters.",
      "First, The Invented Ledger.",
      "Morning notes.",
      "Two funds closed this week.",
      "Larkspur Robotics raises a Series B.",
      "Larkspur Robotics raised $40 million.",
      "The round was led by Fernhill Capital.",
      "Finally, Quarry Weekly.",
      "Chip makers rallied on Friday.",
      "Sales may grow about 40%.",
      "That's your briefing.",
    ]);
    expect(script.sections.map((s) => s.title)).toEqual(["The Invented Ledger", "Quarry Weekly"]);
    expect(script.storyCount).toBe(3);
  });

  it("marks each sentence's kind, section and story, and numbers sentences in play order", () => {
    const script = assembleBriefing(ITEMS);
    expect(script.sentences.map((s) => s.index)).toEqual(script.sentences.map((_, i) => i));
    expect(script.sentences[0]).toMatchObject({ kind: "transition", section: null, itemId: null });
    expect(script.sentences[1]).toMatchObject({ kind: "transition", section: 0, itemId: null });
    expect(script.sentences[2]).toMatchObject({ kind: "headline", section: 0, itemId: "n3" });
    expect(script.sentences[3]).toMatchObject({ kind: "summary", section: 0, itemId: "n3" });
    expect(script.sentences.at(-1)).toMatchObject({ kind: "transition", section: null });
    // Each section knows where it starts, so the player can skip to it.
    expect(script.sections.map((s) => s.firstSentence)).toEqual([1, 7]);
  });

  it("follows the user's newsletter order, then puts the rest newest first", () => {
    const withC = [
      ...ITEMS,
      item({ id: "n4", feedId: FEED_C, source: "Copper Notes", receivedAt: "2026-11-24T07:00:00Z" }),
    ];
    expect(assembleBriefing(withC, { feedOrder: [FEED_B] }).sections.map((s) => s.title)).toEqual([
      "Quarry Weekly",
      "Copper Notes",
      "The Invented Ledger",
    ]);
    // Unknown and repeated ids in the order are ignored.
    expect(
      assembleBriefing(withC, { feedOrder: ["99999999-9999-4999-8999-999999999999", FEED_A, FEED_A] }).sections.map(
        (s) => s.title,
      ),
    ).toEqual(["The Invented Ledger", "Copper Notes", "Quarry Weekly"]);
  });

  it("uses Next for middle sections and no ordinal when there is only one newsletter", () => {
    const three = [
      ...ITEMS,
      item({ id: "n4", feedId: FEED_C, source: "Copper Notes", receivedAt: "2026-11-24T01:00:00Z" }),
    ];
    expect(texts(assembleBriefing(three)).filter((t) => /^(First|Next|Finally),/.test(t))).toEqual([
      "First, The Invented Ledger.",
      "Next, Quarry Weekly.",
      "Finally, Copper Notes.",
    ]);
    const one = assembleBriefing([ITEMS[1]]);
    expect(texts(one).slice(0, 2)).toEqual(["Here is your briefing: 1 story from 1 newsletter.", "From Quarry Weekly."]);
  });

  it("says so when there is nothing new", () => {
    const script = assembleBriefing([]);
    expect(texts(script)).toEqual(["No new newsletters since your last briefing."]);
    expect(script.sections).toEqual([]);
  });

  it("says a partial issue is a preview, before its summary", () => {
    const script = assembleBriefing([item({ id: "p", feedId: FEED_A, source: "Ledger", subject: "Paid post", partial: true, summary: "Only the start was public." })]);
    expect(texts(script)).toContain("This one is a preview; the rest is for paid subscribers.");
    const i = texts(script).indexOf("This one is a preview; the rest is for paid subscribers.");
    expect(texts(script)[i + 1]).toBe("Only the start was public.");
  });

  it("speaks titles and subjects cleanly: no URLs, markup or runaway length, and ends each with a stop", () => {
    const script = assembleBriefing([
      item({
        id: "x",
        feedId: FEED_A,
        source: "  Ledger <b>Daily</b> | https://ledger.example/feed  ",
        subject: "Big news!!! See https://ledger.example/p/1 " + "very ".repeat(60),
        summary: "Fine.",
      }),
    ]);
    const all = texts(script).join(" ");
    expect(all).not.toMatch(/https?:|<|>/);
    expect(script.sections[0].title).toBe("Ledger Daily");
    for (const s of script.sentences) expect(s.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    const headline = script.sentences.filter((s) => s.kind === "headline").map((s) => s.text).join(" ");
    expect(headline).toMatch(/^Big news!+ See very very/);
    expect(headline.length).toBeLessThanOrEqual(161);
    expect(headline).toMatch(/[.!?]$/);
  });

  it("falls back to the sender name, then 'a newsletter', when a source has no title", () => {
    const script = assembleBriefing([item({ id: "m", feedId: null, source: "   ", summary: "Mail item." })]);
    expect(texts(script)[1]).toBe("From a newsletter.");
  });

  it("never drops a word of a summary, however long", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Clause number ${i} goes on, and on`).join(", ") + ".";
    const script = assembleBriefing([item({ id: "l", feedId: FEED_A, source: "Ledger", summary: long })]);
    const spoken = script.sentences.filter((s) => s.kind === "summary").map((s) => s.text).join(" ");
    expect(spoken.split(/\s+/)).toEqual(long.split(/\s+/));
  });

  it("skips an issue whose summary is empty", () => {
    const script = assembleBriefing([item({ id: "e", feedId: FEED_A, source: "Ledger", summary: "  " }), ITEMS[1]]);
    expect(script.storyCount).toBe(1);
    expect(script.sections.map((s) => s.title)).toEqual(["Quarry Weekly"]);
  });
});
