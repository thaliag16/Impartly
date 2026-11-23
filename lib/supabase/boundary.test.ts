// The service-role key must never reach a browser. These tests fail if:
//   * any module other than lib/supabase/admin.ts reads SUPABASE_SECRET_KEY;
//   * a module that reads it, or imports admin.ts, is not marked `import "server-only"`
//     (Next.js then fails the build if a client component imports it, even indirectly);
//   * a client component ("use client") imports, directly or through other modules,
//     anything server-only or anything that reads the key;
//   * the key is given a NEXT_PUBLIC_ name (Next.js inlines those into browser bundles).
// The UI tests also check the built browser bundles (e2e/auth.e2e.ts).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => existsSync(f));
const isCode = (f: string) => /\.(?:[cm]?[jt]sx?)$/.test(f);
// Test code and test tooling config (never bundled into the app).
const isTest = (f: string) =>
  /\.test\.[cm]?[jt]sx?$/.test(f) || f.startsWith("tests/") || f.startsWith("e2e/") || /^(?:playwright|vitest)[\w.]*\.config\.[cm]?ts$/.test(f);
const appCode = files.filter((f) => isCode(f) && !isTest(f));
const src = (f: string) => readFileSync(f, "utf8");
// Built so this file does not match itself.
const SECRET_NAME = ["SUPABASE", "SECRET", "KEY"].join("_");

const SERVER_ONLY = /^\s*(?:\/\/[^\n]*\n|\s)*import\s+["']server-only["'];/;
const isServerOnly = (f: string) => SERVER_ONLY.test(src(f));
const isClient = (f: string) => /^\s*["']use client["']/.test(src(f));

/** Relative imports of a module, resolved to repo files. */
function imports(file: string): string[] {
  const out: string[] = [];
  for (const m of src(file).matchAll(/(?:import|export)\s[^"';]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec.startsWith(".")) continue;
    const base = path.normalize(path.join(path.dirname(file), spec));
    const hit = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((p) => files.includes(p));
    if (hit) out.push(hit);
  }
  return out;
}

function reachable(from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...imports(f));
  }
  return seen;
}

describe("the Supabase secret key stays on the server", () => {
  it("only lib/supabase/admin.ts reads it", () => {
    const readers = appCode.filter((f) => src(f).includes(SECRET_NAME));
    expect(readers).toEqual(["lib/supabase/admin.ts"]);
  });

  it("admin.ts, and every module that imports it, starts with import \"server-only\"", () => {
    expect(isServerOnly("lib/supabase/admin.ts")).toBe(true);
    const importers = appCode.filter((f) => imports(f).includes("lib/supabase/admin.ts"));
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) expect(isServerOnly(f), f).toBe(true);
  });

  it("no client component reaches a server-only module or the key, even indirectly", () => {
    const clients = appCode.filter(isClient);
    expect(clients.length).toBeGreaterThan(0); // the spike pages
    for (const c of clients) {
      for (const f of reachable(c)) {
        expect(isServerOnly(f), `${c} -> ${f}`).toBe(false);
        expect(src(f).includes(SECRET_NAME), `${c} -> ${f}`).toBe(false);
      }
    }
  });

  it("no NEXT_PUBLIC_ name holds a secret, and the example env keeps the key server-side", () => {
    for (const f of files.filter((f) => /\.(?:[cm]?[jt]sx?|json|md|ya?ml)$|^\.env/.test(f))) {
      expect(src(f), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(?:SECRET|SERVICE_ROLE|PRIVATE)/);
    }
    expect(src(".env.example")).toMatch(new RegExp(`^${SECRET_NAME}=$`, "m"));
  });

  it("the import-graph check would catch a client component importing admin.ts", () => {
    // Control: the checker itself sees through a chain of imports.
    const chain = reachable("app/api/mail/gmail/connect/route.ts");
    expect(chain.has("lib/supabase/admin.ts")).toBe(true);
  });
});
