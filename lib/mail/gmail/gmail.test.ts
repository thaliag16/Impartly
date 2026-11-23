import { describe, expect, it, vi } from "vitest";
import { createFakeGoogle, gmailFixture, messageFixtureIds } from "../../../tests/mail/fake-gmail";
import { createMemoryTokenStore, type OAuthTokens } from "../token-store";
import { createStoredTokenSource } from "../token-session";
import { MailAuthError } from "../types";
import { gmailAdapterForConnection } from "../index";
import {
  assertReadOnlyRequest,
  createGmailAdapter,
  decodeBodyData,
  decodeHeaderWords,
  parseFrom,
  parseGmailMessage,
  type GmailMessage,
} from "./adapter";
import {
  buildAuthorizationUrl,
  checkGrantedScope,
  checkRedirectUri,
  createPkcePair,
  exchangeCode,
  GMAIL_READONLY_SCOPE,
  GMAIL_SCOPES,
  googleOAuthFromEnv,
  refreshAccessToken,
} from "./oauth";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const SINCE = new Date(NOW - 24 * 3600 * 1000);
const msg = (id: string) => gmailFixture<GmailMessage>(`messages/${id}.json`);

const oauth = (fetchImpl: typeof fetch) => ({
  clientId: "invented-client-id.apps.example",
  clientSecret: "invented-client-secret-value",
  redirectUri: "https://impartly.example/api/mail/gmail/callback",
  fetch: fetchImpl,
  now: () => NOW,
});

async function setup(tokens: Partial<OAuthTokens> = {}) {
  const google = createFakeGoogle({ accessToken: "invented-access-token-1" });
  const store = createMemoryTokenStore();
  const connectionId = await store.saveConnection(
    { userId: "00000000-0000-4000-8000-000000000001", provider: "gmail", accountAddress: "reader@inbox.example" },
    {
      accessToken: "invented-access-token-1",
      refreshToken: "invented-refresh-token-1",
      expiresAt: NOW + 3600_000,
      scope: GMAIL_READONLY_SCOPE,
      ...tokens,
    },
  );
  const adapter = gmailAdapterForConnection({ connectionId, store, oauth: oauth(google.fetch), fetch: google.fetch });
  return { google, store, connectionId, adapter };
}

describe("Gmail message parsing (fixtures in Gmail's format=full shape)", () => {
  it("multipart/alternative: headers, sender, date, both bodies, bulk label", () => {
    const m = parseGmailMessage(msg("19a0c0ffee000001"));
    expect(m.id).toBe("19a0c0ffee000001");
    expect(m.from).toEqual({ address: "news@brightline-weekly.example", name: "Brightline Weekly" });
    expect(m.subject).toBe("Larkspur raises $40M; Ridgeway caps fares");
    expect(m.receivedAt).toBe("2026-11-23T06:00:00.000Z");
    expect(m.headers["list-unsubscribe"]).toContain("brightline-weekly.example/unsubscribe");
    expect(m.headers["list-id"]).toContain("weekly.brightline-weekly.example");
    expect(m.bulkCategory).toBe(true);
    expect(m.html).toContain("<h1>Brightline Weekly, issue 482</h1>");
    expect(m.text).toContain("Larkspur Robotics raised $40 million");
  });

  it("does not quoted-printable-decode again: Gmail already did (a=b stays a=b)", () => {
    const m = parseGmailMessage(msg("19a0c0ffee000001"));
    expect(m.html).toContain("a=b stays");
  });

  it("nested multipart/mixed > related > alternative: finds the bodies, ignores every attachment", () => {
    const raw = msg("19a0c0ffee000003");
    const m = parseGmailMessage(raw);
    expect(m.html).toContain("Granite prices rose 4% in October");
    expect(m.html).not.toContain("archive"); // the text/html attachment is not the body
    expect(m.text).toBe("Quarry Ledger Digest\nGranite prices rose 4% in October.");
    // Sender address lower-cased.
    expect(m.from.address).toBe("digest@quarry-ledger.example");
    // The fixture really has three attachments with attachmentIds and no data.
    const attachments: string[] = [];
    const walk = (p: NonNullable<GmailMessage["payload"]>) => {
      if (p.body?.attachmentId) attachments.push(p.filename ?? "");
      p.parts?.forEach(walk);
    };
    walk(raw.payload!);
    expect(attachments.sort()).toEqual(["archive.html", "logo.png", "october-report.pdf"]);
  });

  it("single-part HTML message and an RFC 2047 encoded subject", () => {
    const m = parseGmailMessage(msg("19a0c0ffee000005"));
    expect(m.html).toContain("Tidewater Almanac");
    expect(m.text).toBeUndefined();
    expect(m.subject).toBe("Tidewater Almanac — week 48");
    expect(m.from).toEqual({ address: "almanac@tidewater.example" });
  });

  it("ISO-8859-1 text/plain body and Q-encoded From and Subject", () => {
    const m = parseGmailMessage(msg("19a0c0ffee000008"));
    expect(m.text).toContain("Café Lettre, notes no. 4");
    expect(m.text).toContain("Crème brûlée");
    expect(m.html).toBeUndefined();
    expect(m.from).toEqual({ address: "lettre@cafe-lettre.example", name: "Café Lettre" });
    expect(m.subject).toBe("Café notes no. 4");
    expect(m.headers.precedence).toBe("bulk");
  });

  it("decodes base64url with and without padding, and header edge cases", () => {
    const text = "Hé, 50% off?>>";
    const unpadded = Buffer.from(text).toString("base64url");
    expect(unpadded).not.toMatch(/=/);
    expect(decodeBodyData(unpadded)).toBe(text);
    expect(decodeBodyData(unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4))).toBe(text);
    expect(decodeHeaderWords("=?UTF-8?Q?a_b?= =?UTF-8?Q?_c?=")).toBe("a b c");
    expect(decodeHeaderWords("Plain subject")).toBe("Plain subject");
    expect(parseFrom("<only@addr.example>")).toEqual({ address: "only@addr.example" });
    expect(parseFrom('"Quoted, Name" <Q@X.example>')).toEqual({ address: "q@x.example", name: "Quoted, Name" });
  });
});

describe("Gmail adapter against the fake Gmail API", () => {
  it("reads the profile address", async () => {
    const { adapter } = await setup();
    expect(await adapter.accountAddress()).toBe("reader@inbox.example");
  });

  it("lists every page, fetches each message in full, keeps the since window, newest first", async () => {
    const { adapter, google } = await setup();
    const messages = await adapter.listMessagesSince(SINCE);
    // 8 fixtures across two pages; the one from 2026-11-21 is outside the window.
    expect(messages.map((m) => m.id)).toEqual([
      "19a0c0ffee000008",
      "19a0c0ffee000004",
      "19a0c0ffee000003",
      "19a0c0ffee000006",
      "19a0c0ffee000002",
      "19a0c0ffee000001",
      "19a0c0ffee000005",
    ]);
    const lists = google.requests.filter((r) => r.url.includes("/messages?"));
    expect(lists).toHaveLength(2);
    const q = new URL(lists[0].url).searchParams.get("q");
    expect(q).toBe(`after:${Math.floor(SINCE.getTime() / 1000)} -in:chats -in:sent -in:drafts`);
    expect(new URL(lists[1].url).searchParams.get("pageToken")).toBe("invented-page-token-2");
    const gets = google.requests.filter((r) => /\/messages\/\w+\?/.test(r.url));
    expect(gets).toHaveLength(8);
    for (const r of gets) expect(new URL(r.url).searchParams.get("format")).toBe("full");
  });

  it("every request is a GET to an allowed read-only Gmail endpoint, with a bearer token", async () => {
    const { adapter, google } = await setup();
    await adapter.accountAddress();
    await adapter.listMessagesSince(SINCE);
    expect(google.requests.length).toBeGreaterThan(0);
    for (const r of google.requests) {
      expect(r.method).toBe("GET");
      expect(() => assertReadOnlyRequest(r.method, r.url)).not.toThrow();
      expect(r.headers.authorization).toBe("Bearer invented-access-token-1");
    }
  });

  it("respects the limit", async () => {
    const { adapter, google } = await setup();
    const messages = await adapter.listMessagesSince(SINCE, { limit: 3 });
    expect(messages.length).toBeLessThanOrEqual(3);
    expect(google.requests.filter((r) => /\/messages\/\w+\?/.test(r.url))).toHaveLength(3);
    expect(new URL(google.requests[0].url).searchParams.get("maxResults")).toBe("3");
  });

  it("an empty mailbox gives an empty list", async () => {
    const { adapter, google } = await setup();
    google.emptyList = true;
    expect(await adapter.listMessagesSince(SINCE)).toEqual([]);
  });

  it("a 401 refreshes the access token once, saves it, and retries", async () => {
    const { adapter, google, store, connectionId } = await setup();
    google.validAccessToken = "invented-access-token-rotated-by-google"; // ours is now stale
    google.nextAccessToken = "invented-access-token-2";
    expect(await adapter.accountAddress()).toBe("reader@inbox.example");
    expect(google.refreshCount).toBe(1);
    const saved = await store.read(connectionId);
    expect(saved.accessToken).toBe("invented-access-token-2");
    expect(saved.refreshToken).toBe("invented-refresh-token-1"); // kept when Google does not rotate it
    expect(saved.expiresAt).toBe(NOW + 3599_000);
    // Later calls use the new token without refreshing again.
    await adapter.listMessagesSince(SINCE);
    expect(google.refreshCount).toBe(1);
  });

  it("a second 401 after the refresh stops with MailAuthError (no loop)", async () => {
    const { adapter, google } = await setup();
    google.alwaysUnauthorized = true;
    await expect(adapter.accountAddress()).rejects.toBeInstanceOf(MailAuthError);
    expect(google.refreshCount).toBe(1);
    expect(google.requests.filter((r) => r.url.startsWith("https://gmail.googleapis.com"))).toHaveLength(2);
  });

  it("a revoked refresh token (invalid_grant) is a MailAuthError", async () => {
    const { adapter, google } = await setup();
    google.validAccessToken = "something-else";
    google.refreshRevoked = true;
    await expect(adapter.accountAddress()).rejects.toThrow(MailAuthError);
    await expect(adapter.accountAddress()).rejects.toThrow(/invalid_grant/);
  });

  it("an access token about to expire is refreshed before the request", async () => {
    const { adapter, google } = await setup({ expiresAt: NOW + 30_000 });
    google.validAccessToken = "unused";
    expect(await adapter.accountAddress()).toBe("reader@inbox.example");
    expect(google.refreshCount).toBe(1);
    // Only one Gmail request: no 401 round trip.
    expect(google.requests.filter((r) => r.url.startsWith("https://gmail.googleapis.com"))).toHaveLength(1);
  });

  it("concurrent requests share one refresh", async () => {
    const store = createMemoryTokenStore();
    const id = await store.saveConnection(
      { userId: "u", provider: "gmail", accountAddress: "reader@inbox.example" },
      { accessToken: "a", refreshToken: "r", expiresAt: 0, scope: GMAIL_READONLY_SCOPE },
    );
    const refresh = vi.fn(async () => ({ accessToken: "fresh", expiresAt: NOW + 3600_000 }));
    const source = createStoredTokenSource({ connectionId: id, store, refresh, now: () => NOW });
    expect(await Promise.all([source.get(), source.get(), source.get()])).toEqual(["fresh", "fresh", "fresh"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("other HTTP errors report the status only", async () => {
    const tokens = { get: async () => "t", refresh: async () => "t" };
    const adapter = createGmailAdapter({
      tokens,
      fetch: (async () => new Response("echo: Bearer t and more", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(adapter.accountAddress()).rejects.toThrow(/^Gmail request failed with HTTP 503$/);
  });

  it("refuses a message id that could change the request path", async () => {
    const tokens = { get: async () => "t", refresh: async () => "t" };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "../../settings/filters" }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createGmailAdapter({ tokens, fetch: fetchImpl });
    await expect(adapter.listMessagesSince(SINCE)).rejects.toThrow(/unexpected message id/);
  });

  it("exposes only read methods", async () => {
    const { adapter } = await setup();
    expect(Object.keys(adapter).sort()).toEqual(["accountAddress", "listMessagesSince", "provider"]);
  });

  it("all eight message fixtures parse", () => {
    const ids = messageFixtureIds();
    expect(ids).toHaveLength(8);
    for (const id of ids) expect(() => parseGmailMessage(msg(id))).not.toThrow();
  });
});

describe("Google OAuth (gmail.readonly only)", () => {
  const config = oauth((async () => new Response("{}")) as unknown as typeof fetch);

  it("the sign-in URL requests exactly gmail.readonly, offline, with PKCE and state", () => {
    const { challenge } = createPkcePair();
    const url = new URL(buildAuthorizationUrl(config, { state: "invented-state", codeChallenge: challenge }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.getAll("scope")).toHaveLength(1);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("state")).toBe("invented-state");
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("the scope list is frozen and holds one read-only scope", () => {
    expect(GMAIL_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(Object.isFrozen(GMAIL_SCOPES)).toBe(true);
    expect(() => (GMAIL_SCOPES as string[]).push("https://mail.google.com/")).toThrow();
    // buildAuthorizationUrl takes no scope argument: an extra one is ignored by design.
    const url = new URL(
      buildAuthorizationUrl(config, { state: "s", codeChallenge: "c", scope: "https://mail.google.com/" } as never),
    );
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
  });

  it("PKCE challenge is the S256 of the verifier", async () => {
    const { verifier, challenge } = createPkcePair();
    const { createHash } = await import("node:crypto");
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("refuses a grant without gmail.readonly, or with any other scope", () => {
    expect(() => checkGrantedScope(GMAIL_READONLY_SCOPE)).not.toThrow();
    expect(() => checkGrantedScope("openid email")).toThrow(MailAuthError);
    expect(() => checkGrantedScope(`${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify`)).toThrow(
      /unexpected scopes/,
    );
    expect(() => checkGrantedScope(undefined)).toThrow(MailAuthError);
  });

  it("exchanges a code with the verifier and redirect URI, and checks the scope", async () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
      return new Response(
        JSON.stringify({ access_token: "invented-a", refresh_token: "invented-r", expires_in: 3599, scope: GMAIL_READONLY_SCOPE }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const tokens = await exchangeCode(oauth(fetchImpl), { code: "invented-code", codeVerifier: "invented-verifier" });
    expect(tokens).toEqual({ accessToken: "invented-a", refreshToken: "invented-r", expiresAt: NOW + 3599_000, scope: GMAIL_READONLY_SCOPE });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0].body.get("grant_type")).toBe("authorization_code");
    expect(calls[0].body.get("code_verifier")).toBe("invented-verifier");
    expect(calls[0].body.get("redirect_uri")).toBe("https://impartly.example/api/mail/gmail/callback");
  });

  it("exchange refuses a broader grant and a missing refresh token", async () => {
    const respond = (body: object) =>
      (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    await expect(
      exchangeCode(oauth(respond({ access_token: "a", refresh_token: "r", scope: "https://mail.google.com/" })), { code: "c", codeVerifier: "v" }),
    ).rejects.toThrow(MailAuthError);
    await expect(
      exchangeCode(oauth(respond({ access_token: "a", scope: GMAIL_READONLY_SCOPE })), { code: "c", codeVerifier: "v" }),
    ).rejects.toThrow(/no refresh token/);
  });

  it("token errors never include the client secret, tokens or the response body", async () => {
    const secretish = "invented-refresh-token-SHOULD-NOT-LEAK";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_client", error_description: `bad ${secretish}` }), { status: 401 })) as unknown as typeof fetch;
    const err = await refreshAccessToken(oauth(fetchImpl), secretish).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Google token request failed with HTTP 401 (invalid_client)");
    expect((err as Error).message).not.toContain("invented-client-secret-value");
  });

  it("redirect URI must be https (http only for localhost)", () => {
    expect(() => checkRedirectUri("http://impartly.example/cb")).toThrow(/https/);
    expect(() => checkRedirectUri("http://localhost:3000/api/mail/gmail/callback")).not.toThrow();
    expect(() => checkRedirectUri("https://impartly.example/cb#x")).toThrow(/fragment/);
  });

  it("googleOAuthFromEnv names the missing settings", () => {
    expect(() => googleOAuthFromEnv({})).toThrow(
      "Gmail sign-in not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI",
    );
    const c = googleOAuthFromEnv({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "s",
      GOOGLE_REDIRECT_URI: "https://impartly.example/api/mail/gmail/callback",
    });
    expect(c.clientId).toBe("id");
  });
});

describe("no token is ever logged or put in an error", () => {
  it("a full pull with a refresh and an auth failure writes nothing to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const { adapter, google } = await setup();
      google.validAccessToken = "rotated";
      await adapter.listMessagesSince(SINCE);
      google.alwaysUnauthorized = true;
      const err = await adapter.accountAddress().catch((e: Error) => e);
      expect(String((err as Error).message)).not.toMatch(/invented-(access|refresh)-token/);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
