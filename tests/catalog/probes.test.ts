// The live report's source probes (probes.ts), checked offline: the probe list holds clean
// URLs only, and link following keeps to same-site edition/archive links, never sign-in
// pages, other sites or query strings. Pages are invented (.example hosts).

import { describe, expect, it } from "vitest";
import { diagnoseIssue, editionLinks, outlineIssue, PROBE_LIMITS, PROBES } from "./probes";

describe("source probes", () => {
  it("probe URLs are clean https URLs with no query strings or fragments (no tracking parameters)", () => {
    for (const p of PROBES) {
      for (const u of [p.url, ...(p.seeds ?? [])]) {
        const url = new URL(u);
        expect(url.protocol).toBe("https:");
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
      }
    }
  });

  it("following is capped", () => {
    expect(PROBE_LIMITS.maxFollowedPages).toBeLessThanOrEqual(6);
    expect(PROBE_LIMITS.intervalMs).toBeGreaterThanOrEqual(1000);
  });

  it("editionLinks keeps same-site links hinting at a web edition or archive, without query strings", () => {
    const page = `
      <a href="/daily/issues">Past issues</a>
      <a href="/daily/issues/invented-monday?utm_source=x&amp;mbcid=1">Read online</a>
      <a href="/newsletters">All newsletters</a>
      <a href="/stories/invented-shopping-guide">An invented shopping guide</a>
      <a href="/login">Log in to the invented archive</a>
      <a href="/subscribe/daily">Subscribe to the daily</a>
      <a href="https://other.example/daily/issues">Another site's issues</a>
      <a href="https://shop.brew.example/archive">A subdomain archive</a>`;
    expect(editionLinks(page, "https://www.brew.example/subscribe")).toEqual([
      { url: "https://www.brew.example/daily/issues", text: "Past issues" },
      { url: "https://www.brew.example/daily/issues/invented-monday", text: "Read online" },
      { url: "https://www.brew.example/newsletters", text: "All newsletters" },
    ]);
  });
});

describe("diagnoseIssue", () => {
  it("reports counts and flags only, never page text", () => {
    const page = `<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script></head>
      <body><article><p>An invented opening paragraph about invented markets.</p><p>Subscribe to continue reading.</p></article>
      <script>window.__INVENTED__ = {}</script></body></html>`;
    const d = diagnoseIssue(page, "https://brief.example/p/invented");
    expect(d).toMatch(/partial yes/);
    expect(d).toMatch(/page <p> text \d+ chars in 2 paragraphs/);
    expect(d).toMatch(/main block <article>/);
    expect(d).toMatch(/isAccessibleForFree false/);
    expect(d).toMatch(/paywall notice yes/);
    expect(d).not.toMatch(/invented/i);
  });
});

describe("outlineIssue", () => {
  it("gives paths and counts with at most a 40-character snippet", () => {
    const long = "An invented sentence about invented funds and invented markets. ".repeat(10);
    const page = `<html><body><div id="post" class="body x"><div><p>${long}</p></div><div><p>${long}</p></div></div></body></html>`;
    const lines = outlineIssue(page);
    const all = lines.join("\n");
    expect(all).toMatch(/smallest block with 80% of <p> text: \[p text \d+ in 2; direct 0 in 0\] body > div#post\.body\.x/);
    expect(all).toMatch(/blocks holding exactly one <p>: 2/);
    expect(all).toMatch(/JSON-LD article nodes: 0/);
    // The snippet is the only text printed, and it is short.
    expect(all.split("invented sentence").length - 1).toBeLessThanOrEqual(1);
    for (const l of lines) expect(l.length).toBeLessThan(400);
  });
});
