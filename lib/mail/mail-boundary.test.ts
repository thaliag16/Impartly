// CLAUDE.md: "Mail access is read-only and sits behind one adapter interface."
// These tests fail if any code could request a Google scope other than gmail.readonly, or
// call a Gmail endpoint that changes a mailbox, or if a fixture holds anything but
// invented .example data.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GMAIL_FIXTURES, gmailFixture } from "../../tests/mail/fake-gmail";
import { buildGmailFixtures, serialize } from "../../scripts/build-gmail-fixtures.mjs";
import { assertReadOnlyRequest, decodeBodyData, GMAIL_API_BASE, type GmailPart } from "./gmail/adapter";

const repoFiles = () =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
const isCode = (f: string) => /\.(?:[cm]?[jt]sx?|sql)$/.test(f);
const isTest = (f: string) => /\.test\.[cm]?[jt]sx?$/.test(f);
const TEXT = /\.(?:[cm]?[jt]sx?|sql|json|md|ya?ml|html|css|txt|env[^/]*)$/;

describe("Google scopes: gmail.readonly only", () => {
  // Every Google OAuth scope URL form, built so this file does not match itself.
  const googleScope = new RegExp(["https://www\\.googleapis\\.com/auth/[\\w.-]+", "https://mail\\.google\\.com/?"].join("|"), "g");

  it("no file outside tests names any Google scope other than gmail.readonly", () => {
    const offenders: string[] = [];
    for (const f of repoFiles().filter((f) => TEXT.test(f) && !isTest(f))) {
      for (const m of readFileSync(f, "utf8").matchAll(googleScope)) {
        if (m[0] !== "https://www.googleapis.com/auth/gmail.readonly") offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only lib/mail/gmail/oauth.ts builds a Google sign-in request, and nothing widens a grant", () => {
    const offenders = repoFiles()
      .filter((f) => isCode(f) && !isTest(f) && !["lib/mail/gmail/oauth.ts", "tests/mail/fake-gmail.ts"].includes(f))
      .filter((f) => /accounts\.google\.com|oauth2\.googleapis\.com|["']scope["']\s*[,:]/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    for (const f of repoFiles().filter((f) => isCode(f) && !isTest(f))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/set\(\s*["']include_granted_scopes["']/);
    }
  });
});

describe("Gmail endpoints: read-only", () => {
  it("only the Gmail adapter (and the test fake) talks to the Gmail API", () => {
    const offenders = repoFiles()
      .filter((f) => isCode(f) && !isTest(f))
      .filter((f) => !["lib/mail/gmail/adapter.ts", "tests/mail/fake-gmail.ts"].includes(f))
      .filter((f) => /gmail\.googleapis\.com|\/gmail\/v1\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the adapter source names no endpoint that changes mail, and no method but GET", () => {
    const src = readFileSync("lib/mail/gmail/adapter.ts", "utf8");
    const writePaths =
      /\/(?:send|drafts?|modify|batchModify|batchDelete|trash|untrash|labels|settings|filters|forwardingAddresses|watch|stop|import|insert|delete|attachments|history)\b/i;
    expect(src).not.toMatch(writePaths);
    expect(src).not.toMatch(/["'`](?:POST|PUT|PATCH|DELETE)["'`]/);
    expect(src).toMatch(/method: "GET"/);
  });

  it("the request guard allows the three read endpoints and refuses everything else", () => {
    const ok = [`${GMAIL_API_BASE}/profile`, `${GMAIL_API_BASE}/messages?q=x`, `${GMAIL_API_BASE}/messages/19a0c0ffee000001?format=full`];
    for (const url of ok) expect(() => assertReadOnlyRequest("GET", url)).not.toThrow();
    const refused: [string, string][] = [
      ["POST", `${GMAIL_API_BASE}/messages/send`],
      ["POST", `${GMAIL_API_BASE}/messages/19a0c0ffee000001/modify`],
      ["POST", `${GMAIL_API_BASE}/messages/batchModify`],
      ["POST", `${GMAIL_API_BASE}/messages/batchDelete`],
      ["POST", `${GMAIL_API_BASE}/messages/19a0c0ffee000001/trash`],
      ["DELETE", `${GMAIL_API_BASE}/messages/19a0c0ffee000001`],
      ["PUT", `${GMAIL_API_BASE}/messages/19a0c0ffee000001`],
      ["POST", `${GMAIL_API_BASE}/drafts`],
      ["POST", `${GMAIL_API_BASE}/labels`],
      ["GET", `${GMAIL_API_BASE}/labels`],
      ["GET", `${GMAIL_API_BASE}/settings/filters`],
      ["GET", `${GMAIL_API_BASE}/settings/forwardingAddresses`],
      ["GET", `${GMAIL_API_BASE}/messages/19a0c0ffee000001/attachments/abc`],
      ["GET", `${GMAIL_API_BASE}/messages/19a0c0ffee000001/modify`],
      ["GET", `${GMAIL_API_BASE}/messages/../settings`],
      ["GET", `https://gmail.googleapis.com/gmail/v1/users/someone-else@x.example/messages`],
      ["GET", `https://evil.example/gmail/v1/users/me/messages`],
    ];
    for (const [method, url] of refused) expect(() => assertReadOnlyRequest(method, url), `${method} ${url}`).toThrow();
  });

  it("no Google SDK is installed or imported (plain fetch only)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /^(?:googleapis|@googleapis\/|google-auth-library|@google-cloud\/)/.test(d))).toEqual([]);
    const sdkImport = /from\s+["'](?:googleapis|@googleapis\/[^"']+|google-auth-library)["']|require\(["']googleapis/;
    expect(repoFiles().filter((f) => isCode(f) && sdkImport.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("the mail module never writes to the console (tokens must never be logged)", () => {
    const offenders = repoFiles()
      .filter((f) => f.startsWith("lib/mail/") && isCode(f) && !isTest(f))
      .filter((f) => /console\./.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("Gmail fixtures: invented, .example only, in sync with their builder", () => {
  const files = Object.entries(buildGmailFixtures() as Record<string, unknown>);

  it("committed JSON matches scripts/build-gmail-fixtures.mjs (regenerate if this fails)", () => {
    expect(files.length).toBe(12);
    for (const [name, value] of files) {
      expect(readFileSync(`${GMAIL_FIXTURES}/${name}`, "utf8"), name).toBe(serialize(value));
    }
  });

  it("every address and link, in headers and decoded bodies, uses a .example domain", () => {
    const texts: string[] = [];
    for (const [name] of files) {
      const data = gmailFixture<Record<string, unknown>>(name);
      texts.push(JSON.stringify(data));
      const walk = (p?: GmailPart) => {
        if (!p) return;
        if (p.body?.data) texts.push(decodeBodyData(p.body.data, /iso-8859-1/i.test(JSON.stringify(p.headers)) ? "latin1" : "utf-8"));
        p.parts?.forEach(walk);
      };
      walk((data as { payload?: GmailPart }).payload);
    }
    const all = texts.join("\n");
    const emails = [...all.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)].map((m) => m[1].toLowerCase());
    expect(emails.length).toBeGreaterThan(10);
    expect(emails.filter((d) => !d.endsWith(".example"))).toEqual([]);
    const hosts = [...all.matchAll(/https?:\/\/([^/\s"'<>?]+)/g)].map((m) => m[1].toLowerCase());
    expect(hosts.length).toBeGreaterThan(5);
    expect(hosts.filter((h) => !h.endsWith(".example") && h !== "www.googleapis.com")).toEqual([]);
  });
});
