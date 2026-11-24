// Google OAuth for Gmail: sign-in URL, code exchange, refresh and revoke.
//
// The only scope this app ever requests is gmail.readonly (read messages and settings,
// nothing else). The scope is a constant, not a parameter, and the token exchange refuses
// a grant whose scopes are anything else. A boundary test (lib/mail/mail-boundary.test.ts)
// fails if any other Google scope appears anywhere in the code.
//
// Plain fetch, no Google SDK: four small form posts and a URL do not justify a large
// dependency, and fetch is injectable so tests never reach Google.
//
// Errors carry the HTTP status and the OAuth error code only (for example invalid_grant),
// never a token, the client secret or a response body.

import { createHash, randomBytes } from "node:crypto";
import { MailAuthError } from "../types";
import type { OAuthTokens } from "../token-store";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Every scope the app requests. One, read-only. */
export const GMAIL_SCOPES: readonly string[] = Object.freeze([GMAIL_READONLY_SCOPE]);

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match an authorized redirect URI on the OAuth client exactly. */
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Env = Record<string, string | undefined>;
export const REQUIRED_GOOGLE_OAUTH_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
] as const;

export function googleOAuthFromEnv(env: Env = process.env, fetchImpl?: typeof fetch): GoogleOAuthConfig {
  const missing = REQUIRED_GOOGLE_OAUTH_ENV.filter((n) => !env[n]?.trim());
  if (missing.length) throw new Error(`Gmail sign-in not configured: set ${missing.join(", ")}`);
  const config = {
    clientId: env.GOOGLE_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    redirectUri: env.GOOGLE_REDIRECT_URI!.trim(),
    fetch: fetchImpl,
  };
  checkRedirectUri(config.redirectUri);
  return config;
}

/** https anywhere; plain http only for localhost (Google allows it for development). */
export function checkRedirectUri(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GOOGLE_REDIRECT_URI is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("GOOGLE_REDIRECT_URI must use https (plain http only for localhost)");
  }
  if (url.hash || url.username || url.password) {
    throw new Error("GOOGLE_REDIRECT_URI must not have a fragment or credentials");
  }
  return url;
}

/** PKCE (RFC 7636) verifier and S256 challenge. Keep the verifier server-side with the state. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** A random value for the OAuth state parameter (CSRF protection). */
export function createState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * The Google sign-in URL. Requests gmail.readonly only, offline access (a refresh token),
 * and the consent screen every time so Google always returns a refresh token. It does not
 * set include_granted_scopes, so a grant can never widen beyond this one scope.
 */
export function buildAuthorizationUrl(
  config: Pick<GoogleOAuthConfig, "clientId" | "redirectUri">,
  { state, codeChallenge, loginHint }: { state: string; codeChallenge: string; loginHint?: string },
): string {
  checkRedirectUri(config.redirectUri);
  if (!state || !codeChallenge) throw new Error("state and codeChallenge are required");
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return url.toString();
}

/** Throws unless the granted scopes are exactly the ones requested. */
export function checkGrantedScope(scope: unknown): string {
  if (typeof scope !== "string") throw new MailAuthError("Google did not report the granted scope");
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  if (!granted.has(GMAIL_READONLY_SCOPE)) {
    throw new MailAuthError("Gmail read access was not granted; please allow it and try again");
  }
  const extra = [...granted].filter((s) => !GMAIL_SCOPES.includes(s));
  if (extra.length) {
    // Never expected: the app asks for one scope. Refuse rather than hold broader access.
    throw new MailAuthError(`Google granted unexpected scopes (${extra.length}); refusing the grant`);
  }
  return GMAIL_SCOPES.join(" ");
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

async function postToken(config: GoogleOAuthConfig, params: Record<string, string>): Promise<TokenResponse> {
  const doFetch = config.fetch ?? fetch;
  const response = await doFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...params,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  let data: TokenResponse = {};
  try {
    data = (await response.json()) as TokenResponse;
  } catch {
    // Non-JSON body: fall through with the status only.
  }
  if (!response.ok) {
    const code = typeof data.error === "string" && /^[a-z_]{1,40}$/.test(data.error) ? data.error : "unknown";
    const message = `Google token request failed with HTTP ${response.status} (${code})`;
    // invalid_grant: the refresh token was revoked or expired, or the code was already used.
    if (code === "invalid_grant" || response.status === 401) throw new MailAuthError(message);
    throw new Error(message);
  }
  return data;
}

function expiresAt(config: GoogleOAuthConfig, expiresIn: unknown): number {
  const now = (config.now ?? Date.now)();
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
  return now + seconds * 1000;
}

/** Exchanges the code from the OAuth callback for tokens. */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  { code, codeVerifier }: { code: string; codeVerifier: string },
): Promise<OAuthTokens> {
  checkRedirectUri(config.redirectUri);
  const data = await postToken(config, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: config.redirectUri,
  });
  const scope = checkGrantedScope(data.scope);
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Google token response had no access token");
  }
  if (typeof data.refresh_token !== "string" || !data.refresh_token) {
    throw new MailAuthError("Google returned no refresh token; please connect again");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: expiresAt(config, data.expires_in),
    scope,
  };
}

/** New access token from a refresh token. Google may also rotate the refresh token. */
export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number; refreshToken?: string; scope?: string }> {
  const data = await postToken(config, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Google refresh response had no access token");
  }
  const scope = data.scope === undefined ? undefined : checkGrantedScope(data.scope);
  return {
    accessToken: data.access_token,
    expiresAt: expiresAt(config, data.expires_in),
    ...(typeof data.refresh_token === "string" && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** Revokes the grant at Google (on disconnect). Best effort: a 400 means already revoked. */
export async function revokeGrant(config: GoogleOAuthConfig, token: string): Promise<void> {
  const doFetch = config.fetch ?? fetch;
  const response = await doFetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 400) {
    throw new Error(`Google revoke request failed with HTTP ${response.status}`);
  }
}
