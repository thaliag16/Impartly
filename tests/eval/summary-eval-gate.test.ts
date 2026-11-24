// The summary eval's CI gate (scripts/summary-eval-gate.sh, .github/workflows/checks.yml):
// it runs by hand always, on a pull request only when a file the score depends on changed,
// and says why when it skips. Run against throwaway git repositories, no network.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/summary-eval-gate.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A repo with a base commit and a head commit that changes `files`. */
function repo(files: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-gate-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "changed\n");
  }
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

function gate(cwd: string, env: Record<string, string>) {
  const output = path.join(cwd, ".gh-output");
  const summary = path.join(cwd, ".gh-summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env } as unknown as NodeJS.ProcessEnv,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    run: /^run=(\w+)$/m.exec(readFileSync(output, "utf8"))?.[1],
    summary: readFileSync(summary, "utf8"),
  };
}

const pr = (r: ReturnType<typeof repo>, key = "true") => ({
  EVENT: "pull_request",
  BASE_SHA: r.base,
  HEAD_SHA: r.head,
  HAS_KEY: key,
});

describe("summary eval gate", () => {
  it.each([
    "lib/summarizer/provider.ts",
    "lib/eval/grader.ts",
    "fixtures/newsletters/21-new.json",
    "tests/eval/summaries.eval.ts",
    "vitest.eval.config.mts",
    ".github/workflows/checks.yml",
    "scripts/summary-eval-gate.sh",
  ])("runs on a pull request that changes %s", (file) => {
    const r = repo(["app/listen/page.tsx", file]);
    const out = gate(r.dir, pr(r));
    expect(out.status).toBe(0);
    expect(out.run).toBe("true");
    expect(out.summary).toContain(file);
  });

  it("skips, with a notice and a summary line, when no eval file changed", () => {
    const r = repo(["app/listen/page.tsx", "lib/briefing/player.ts", "lib/summarizerish.ts", "docs/lib/eval/x.md"]);
    const out = gate(r.dir, pr(r));
    expect(out.status).toBe(0);
    expect(out.run).toBe("false");
    expect(out.stdout).toContain("::notice title=Summary eval skipped::");
    expect(out.summary).toMatch(/skipped/i);
  });

  it("runs when started by hand", () => {
    const r = repo(["app/listen/page.tsx"]);
    const out = gate(r.dir, { EVENT: "workflow_dispatch", HAS_KEY: "true" });
    expect(out.run).toBe("true");
  });

  it("skips without the secret, before looking at any file", () => {
    const r = repo(["lib/summarizer/provider.ts"]);
    const out = gate(r.dir, pr(r, "false"));
    expect(out.run).toBe("false");
    expect(out.stdout).toContain("No SUMMARY_API_KEY secret is set");
  });

  it("runs (fails safe) when the changed files cannot be listed", () => {
    const r = repo(["app/listen/page.tsx"]);
    const out = gate(r.dir, { ...pr(r), BASE_SHA: "0".repeat(40) });
    expect(out.status).toBe(0);
    expect(out.run).toBe("true");
    expect(out.stdout).toContain("could not list");
  });

  it("refuses a malformed commit id instead of passing it to git", () => {
    const r = repo(["app/listen/page.tsx"]);
    const out = gate(r.dir, { ...pr(r), HEAD_SHA: "--output=/tmp/x" });
    expect(out.run).toBe("true");
    expect(out.stdout).toContain("could not list");
  });
});
