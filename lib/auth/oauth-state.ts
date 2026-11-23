// The OAuth "state" and PKCE verifier for the Gmail connect flow, kept server-side in an
// encrypted, short-lived cookie between /api/mail/gmail/connect and
// /api/mail/gmail/callback.
//
// Why a cookie and not a database row: it needs no new table, no new secret and no
// cleanup job, and it ties the flow to the browser that started it. The cookie is
//   * AES-256-GCM encrypted and authenticated, so the browser can neither read the PKCE
//     verifier nor forge or alter the state; the key is derived with HKDF from
//     GOOGLE_CLIENT_SECRET (a server secret the flow needs anyway) under its own label,
//     so no new secret is needed and it is unusable for anything else;
//   * bound to the signed-in user id (the callback refuses it for any other user) and to
//     the state value (compared in constant time);
//   * valid for 10 minutes, single use (the callback always clears it);
//   * httpOnly, Secure, SameSite=Lax (Lax is required: Google's redirect back is a
//     cross-site top-level GET, which Lax cookies are sent on), and __Host- prefixed, so
//     it is host-only with Path=/ and cannot be set by a sibling subdomain.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_STATE_COOKIE = "__Host-impartly-gmail-oauth";
export const OAUTH_STATE_TTL_SECONDS = 600;

export interface OAuthStatePayload {
  state: string;
  verifier: string;
  userId: string;
  /** Expiry, ms since the epoch. */
  exp: number;
}

export function deriveStateKey(serverSecret: string): Buffer {
  if (!serverSecret || serverSecret.length < 8) throw new Error("A server secret is required for the OAuth state key");
  return Buffer.from(hkdfSync("sha256", serverSecret, "impartly", "gmail-oauth-state-cookie v1", 32));
}

export function sealState(payload: OAuthStatePayload, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** The payload, or null if the cookie is missing, altered, for another key, or expired. */
export function openState(sealed: string | undefined, key: Buffer, now: number): OAuthStatePayload | null {
  if (!sealed || sealed.length > 2048) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const p = JSON.parse(json) as Partial<OAuthStatePayload>;
    if (
      typeof p.state !== "string" ||
      typeof p.verifier !== "string" ||
      typeof p.userId !== "string" ||
      typeof p.exp !== "number"
    ) {
      return null;
    }
    if (p.exp <= now) return null;
    return p as OAuthStatePayload;
  } catch {
    return null;
  }
}

export function sameState(a: string, b: string | null): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function stateCookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: maxAgeSeconds };
}
