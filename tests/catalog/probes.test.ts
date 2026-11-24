// The live report's source probes (probes.ts), checked offline: the probe list holds clean
// URLs only, and link following keeps to same-site edition/archive links, never sign-in
// pages, other sites or query strings. Pages are invented (.example hosts).

import { describe, expect, it } from "vitest";
import { editionLinks, PROBE_LIMITS, PROBES } from "./probes";

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
