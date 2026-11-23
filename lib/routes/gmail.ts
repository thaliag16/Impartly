// The Gmail connect, callback and disconnect route logic. The route files under
// app/api/mail/gmail/ only wire real dependencies into these handlers; tests wire fakes
// (no Google, no Supabase).
//
//   GET  /api/mail/gmail/connect     signed in -> state + PKCE in an encrypted cookie,
//                                    redirect to Google asking for gmail.readonly only
//   GET  /api/mail/gmail/callback    signed in, same user, state matches -> exchange the
//                                    code (exact scope checked), read the mailbox address
//                                    from the Gmail profile, save the tokens to Vault
//                                    through the service-role RPC
//   POST /api/mail/gmail/disconnect  signed in, same-origin, own connection -> revoke the
//                                    grant at Google, then remove the connection (and its
//                                    Vault secret)
//
// Every outcome redirects to /mail?gmail=<code> with a fixed code; nothing from Google or
// the inbox is echoed back. Tokens never leave the server and are never logged.

import { NextResponse, type NextRequest } from "next/server";
import { createGmailAdapter } from "../mail/gmail/adapter";
import {
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  exchangeCode,
  revokeGrant,
  type GoogleOAuthConfig,
} from "../mail/gmail/oauth";
import type { TokenStore } from "../mail/token-store";
import { MailAuthError, type MailProvider } from "../mail/types";
import { isSameOriginPost } from "../auth/access";
import { redirectTo } from "./redirect";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  deriveStateKey,
  openState,
  sameState,
  sealState,
  stateCookieOptions,
} from "../auth/oauth-state";

export interface GmailRouteDeps {
  /** The signed-in user confirmed by Supabase Auth, or null. */
  getUser(request: NextRequest): Promise<{ id: string } | null>;
  /** Google OAuth settings; throws when not configured. */
  oauth(): GoogleOAuthConfig;
  /** The Vault token store on the service-role client. */
  tokenStore(): TokenStore;
  /** The connection if it belongs to this user (read under RLS as the user), else null. */
  ownedConnection(request: NextRequest, userId: string, connectionId: string): Promise<{ id: string; provider: MailProvider } | null>;
  /** fetch for the Gmail profile request (tests pass a fake). */
  fetch?: typeof fetch;
  now?: () => number;
}

export type GmailOutcome =
  | "connected"
  | "denied"
  | "not_granted"
  | "failed"
  | "invalid"
  | "not_configured"
  | "disconnected"
  | "revoke_failed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<R extends NextResponse>(response: R): R {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function toMail(_request: NextRequest, outcome: GmailOutcome): NextResponse {
  return redirectTo(`/mail?gmail=${outcome}`);
}

function unauthorized(): NextResponse {
  return noStore(NextResponse.json({ error: "sign in required" }, { status: 401 }));
}

function clearStateCookie(response: NextResponse): NextResponse {
  response.cookies.set(OAUTH_STATE_COOKIE, "", stateCookieOptions(0));
  return response;
}

export async function handleConnect(request: NextRequest, deps: GmailRouteDeps): Promise<NextResponse> {
  const user = await deps.getUser(request);
  if (!user) return unauthorized();
  let config: GoogleOAuthConfig;
  try {
    config = deps.oauth();
  } catch {
    return toMail(request, "not_configured");
  }
  const now = (deps.now ?? Date.now)();
  const state = createState();
  const { verifier, challenge } = createPkcePair();
  const sealed = sealState(
    { state, verifier, userId: user.id, exp: now + OAUTH_STATE_TTL_SECONDS * 1000 },
    deriveStateKey(config.clientSecret),
  );
  const response = NextResponse.redirect(buildAuthorizationUrl(config, { state, codeChallenge: challenge }), 303);
  response.cookies.set(OAUTH_STATE_COOKIE, sealed, stateCookieOptions(OAUTH_STATE_TTL_SECONDS));
  return noStore(response);
}

export async function handleCallback(request: NextRequest, deps: GmailRouteDeps): Promise<NextResponse> {
  const user = await deps.getUser(request);
  if (!user) return clearStateCookie(unauthorized());
  const done = (outcome: GmailOutcome) => clearStateCookie(toMail(request, outcome));

  let config: GoogleOAuthConfig;
  try {
    config = deps.oauth();
  } catch {
    return done("not_configured");
  }
  const params = request.nextUrl.searchParams;
  const saved = openState(
    request.cookies.get(OAUTH_STATE_COOKIE)?.value,
    deriveStateKey(config.clientSecret),
    (deps.now ?? Date.now)(),
  );
  // The flow must be the one this browser started, for this same user, unexpired.
  if (!saved || saved.userId !== user.id || !sameState(saved.state, params.get("state"))) {
    return done("invalid");
  }
  if (params.get("error")) return done("denied");
  const code = params.get("code");
  if (!code || code.length > 2048) return done("invalid");

  let tokens;
  try {
    tokens = await exchangeCode(config, { code, codeVerifier: saved.verifier });
  } catch (err) {
    return done(err instanceof MailAuthError ? "not_granted" : "failed");
  }

  try {
    const adapter = createGmailAdapter({
      tokens: {
        get: async () => tokens.accessToken,
        refresh: async () => {
          throw new MailAuthError("The new Gmail grant was refused");
        },
      },
      fetch: deps.fetch,
    });
    const accountAddress = await adapter.accountAddress();
    await deps.tokenStore().saveConnection({ userId: user.id, provider: "gmail", accountAddress }, tokens);
  } catch {
    // Do not leave a grant at Google that nothing here holds.
    await revokeGrant(config, tokens.refreshToken).catch(() => undefined);
    return done("failed");
  }
  return done("connected");
}

export async function handleDisconnect(request: NextRequest, deps: GmailRouteDeps): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return noStore(NextResponse.json({ error: "cross-site request refused" }, { status: 403 }));
  }
  const user = await deps.getUser(request);
  if (!user) return unauthorized();

  let connectionId = "";
  try {
    const form = await request.formData();
    connectionId = String(form.get("connection_id") ?? "");
  } catch {
    return toMail(request, "invalid");
  }
  if (!UUID.test(connectionId)) return toMail(request, "invalid");
  const owned = await deps.ownedConnection(request, user.id, connectionId).catch(() => null);
  if (!owned || owned.provider !== "gmail") return toMail(request, "invalid");

  let config: GoogleOAuthConfig;
  try {
    config = deps.oauth();
  } catch {
    return toMail(request, "not_configured");
  }
  const store = deps.tokenStore();
  let refreshToken: string | undefined;
  try {
    refreshToken = (await store.read(owned.id)).refreshToken;
  } catch {
    // No readable tokens: nothing to revoke; still remove the connection.
  }
  if (refreshToken) {
    try {
      // Revoking the refresh token revokes the whole grant. A 400 (already revoked) is fine.
      await revokeGrant(config, refreshToken);
    } catch {
      // Keep the connection so the user can try again; nothing was removed.
      return toMail(request, "revoke_failed");
    }
  }
  try {
    await store.removeConnection(owned.id);
  } catch {
    return toMail(request, "failed");
  }
  return toMail(request, "disconnected");
}
