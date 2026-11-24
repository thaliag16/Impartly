// A fake Supabase Auth (GoTrue) server for tests: password sign-in, refresh, get user and
// sign-out, with invented users only. No network of its own:
//   * unit tests pass `handle` as supabase-js's fetch;
//   * the UI tests run it as a local HTTP server (e2e/fake-auth-server.mjs).
// Access tokens are JWT-shaped but unsigned: the fake looks them up, as the real Auth
// server's /user endpoint does, so the app never trusts a token without asking.

import { randomBytes, randomUUID } from "node:crypto";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Invented test users: { email, password, id? }. */
export function createFakeGoTrue(users, { accessTtlSeconds = 3600 } = {}) {
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), { ...u, id: u.id ?? randomUUID() }]));
  const access = new Map(); // token -> user
  const refresh = new Map(); // token -> user
  const state = { requests: [], signIns: 0, signOuts: 0, userLookups: 0, down: false };

  const userJson = (u) => ({
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    created_at: "2026-11-23T00:00:00Z",
  });

  const session = (u) => {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = [
      b64({ alg: "HS256", typ: "JWT" }),
      b64({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", exp: now + accessTtlSeconds, iat: now }),
      randomBytes(16).toString("base64url"),
    ].join(".");
    const refreshToken = randomBytes(18).toString("base64url");
    access.set(accessToken, u);
    refresh.set(refreshToken, u);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: accessTtlSeconds,
      expires_at: now + accessTtlSeconds,
      refresh_token: refreshToken,
      user: userJson(u),
    };
  };

  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function handle(input, init) {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    state.requests.push({ method: request.method, path: url.pathname, search: url.search });
    if (state.down) return json(503, { message: "unavailable" });
    if (url.pathname === "/auth/v1/health") return json(200, { name: "fake-gotrue" });
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

    if (url.pathname === "/auth/v1/token" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const u = byEmail.get(String(body.email ?? "").toLowerCase());
        if (!u || u.password !== body.password) {
          return json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        }
        state.signIns++;
        return json(200, session(u));
      }
      if (grant === "refresh_token") {
        const u = refresh.get(body.refresh_token);
        if (!u) return json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
        refresh.delete(body.refresh_token);
        return json(200, session(u));
      }
      return json(400, { code: 400, error_code: "unsupported_grant_type", msg: "unsupported" });
    }
    if (url.pathname === "/auth/v1/user" && request.method === "GET") {
      state.userLookups++;
      const u = access.get(bearer);
      if (!u) return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      return json(200, userJson(u));
    }
    // PostgREST stand-in for the UI tests: signed-in reads see no rows (no database here).
    if (url.pathname.startsWith("/rest/v1/") && request.method === "GET") {
      if (!access.get(bearer)) return json(401, { message: "JWT invalid" });
      return json(200, []);
    }
    if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
      state.signOuts++;
      access.delete(bearer);
      return new Response(null, { status: 204 });
    }
    return json(404, { msg: "not found" });
  }

  return { handle, state, users: byEmail, revokeAll: () => access.clear() };
}
