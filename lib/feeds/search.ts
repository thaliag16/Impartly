// Catalog search for the picker, run in the browser on the catalog the page passes down
// (names, aliases and site hosts only; no network). Same matching as searchCatalog in
// lib/sources/web/catalog.ts: case, spaces and punctuation ignored, substring match.

import type { CatalogPick } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function matchPicks(picks: readonly CatalogPick[], query: string, limit = 6): CatalogPick[] {
  const q = norm(query);
  if (!q) return [];
  return picks.filter((p) => [p.name, ...p.aliases, p.site].some((n) => norm(n).includes(q))).slice(0, limit);
}
