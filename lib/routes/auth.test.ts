// Sign-in, sign-out and the proxy that requires sign-in on every route, against a fake
// Supabase Auth server (tests/auth/fake-gotrue.mjs). No network.

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGoTrue } from "../../tests/auth/fake-gotrue.mjs";
import { decideAccess, isPublicPath, isSameOriginPost, safeNextPath } from "../auth/access";
import { createRequestClient, getRequestUser } from "../supabase/request-client";
import { handleSignIn, handleSignOut } from "./auth";
import { proxy } from "../../proxy";

const ORIGIN = "http://localhost:3000";
const SUPABASE = "http://127.0.0.1:54329";
const ENV = { NEXT_PUBLIC_SUPABASE_URL: SUPABASE, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "invented-publishable-key" };
const USER = { email: "reader@inbox.example", password: "invented-password-for-tests" };

let gotrue: ReturnType<typeof createFakeGoTrue>;
beforeEach(() => {
  gotrue = createFakeGoTrue([USER]);
});

const opts = () => ({ env: ENV, fetch: gotrue.handle as typeof fetch });

const signInRequest = (form: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) =>
  new NextRequest(`${ORIGIN}/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });

/** The cookies a response sets, as a Cookie header for the next request. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

async function signedInCookies(): Promise<string> {
  const response = await handleSignIn(signInRequest({ ...USER, next: "/" }), opts());
  expect(response.status).toBe(303);
  return cookieHeader(response);
}

describe("sign-in", () => {
  it("signs in server-side and sets httpOnly, SameSite=Lax session cookies, then goes to `next`", async () => {
    const response = await handleSignIn(signInRequest({ ...USER, next: "/mail" }), opts());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/mail");
    const set = response.headers.getSetCookie().filter((c) => c.startsWith("sb-"));
    expect(set.length).toBeGreaterThan(0);
    for (const c of set) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=lax/i);
    }
    // Not over https here, so not Secure; over https it is (next test).
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(gotrue.state.signIns).toBe(1);
    // The password is never echoed.
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(USER.password);
  });

  it("marks the session cookies Secure over https", async () => {
    const request = new NextRequest("https://impartly.example/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://impartly.example" },
      body: new URLSearchParams({ ...USER }).toString(),
    });
    const response = await handleSignIn(request, opts());
    for (const c of response.headers.getSetCookie().filter((c) => c.startsWith("sb-"))) expect(c).toMatch(/Secure/);
  });

  it("a wrong password goes back to /login with a fixed error and no cookies", async () => {
    const response = await handleSignIn(signInRequest({ email: USER.email, password: "wrong", next: "/mail" }), opts());
    const location = new URL(response.headers.get("location")!, ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("invalid");
    expect(location.searchParams.get("next")).toBe("/mail");
    expect(location.search).not.toContain("wrong");
    expect(location.search).not.toContain(encodeURIComponent(USER.email));
    expect(response.headers.getSetCookie().filter((c) => c.startsWith("sb-"))).toEqual([]);
  });

  it("never redirects off-site after sign-in", async () => {
    for (const next of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "/ok\n"]) {
      const response = await handleSignIn(signInRequest({ ...USER, next }), opts());
      expect(new URL(response.headers.get("location")!, ORIGIN).origin).toBe(ORIGIN);
    }
  });

  it("refuses cross-site sign-in posts (login CSRF)", async () => {
    const response = await handleSignIn(signInRequest(USER, { origin: "https://evil.example" }), opts());
    expect(response.status).toBe(403);
    expect(gotrue.state.signIns).toBe(0);
  });

  it("fails closed when Supabase is not configured", async () => {
    const response = await handleSignIn(signInRequest(USER), { env: {}, fetch: gotrue.handle as typeof fetch });
    expect(new URL(response.headers.get("location")!, ORIGIN).searchParams.get("error")).toBe("not_configured");
    expect(gotrue.state.requests).toEqual([]);
  });
});

describe("the signed-in user is confirmed with Supabase Auth, not read from the cookie", () => {
  it("a valid session gives the user; a revoked one, a forged cookie or no cookie gives null", async () => {
    const cookies = await signedInCookies();
    const req = (cookie?: string) => new NextRequest(`${ORIGIN}/mail`, { headers: cookie ? { cookie } : {} });
    const user = await getRequestUser(createRequestClient(req(cookies), opts()));
    expect(user?.email).toBe(USER.email);
    expect(gotrue.state.userLookups).toBe(1);

    expect(await getRequestUser(createRequestClient(req(), opts()))).toBeNull();
    expect(await getRequestUser(createRequestClient(req("sb-127-auth-token=base64-eyJmYWtlIjp0cnVlfQ"), opts()))).toBeNull();
    gotrue.revokeAll();
    expect(await getRequestUser(createRequestClient(req(cookies), opts()))).toBeNull();
  });
});

describe("sign-out", () => {
  it("POST only, same-origin only; ends the session and expires the session cookies", async () => {
    const cookies = await signedInCookies();
    const crossSite = new NextRequest(`${ORIGIN}/auth/sign-out`, { method: "POST", headers: { cookie: cookies, origin: "https://evil.example" } });
    expect((await handleSignOut(crossSite, opts())).status).toBe(403);
    expect(gotrue.state.signOuts).toBe(0);

    const request = new NextRequest(`${ORIGIN}/auth/sign-out`, { method: "POST", headers: { cookie: cookies, origin: ORIGIN } });
    const response = await handleSignOut(request, opts());
    expect(response.headers.get("location")).toBe("/login");
    expect(gotrue.state.signOuts).toBe(1);
    const expired = response.headers.getSetCookie().filter((c) => c.startsWith("sb-"));
    expect(expired.length).toBeGreaterThan(0);
    for (const c of expired) expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });
});

describe("access rules", () => {
  it("only the sign-in page, the sign-in endpoint and Next build assets are public", () => {
    for (const p of ["/login", "/auth/sign-in", "/_next/static/chunks/app.js"]) expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/", "/mail", "/spike", "/spike/voice", "/api/speech-test", "/api/mail/gmail/connect", "/api/mail/gmail/callback", "/auth/sign-out", "/login/x", "/_next/data/x.json"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("signed out: pages redirect to /login with a safe next, APIs get 401", () => {
    expect(decideAccess("/mail", "?gmail=connected", false)).toEqual({ kind: "redirect", location: "/login?next=%2Fmail%3Fgmail%3Dconnected" });
    expect(decideAccess("/", "", false)).toEqual({ kind: "redirect", location: "/login" });
    expect(decideAccess("/api/mail/gmail/connect", "", false)).toEqual({ kind: "unauthorized" });
    expect(decideAccess("/mail", "", true)).toEqual({ kind: "allow" });
  });

  it("safeNextPath keeps same-site paths only", () => {
    expect(safeNextPath("/mail?x=1")).toBe("/mail?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "mail", "", null, "/a\tb", "/a\\b"]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });

  it("isSameOriginPost compares Origin's host with this site's host", () => {
    const r = (method: string, o: Record<string, string>, url = `${ORIGIN}/x`) => ({ method, headers: new Headers(o), url });
    expect(isSameOriginPost(r("POST", { origin: ORIGIN }))).toBe(true);
    expect(isSameOriginPost(r("POST", { origin: "https://impartly.example", host: "impartly.example" }))).toBe(true);
    expect(isSameOriginPost(r("POST", { origin: "https://impartly.example", "x-forwarded-host": "impartly.example", host: "internal:3000" }))).toBe(true);
    expect(isSameOriginPost(r("POST", { "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginPost(r("POST", { origin: "http://localhost:3001" }))).toBe(false);
    expect(isSameOriginPost(r("POST", { origin: "https://evil.example", host: "impartly.example" }))).toBe(false);
    expect(isSameOriginPost(r("POST", { origin: "null" }))).toBe(false);
    expect(isSameOriginPost(r("POST", { "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOriginPost(r("POST", {}))).toBe(false);
    expect(isSameOriginPost(r("GET", { origin: ORIGIN }))).toBe(false);
  });
});

describe("proxy: sign-in required on every route", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ENV.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    vi.stubGlobal("fetch", gotrue.handle);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const PATHS = ["/", "/mail", "/spike", "/spike/voice", "/api/speech-test", "/api/mail/gmail/connect", "/api/mail/gmail/callback?code=x&state=y", "/auth/sign-out"];

  it("signed out: every page redirects to /login, every API answers 401", async () => {
    for (const path of PATHS) {
      const response = await proxy(new NextRequest(`${ORIGIN}${path}`));
      if (path.startsWith("/api/") || path.startsWith("/auth/")) {
        expect(response.status, path).toBe(401);
      } else {
        expect(response.status, path).toBe(303);
        expect(new URL(response.headers.get("location")!, ORIGIN).pathname, path).toBe("/login");
      }
      expect(response.headers.get("x-middleware-next"), path).toBeNull();
    }
  });

  it("signed in: every route passes through", async () => {
    const response0 = await handleSignIn(signInRequest(USER), opts());
    const cookie = cookieHeader(response0);
    for (const path of PATHS) {
      const response = await proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { cookie } }));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("the sign-in page is reachable signed out, and an unconfigured server fails closed", async () => {
    expect((await proxy(new NextRequest(`${ORIGIN}/login`))).headers.get("x-middleware-next")).toBe("1");
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const response = await proxy(new NextRequest(`${ORIGIN}/mail`));
    expect(response.status).toBe(303);
  });
});
