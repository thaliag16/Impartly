// Boundaries of the source layer, checked on the source text:
//   * every web request goes through safe-fetch.ts (the SSRF-checked, bounded fetcher):
//     no other module in lib/ or app/ opens sockets or calls fetch on a web-source URL
//   * safe-fetch.ts sends GET only
//   * the pipeline reaches newsletters only through the source interface (lib/sources),
//     never the mail module's pull functions directly

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...files(rel));
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

const SOURCE_FILES = [...files("lib"), ...files("app")];
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("source layer boundaries", () => {
  it("only safe-fetch.ts imports Node's http, https or dns modules", () => {
    const offenders = SOURCE_FILES.filter((f) => /from\s+["']node:(?:http|https|dns|dns\/promises|tls)["']|require\(["'](?:node:)?(?:http|https|dns|tls)["']\)/.test(read(f)));
    expect(offenders).toEqual(["lib/sources/web/safe-fetch.ts"]);
  });

  it("nothing in lib/sources calls the global fetch", () => {
    const offenders = files("lib/sources").filter((f) => /(?<![.\w])fetch\s*\(/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("safe-fetch sends GET and nothing else", () => {
    const src = read("lib/sources/web/safe-fetch.ts");
    const methods = [...src.matchAll(/method:\s*["']([A-Z]+)["']/g)].map((m) => m[1]);
    expect(methods).toEqual(["GET"]);
  });

  it("the pipeline reads newsletters only through the source interface", () => {
    const run = read("lib/pipeline/run.ts");
    expect(run).not.toMatch(/pullNewsletters|selectNewsletters|listMessagesSince|MailAuthError/);
    expect(run).toMatch(/from "\.\.\/sources\/types"/);
  });
});
