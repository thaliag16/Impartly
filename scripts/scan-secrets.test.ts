import { describe, expect, it } from "vitest";
import { findSecrets } from "./scan-secrets.mjs";

// Fake keys are assembled at run time so this file never contains one literally.
const fake = (prefix: string, body: string, n: number) => prefix + body.repeat(n);

describe("findSecrets", () => {
  it.each([
    ["Anthropic API key", fake("sk-" + "ant-", "a1B2", 10)],
    ["AWS access key ID", fake("AK" + "IA", "ABCD", 4)],
    ["GitHub token", fake("gh" + "p_", "a1B2", 10)],
    ["Google API key", fake("AI" + "za", "x", 35)],
    ["Supabase secret key", fake("sb_" + "secret_", "ab12", 8)],
    ["Private key block", "-----BEGIN " + "RSA PRIVATE KEY-----"],
    ["JSON Web Token", ["eyJ" + "a".repeat(20), "eyJ" + "b".repeat(20), "c".repeat(20)].join(".")],
  ])("flags a %s", (name, value) => {
    expect(findSecrets(`const x = "${value}";`).map((f) => f.name)).toContain(name);
  });

  it("flags a filled-in secret in an env file but not an empty one", () => {
    const env = ["ANTHROPIC_API_KEY=", "CRON_SECRET=not-empty", "MAX_SEARCHES_PER_ANSWER=2"].join("\n");
    expect(findSecrets(env, ".env.example")).toEqual([{ line: 2, name: "Filled-in secret CRON_SECRET" }]);
  });

  it("ignores env-style lines outside env files", () => {
    expect(findSecrets("CRON_SECRET=example", "README.md")).toEqual([]);
  });

  it("does not flag ordinary code or lockfile hashes", () => {
    const text = [
      'const SAMPLE_RATE = 44100;',
      '"integrity": "sha512-' + "Zm9v".repeat(20) + '=="',
      "process.env.ANTHROPIC_API_KEY",
    ].join("\n");
    expect(findSecrets(text, "app/x.ts")).toEqual([]);
  });
});
