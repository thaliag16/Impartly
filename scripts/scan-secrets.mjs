#!/usr/bin/env node
// Local secret scan: no network, no paid service. Checks every file git would
// commit (tracked plus untracked-but-not-ignored) for common key formats and for
// filled-in secret values in .env-style files. Exits 1 on any finding.
//
// Patterns are deliberately specific to keep false positives near zero. If one
// fires on something that is not a secret, change the content, not the pattern.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PATTERNS = [
  { name: "Private key block", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: "AWS access key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Google OAuth client secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}\b/ },
];

// In .env-style files, any variable whose name says it is secret must be empty.
const SECRET_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i;
const ENV_FILE = /(?:^|\/)\.env(?:\.[^/]*)?$/;

/** @returns {{ line: number, name: string }[]} */
export function findSecrets(text, path = "") {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push({ line: i + 1, name });
    }
    if (ENV_FILE.test(path)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && SECRET_NAME.test(m[1])) {
        const value = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
        if (value) findings.push({ line: i + 1, name: `Filled-in secret ${m[1]}` });
      }
    }
  });
  return findings;
}

function filesToScan() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

function main() {
  let total = 0;
  for (const path of filesToScan()) {
    let buf;
    try {
      if (statSync(path).size > 5_000_000) continue;
      buf = readFileSync(path);
    } catch {
      continue; // deleted in the working tree
    }
    if (buf.includes(0)) continue; // binary
    for (const f of findSecrets(buf.toString("utf8"), path)) {
      // Never print the matched value: only where it is and what it looks like.
      console.error(`${path}:${f.line}  ${f.name}`);
      total++;
    }
  }
  if (total > 0) {
    console.error(`\nscan:secrets found ${total} possible secret(s). Remove them and rotate any real key.`);
    process.exit(1);
  }
  console.log("scan:secrets: 0 findings");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
