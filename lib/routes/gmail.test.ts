// Gmail connect, callback and disconnect routes against a fake Google (token, revoke and
// Gmail profile endpoints), a fake signed-in user and the in-memory token store.
// Nothing here reaches Google or Supabase.

import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeGoogle, type FakeGoogle } from "../../tests/mail/fake-gmail";
import { createMemoryTokenStore, type TokenStore } from "../mail/token-store";
import { GMAIL_READONLY_SCOPE } from "../mail/gmail/oauth";
import { OAUTH_STATE_COOKIE, deriveStateKey, openState } from "../auth/oauth-state";
import { handleCallback, handleConnect, handleDisconnect, type GmailRouteDeps } from "./gmail";

const ORIGIN = "http://localhost:3000";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const CLIENT_SECRET = "invented-client-secret-for-tests";
const T0 = Date.parse("2026-11-23T12:00:00.000Z");

interface World {
  google: FakeGoogle;
  store: TokenStore & { size(): number };
  owners: Map<string, { userId: string; provider: "gmail" | "outlook" }>;
  user: { id: string } | null;
  now: number;
  configured: boolean;
  calls: string[];
  deps: GmailRouteDeps;
}

let w: World;

function makeWorld(): World {
  const google = createFakeGoogle({ accessToken: "invented-access-token-1" });
  const base = createMemoryTokenStore();
  const owners = new Map<string, { userId: string; provider: "gmail" | "outlook" }>();
  const calls: string[] = [];
  const store: TokenStore & { size(): number } = {
    size: base.size,
    async saveConnection(ref, tokens) {
      const id = await base.saveConnection(ref, tokens);
      owners.set(id, { userId: ref.userId, provider: ref.provider });
      calls.push("save");
      return id;
    },
    read: (id) => base.read(id),
    update: (id, t) => base.update(id, t),
    async removeConnection(id) {
      calls.push("remove");
      owners.delete(id);
      await base.removeConnection(id);
    },
  };
  const world: World = {
    google,
    store,
    owners,
    user: { id: A },
    now: T0,
    configured: true,
    calls,
    deps: undefined as unknown as GmailRouteDeps,
  };
  // Record revoke calls in order with the store calls.
  const googleFetch = google.fetch;
  const fetchWithOrder = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/revoke")) calls.push("revoke");
    return googleFetch(input, init);
  }) as typeof fetch;
  world.deps = {
    getUser: async () => world.user,
    oauth: () => {
      if (!world.configured) throw new Error("Gmail sign-in not configured");
      return {
        clientId: "invented-client-id.apps.example",
        clientSecret: CLIENT_SECRET,
        redirectUri: `${ORIGIN}/api/mail/gmail/callback`,
        fetch: fetchWithOrder,
        now: () => world.now,
      };
    },
    tokenStore: () => store,
    ownedConnection: async (_req, userId, id) => {
      const o = owners.get(id);
      return o && o.userId === userId ? { id, provider: o.provider } : null;
    },
    fetch: fetchWithOrder,
    now: () => world.now,
  };
  return world;
}

beforeEach(() => {
  w = makeWorld();
});

const get = (path: string, cookie?: string) =>
  new NextRequest(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });

const post = (path: string, form: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });

function stateCookie(response: Response): { value: string; raw: string } | null {
  const raw = response.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
  if (!raw) return null;
  return { raw, value: decodeURIComponent(raw.split(";")[0].slice(OAUTH_STATE_COOKIE.length + 1)) };
}

/** Runs /connect as the current user; returns the state and the cookie to send back. */
async function startConnect() {
  const response = await handleConnect(get("/api/mail/gmail/connect"), w.deps);
  const location = new URL(response.headers.get("location")!, ORIGIN);
  const cookie = stateCookie(response)!;
  return { response, location, state: location.searchParams.get("state")!, cookie: `${OAUTH_STATE_COOKIE}=${cookie.value}` };
}

const outcome = (response: Response) => new URL(response.headers.get("location") ?? "/", ORIGIN).searchParams.get("gmail");
const tokenRequests = () => w.google.requests.filter((r) => r.url === "https://oauth2.googleapis.com/token");

describe("GET /api/mail/gmail/connect", () => {
  it("refuses a signed-out request with 401 and starts nothing", async () => {
    w.user = null;
    const response = await handleConnect(get("/api/mail/gmail/connect"), w.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(stateCookie(response)).toBeNull();
  });

  it("says not_configured when the Google OAuth settings are missing", async () => {
    w.configured = false;
    const response = await handleConnect(get("/api/mail/gmail/connect"), w.deps);
    expect(response.status).toBe(303);
    expect(outcome(response)).toBe("not_configured");
  });

  it("redirects to Google asking for gmail.readonly only, with state and an S256 PKCE challenge", async () => {
    const { response, location, state } = await startConnect();
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/mail/gmail/callback`);
    expect(location.searchParams.has("include_granted_scopes")).toBe(false);
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  it("keeps state and verifier server-side: an encrypted, httpOnly, Secure, SameSite=Lax, 10-minute __Host- cookie bound to the user", async () => {
    const { location, state } = await startConnect();
    const response = await handleConnect(get("/api/mail/gmail/connect"), w.deps);
    const c = stateCookie(response)!;
    expect(c.raw).toMatch(/HttpOnly/i);
    expect(c.raw).toMatch(/Secure/i);
    expect(c.raw).toMatch(/SameSite=lax/i);
    expect(c.raw).toMatch(/Path=\//);
    expect(c.raw).toMatch(/Max-Age=600/);
    expect(c.raw).not.toMatch(/Domain=/i);

    const first = await startConnect();
    const sealed = decodeURIComponent(first.cookie.split("=").slice(1).join("="));
    // Not readable without the server key...
    expect(sealed).not.toContain(first.state);
    expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain(first.state);
    // ...and with it, it holds this flow's state, the verifier matching the challenge, and the user.
    const payload = openState(sealed, deriveStateKey(CLIENT_SECRET), T0)!;
    expect(payload.state).toBe(first.state);
    expect(payload.userId).toBe(A);
    expect(payload.exp).toBe(T0 + 600_000);
    expect(createHash("sha256").update(payload.verifier).digest("base64url")).toBe(
      first.location.searchParams.get("code_challenge"),
    );
    // Each flow gets its own state.
    expect(first.state).not.toBe(state);
    expect(location.searchParams.get("code_challenge")).not.toBe(first.location.searchParams.get("code_challenge"));
  });
});

describe("GET /api/mail/gmail/callback", () => {
  it("exchanges the code with the PKCE verifier, reads the profile address and saves the connection", async () => {
    const { state, cookie } = await startConnect();
    const sealed = decodeURIComponent(cookie.split("=").slice(1).join("="));
    const verifier = openState(sealed, deriveStateKey(CLIENT_SECRET), T0)!.verifier;

    const response = await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps);
    expect(response.status).toBe(303);
    expect(outcome(response)).toBe("connected");
    expect(new URL(response.headers.get("location")!, ORIGIN).pathname).toBe("/mail");
    // Single use: the cookie is cleared.
    expect(stateCookie(response)!.raw).toMatch(/Max-Age=0/);

    expect(w.google.codeVerifiers).toEqual([verifier]);
    const profile = w.google.requests.filter((r) => r.url.endsWith("/profile"));
    expect(profile).toHaveLength(1);
    expect(profile[0].method).toBe("GET");

    expect(w.store.size()).toBe(1);
    const [id, owner] = [...w.owners][0];
    expect(owner).toEqual({ userId: A, provider: "gmail" });
    const tokens = await w.store.read(id);
    expect(tokens.refreshToken).toBe("invented-refresh-token-from-code");
    expect(tokens.scope).toBe(GMAIL_READONLY_SCOPE);
    // Nothing secret goes back to the browser.
    const everything = JSON.stringify([...response.headers.entries()]);
    expect(everything).not.toMatch(/invented-(?:access|refresh|auth)/);
  });

  it("refuses a state that does not match the cookie, before any token request", async () => {
    const { cookie } = await startConnect();
    const response = await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=forged-state-value`, cookie), w.deps);
    expect(outcome(response)).toBe("invalid");
    expect(tokenRequests()).toHaveLength(0);
    expect(w.store.size()).toBe(0);
  });

  it("refuses a callback with no state cookie (a flow this browser did not start)", async () => {
    const { state } = await startConnect();
    const response = await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`), w.deps);
    expect(outcome(response)).toBe("invalid");
    expect(tokenRequests()).toHaveLength(0);
  });

  it("refuses the flow for a different signed-in user than the one who started it", async () => {
    const { state, cookie } = await startConnect();
    w.user = { id: B };
    const response = await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps);
    expect(outcome(response)).toBe("invalid");
    expect(tokenRequests()).toHaveLength(0);
    expect(w.store.size()).toBe(0);
  });

  it("refuses an expired flow (over 10 minutes) and an altered cookie", async () => {
    const { state, cookie } = await startConnect();
    w.now = T0 + 601_000;
    expect(outcome(await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps))).toBe("invalid");
    w.now = T0;
    const value = cookie.split("=").slice(1).join("=");
    const flipped = value.slice(0, -2) + (value.at(-2) === "A" ? "B" : "A") + value.at(-1);
    expect(outcome(await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, `${OAUTH_STATE_COOKIE}=${flipped}`), w.deps))).toBe("invalid");
    expect(tokenRequests()).toHaveLength(0);
  });

  it("reports denied when the user declined at Google", async () => {
    const { state, cookie } = await startConnect();
    const response = await handleCallback(get(`/api/mail/gmail/callback?error=access_denied&state=${state}`, cookie), w.deps);
    expect(outcome(response)).toBe("denied");
    expect(tokenRequests()).toHaveLength(0);
  });

  it("refuses a grant with any scope beyond gmail.readonly, and one without a refresh token", async () => {
    let { state, cookie } = await startConnect();
    w.google.grantedScope = `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify`;
    expect(outcome(await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps))).toBe("not_granted");
    expect(w.store.size()).toBe(0);

    ({ state, cookie } = await startConnect());
    w.google.grantedScope = GMAIL_READONLY_SCOPE;
    w.google.issueRefreshToken = false;
    expect(outcome(await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps))).toBe("not_granted");
    expect(w.store.size()).toBe(0);
  });

  it("if the profile or the save fails, nothing is stored and the new grant is revoked", async () => {
    const { state, cookie } = await startConnect();
    w.google.profileStatus = 500;
    const response = await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps);
    expect(outcome(response)).toBe("failed");
    expect(w.store.size()).toBe(0);
    expect(w.google.revoked).toEqual(["invented-refresh-token-from-code"]);
  });

  it("refuses a signed-out callback with 401 and clears the state cookie", async () => {
    const { state, cookie } = await startConnect();
    w.user = null;
    const response = await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps);
    expect(response.status).toBe(401);
    expect(stateCookie(response)!.raw).toMatch(/Max-Age=0/);
    expect(tokenRequests()).toHaveLength(0);
  });
});

describe("POST /api/mail/gmail/disconnect", () => {
  async function connected(userId = A) {
    const prev = w.user;
    w.user = { id: userId };
    const { state, cookie } = await startConnect();
    await handleCallback(get(`/api/mail/gmail/callback?code=invented-auth-code&state=${state}`, cookie), w.deps);
    w.user = prev;
    w.calls.length = 0;
    return [...w.owners].find(([, o]) => o.userId === userId)![0];
  }

  it("revokes the grant at Google, then removes the connection", async () => {
    const id = await connected();
    const response = await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: id }), w.deps);
    expect(response.status).toBe(303);
    expect(outcome(response)).toBe("disconnected");
    expect(w.google.revoked).toEqual(["invented-refresh-token-from-code"]);
    expect(w.calls).toEqual(["revoke", "remove"]);
    expect(w.store.size()).toBe(0);
  });

  it("an already revoked grant (Google answers 400) still disconnects", async () => {
    const id = await connected();
    w.google.revokeStatus = 400;
    expect(outcome(await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: id }), w.deps))).toBe("disconnected");
    expect(w.store.size()).toBe(0);
  });

  it("if Google cannot be reached to revoke, nothing is removed", async () => {
    const id = await connected();
    w.google.revokeStatus = 503;
    expect(outcome(await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: id }), w.deps))).toBe("revoke_failed");
    expect(w.calls).toEqual(["revoke"]);
    expect(w.store.size()).toBe(1);
  });

  it("refuses cross-site requests (wrong Origin, or no Origin and not same-origin) and non-POST", async () => {
    const id = await connected();
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      {},
    ] as Record<string, string>[]) {
      const response = await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: id }, headers), w.deps);
      expect(response.status).toBe(403);
    }
    const viaGet = await handleDisconnect(get(`/api/mail/gmail/disconnect?connection_id=${id}`), w.deps);
    expect(viaGet.status).toBe(403);
    expect(w.calls).toEqual([]);
    expect(w.store.size()).toBe(1);
    // Same-origin without an Origin header (Sec-Fetch-Site: same-origin) is accepted.
    const ok = await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: id }, { "sec-fetch-site": "same-origin" }), w.deps);
    expect(outcome(ok)).toBe("disconnected");
  });

  it("refuses a signed-out request with 401", async () => {
    const id = await connected();
    w.user = null;
    expect((await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: id }), w.deps)).status).toBe(401);
    expect(w.store.size()).toBe(1);
  });

  it("cannot disconnect another user's mailbox, or a malformed id", async () => {
    const bConnection = await connected(B);
    w.user = { id: A };
    expect(outcome(await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: bConnection }), w.deps))).toBe("invalid");
    expect(outcome(await handleDisconnect(post("/api/mail/gmail/disconnect", { connection_id: "not-a-uuid" }), w.deps))).toBe("invalid");
    expect(w.calls).toEqual([]);
    expect(w.google.revoked).toEqual([]);
    expect(w.store.size()).toBe(1);
  });
});
