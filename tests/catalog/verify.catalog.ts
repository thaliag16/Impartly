// Live check of data/newsletter-catalog.json (`npm run verify:catalog`).
//
// For each entry it runs the same discovery the app uses (polite fetcher: robots.txt,
// SSRF checks, size and time limits, Impartly user agent) and reports whether a valid RSS
// or Atom feed was found, where, and whether it is the catalog's feed URL. It changes
// nothing: flipping an entry to `verified: true` is a separate, reviewed edit.
//
// For every entry with no feed, it also tries the public web archive fallback
// (lib/sources/web/archive-source.ts) on the catalog's archiveUrl, else its homepage, and
// reports what it finds: how issues were found, how many, the newest date, and for one
// sample issue (the newest) how much text was read and whether it is partial. Only
// counts and codes are reported, never issue text. Requests stay within the archive
// source's limits (robots.txt, Crawl-delay, at most 1 request per second per site).
//
// Report only: an unreachable or feedless site does not fail the run (sites change; that
// is information, not a code failure). The run fails only if the harness itself breaks.
// Without VERIFY_CATALOG=1 it skips, so it never runs by accident on a machine without
// internet access.

import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../lib/sources/web/catalog";
import { discoverFeed, type DiscoveryResult } from "../../lib/sources/web/discover";
import { createPacer, discoverArchiveAt, webArchiveSource } from "../../lib/sources/web/archive-source";
import { createWebFetcher } from "../../lib/sources/web/fetcher";
import { SourceFetchError } from "../../lib/sources/types";

const enabled = process.env.VERIFY_CATALOG === "1";

describe.skipIf(!enabled)("newsletter catalog, checked live", () => {
  it("reports which entries resolve to a valid feed", async () => {
    const catalog = loadCatalog();
    const rows: string[] = [];
    const archiveRows: string[] = [];
    let found = 0;
    let archives = 0;
    let noFeed = 0;
    for (const entry of catalog) {
      // One fetcher per entry, so each site's robots.txt is read fresh.
      const fetcher = createWebFetcher();
      const pacer = createPacer();
      const result = await discoverFeed(entry.id, fetcher, [entry], { pacer });
      if (!result.ok || result.feed.format === "archive") {
        noFeed++;
        archiveRows.push(await archiveRow(entry.id, entry.archiveUrl ?? entry.homepageUrl, fetcher, pacer, (n) => (archives += n)));
      }
      if (result.ok && result.feed.format === "archive") {
        rows.push(`| ${entry.id} | no feed; public archive found (${result.feed.archive?.method}) | ${result.feed.feedUrl} | ${result.feed.itemCount} | ${entry.feedUrl ? "no" : "n/a"} | |`);
      } else if (result.ok) {
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
      "",
      `### Public archive fallback: ${archives} of ${noFeed} entries without a feed have a readable public archive`,
      "",
      "| Entry | Archive page tried | Result | Method | Issues listed | Newest listed | Sample issue read | Chars | Partial | Error |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...archiveRows,
      "",
      "Report only. The sample issue is the newest one the archive source would fetch (one page, at most).",
    ].join("\n");
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
    expect(rows).toHaveLength(catalog.length);
  });
});

/** One report row for the archive fallback on an entry with no feed. Counts and codes only. */
async function archiveRow(
  id: string,
  url: string,
  fetcher: ReturnType<typeof createWebFetcher>,
  pacer: ReturnType<typeof createPacer>,
  count: (n: number) => void,
): Promise<string> {
  try {
    const { archive, error } = await discoverArchiveAt(fetcher, url, pacer);
    if (!archive) return `| ${id} | ${url} | no archive | | | | | | | ${error ?? ""} |`;
    count(1);
    // Read the newest issue only (limit 1), from the last year (some archives are monthly
    // or slower; the app itself reads only since the last pull).
    const source = webArchiveSource(
      { id, archiveUrl: archive.archiveUrl, title: archive.title, etag: null, lastModified: null, knownUrls: [] },
      fetcher,
      { pacer },
    );
    let sample = "none read";
    let chars = "";
    let partial = "";
    let err = "";
    try {
      const pulled = await source.pull({ since: new Date(Date.now() - 365 * 24 * 3600 * 1000), limit: 1, maxChars: 20_000, firstPull: true });
      const item = pulled.items[0];
      if (item) {
        sample = "yes";
        chars = String(item.bodyText.length);
        partial = item.partial ? "yes" : "no";
      }
    } catch (e) {
      err = e instanceof SourceFetchError ? e.code : "error";
    }
    return `| ${id} | ${url} | archive found | ${archive.method} | ${archive.issueCount} | ${archive.latestIssueAt ?? "undated"} | ${sample} | ${chars} | ${partial} | ${err} |`;
  } catch (e) {
    return `| ${id} | ${url} | error | | | | | | | ${e instanceof SourceFetchError ? e.code : "error"} |`;
  }
}

if (!enabled) {
  console.warn("[catalog] VERIFY_CATALOG is not 1: skipping the live catalog check (it needs the public internet).");
}
