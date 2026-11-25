import { describe, expect, it } from "vitest";
import { loadNewsletterFixtures } from "../eval/fixtures";
import { termPresent, normalizeForFacts } from "../eval/summary-grader";
import { INPUT_CHAR_CAP, trimForSummary } from "./trim";

// Cost: every character sent to the summary model is paid for. trimForSummary drops what a
// listener never hears (link targets, unsubscribe and "view in browser" lines, sponsor
// blocks, separators) and caps the text per length. Conservative on purpose: when in doubt
// a line stays, and these tests pin that the news itself survives.

describe("trimForSummary: what it drops", () => {
  it("drops link targets but keeps the link text", () => {
    expect(trimForSummary("Read [the full interview](https://seedsheet.example/larkspur?utm=1) today.", "brief")).toBe(
      "Read the full interview today.",
    );
    expect(trimForSummary("Station map (PDF): https://metronotes.example/map.pdf", "brief")).toBe("Station map (PDF):");
    expect(trimForSummary("More at www.example.com/a/b and http://x.example/y.", "brief")).toBe("More at and.");
  });

  it("drops footer lines: unsubscribe, receiving-this, view in browser, preferences, forward, copyright", () => {
    const text = [
      "Widgetco sold 12 widgets.",
      "",
      "View this email in your browser",
      "You are receiving this because you subscribed. Unsubscribe: https://seedsheet.example/u",
      "Forward this to a friend: https://weekendreads.example/share",
      "Manage your preferences | Unsubscribe",
      "Was this forwarded to you? Sign up here: https://x.example/s",
      "© 2026 Invented Media Ltd. All rights reserved.",
      "Copyright 2026 Invented Media",
      "Click here to unsubscribe from these emails.",
    ].join("\n");
    expect(trimForSummary(text, "brief")).toBe("Widgetco sold 12 widgets.");
  });

  it("drops separator lines and collapses blank lines and spaces", () => {
    expect(trimForSummary("A rose 2%.\n\n\n* * *\n---\n\nB   fell   3%.", "brief")).toBe("A rose 2%.\n\nB fell 3%.");
  });

  it("drops a sponsor block: a short sponsor heading and the paragraph under it", () => {
    const text = [
      "Larkspur raised $40 million.",
      "",
      "SPONSORED",
      "Try Acme Ledger free for 30 days.",
      "Accounting that just works.",
      "",
      "Together with Invented Bank",
      "",
      "Open an account in minutes.",
      "",
      "Shares rose 6%.",
      "",
      "Sponsored by Quillco: the pen that writes itself.",
      "",
      "The pilot starts in 2028.",
    ].join("\n");
    expect(trimForSummary(text, "brief")).toBe("Larkspur raised $40 million.\n\nShares rose 6%.\n\nThe pilot starts in 2028.");
  });
});

describe("trimForSummary: what it keeps (news is never dropped)", () => {
  it("keeps news that mentions unsubscribing, subscribers, sponsors or copyright", () => {
    const news = [
      "Gmail adds a one-click unsubscribe button for all users.",
      "Subscribers to the plan rose 20% to 1,400.",
      "The bill's sponsor, Senator Vale, said the vote is on March 3.",
      "A court ruled the copyright claim invalid.",
      "Sponsorship revenue grew 15% in the quarter, the company said in its filing.",
    ].join("\n");
    expect(trimForSummary(news, "brief")).toBe(news);
  });

  it("keeps a long paragraph even if it contains a footer word", () => {
    const long =
      "Readers can now unsubscribe from individual sections, the company said on Tuesday, a change it expects to cut complaints by 30% " +
      "while keeping 95% of subscribers, according to a memo seen by the newsletter, which also described a new pricing tier at $6 a month.";
    expect(trimForSummary(long, "brief")).toBe(long);
  });

  it("keeps a domain written without a scheme (it can be a company's name)", () => {
    expect(trimForSummary("Shop.app raised $12 million.", "brief")).toBe("Shop.app raised $12 million.");
  });

  it("keeps every key fact of every eval fixture", () => {
    for (const f of loadNewsletterFixtures()) {
      const trimmed = normalizeForFacts(trimForSummary(f.newsletter.text, f.length));
      for (const { terms } of f.keyFacts) {
        for (const term of terms) expect(termPresent(term, trimmed), `${f.id}: ${term}`).toBe(true);
      }
    }
  });

  it("makes the eval fixtures shorter, never longer", () => {
    let before = 0;
    let after = 0;
    for (const f of loadNewsletterFixtures()) {
      const t = trimForSummary(f.newsletter.text, f.length);
      expect(t.length).toBeLessThanOrEqual(f.newsletter.text.length);
      before += f.newsletter.text.length;
      after += t.length;
    }
    expect(after).toBeLessThan(before);
  });
});

describe("trimForSummary: per-length input cap", () => {
  const para = (i: number) => `Paragraph ${i} says the index rose ${i}% on the day.`;
  const big = Array.from({ length: 2000 }, (_, i) => para(i)).join("\n\n");

  it("caps by length, shortest for a headline, and cuts at a paragraph end", () => {
    expect(INPUT_CHAR_CAP.headline).toBeLessThan(INPUT_CHAR_CAP.brief);
    expect(INPUT_CHAR_CAP.brief).toBeLessThan(INPUT_CHAR_CAP.deep);
    // Never more than the pipeline already stores (DEFAULT_PIPELINE_LIMITS.maxCharsPerNewsletter).
    expect(INPUT_CHAR_CAP.deep).toBeLessThanOrEqual(20_000);
    for (const length of ["headline", "brief", "deep"] as const) {
      const t = trimForSummary(big, length);
      expect(t.length).toBeLessThanOrEqual(INPUT_CHAR_CAP[length]);
      expect(t.length).toBeGreaterThan(INPUT_CHAR_CAP[length] * 0.9);
      expect(t.startsWith(para(0))).toBe(true);
      expect(t.endsWith("on the day.")).toBe(true);
    }
  });

  it("cuts a single huge paragraph at a sentence or word end", () => {
    const t = trimForSummary("word ".repeat(10_000), "headline");
    expect(t.length).toBeLessThanOrEqual(INPUT_CHAR_CAP.headline);
    expect(t.endsWith("word")).toBe(true);
  });
});
