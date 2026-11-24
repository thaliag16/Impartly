// The newsletter catalog (data/newsletter-catalog.json): a small, editable list of popular
// newsletters with their homepage and, where one is known, their official feed URL.
//
// Every entry carries `verified`. An entry is verified only after `npm run verify:catalog`
// (run from a GitHub runner, which can reach the sites) found a valid feed at it. Entries
// written without that check say `verified: false`; discovery still validates any feed
// live before it is stored, so an unverified entry can fail but cannot store a bad feed.

import rawCatalog from "../../../data/newsletter-catalog.json";

export interface CatalogEntry {
  id: string;
  name: string;
  /** Other names a user might type. */
  aliases?: string[];
  homepageUrl: string;
  /** The official feed, if known. null: discover from the homepage. */
  feedUrl: string | null;
  verified: boolean;
  /**
   * The newsletter's public archive page, for newsletters with no feed (read by the
   * archive source). Absent: the homepage is checked as an archive if no feed is found.
   */
  archiveUrl?: string;
  /** Where the feed URL came from, or why there is none. */
  note?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;

/** Checks the catalog's shape. Returns a list of problems (empty when valid). */
export function validateCatalog(data: unknown): string[] {
  const problems: string[] = [];
  if (!data || typeof data !== "object" || !Array.isArray((data as { entries?: unknown }).entries)) {
    return ["catalog must be an object with an entries array"];
  }
  const ids = new Set<string>();
  for (const [i, e] of ((data as { entries: unknown[] }).entries).entries()) {
    const at = `entries[${i}]`;
    if (!e || typeof e !== "object") {
      problems.push(`${at} is not an object`);
      continue;
    }
    const x = e as Record<string, unknown>;
    if (typeof x.id !== "string" || !ID.test(x.id)) problems.push(`${at}.id is missing or malformed`);
    else if (ids.has(x.id)) problems.push(`${at}.id ${x.id} is duplicated`);
    else ids.add(x.id);
    if (typeof x.name !== "string" || !x.name.trim()) problems.push(`${at}.name is missing`);
    for (const key of ["homepageUrl", "feedUrl", "archiveUrl"] as const) {
      const v = x[key];
      if (key === "feedUrl" && v === null) continue;
      if (key === "archiveUrl" && v === undefined) continue;
      if (typeof v !== "string" || !/^https:\/\/[^\s/]+\.[^\s/]+/.test(v)) problems.push(`${at}.${key} must be an https URL`);
    }
    if (typeof x.verified !== "boolean") problems.push(`${at}.verified must be true or false`);
    if (x.aliases !== undefined && (!Array.isArray(x.aliases) || x.aliases.some((a) => typeof a !== "string"))) {
      problems.push(`${at}.aliases must be a list of strings`);
    }
  }
  return problems;
}

export function loadCatalog(data: unknown = rawCatalog): CatalogEntry[] {
  const problems = validateCatalog(data);
  if (problems.length) throw new Error(`newsletter catalog is invalid: ${problems.join("; ")}`);
  return (data as { entries: CatalogEntry[] }).entries;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Finds an entry by id, name or alias (ignoring case, spaces and punctuation), or by
 * homepage host. */
export function catalogLookup(catalog: readonly CatalogEntry[], input: string): CatalogEntry | null {
  const q = norm(input);
  if (!q) return null;
  for (const e of catalog) {
    if ([e.id, e.name, ...(e.aliases ?? [])].some((n) => norm(n) === q)) return e;
  }
  let host: string | null = null;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`).hostname.replace(/^www\./, "");
  } catch {
    host = null;
  }
  if (host) {
    for (const e of catalog) {
      if (new URL(e.homepageUrl).hostname.replace(/^www\./, "") === host) {
        // Only a bare homepage matches; a deeper URL may be a different publication on the same site.
        const path = input.trim().replace(/^[a-z]+:\/\//i, "").replace(/^[^/]+/, "");
        if (path === "" || path === "/") return e;
      }
    }
  }
  return null;
}

/** Searches names and aliases for the picker (case-insensitive substring). */
export function searchCatalog(catalog: readonly CatalogEntry[], query: string, limit = 10): CatalogEntry[] {
  const q = norm(query);
  if (!q) return [];
  return catalog.filter((e) => [e.name, ...(e.aliases ?? [])].some((n) => norm(n).includes(q))).slice(0, limit);
}
