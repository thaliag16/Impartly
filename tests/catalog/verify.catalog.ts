// Live check of data/newsletter-catalog.json (`npm run verify:catalog`).
//
// For each entry it runs the same discovery the app uses (polite fetcher: robots.txt,
// SSRF checks, size and time limits, Impartly user agent) and reports whether a valid RSS
// or Atom feed was found, where, and whether it is the catalog's feed URL. It changes
// nothing: flipping an entry to `verified: true` is a separate, reviewed edit.
//
// Report only: an unreachable or feedless site does not fail the run (sites change; that
// is information, not a code failure). The run fails only if the harness itself breaks.
// Without VERIFY_CATALOG=1 it skips, so it never runs by accident on a machine without
// internet access.

import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../lib/sources/web/catalog";
import { discoverFeed, type DiscoveryResult } from "../../lib/sources/web/discover";
import { createWebFetcher } from "../../lib/sources/web/fetcher";

const enabled = process.env.VERIFY_CATALOG === "1";

describe.skipIf(!enabled)("newsletter catalog, checked live", () => {
  it("reports which entries resolve to a valid feed", async () => {
    const catalog = loadCatalog();
    const rows: string[] = [];
    let found = 0;
    for (const entry of catalog) {
      // One fetcher per entry, so each site's robots.txt is read fresh.
      const result = await discoverFeed(entry.id, createWebFetcher(), [entry]);
      if (result.ok) {
        found++;
        const same = entry.feedUrl ? (result.feed.feedUrl === entry.feedUrl ? "yes" : "no (different URL)") : "n/a (none listed)";
        rows.push(`| ${entry.id} | valid ${result.feed.format} feed | ${result.feed.feedUrl} | ${result.feed.itemCount} | ${same} | |`);
      } else {
        const failed = result as Extract<DiscoveryResult, { ok: false }>;
        rows.push(`| ${entry.id} | no feed found (${failed.reason}) | | | ${entry.feedUrl ? "no" : "n/a"} | ${failed.lastError ?? ""} |`);
      }
    }
    const table = [
      `### Newsletter catalog check: ${found} of ${catalog.length} entries resolved to a valid feed`,
      "",
      "| Entry | Result | Feed URL found | Items | Matches catalog feedUrl | Last error |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
      "Report only. To mark an entry verified, set `verified: true` (and fix `feedUrl` if it differs) in a reviewed commit.",
    ].join("\n");
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
    expect(rows).toHaveLength(catalog.length);
  });
});

if (!enabled) {
  console.warn("[catalog] VERIFY_CATALOG is not 1: skipping the live catalog check (it needs the public internet).");
}
