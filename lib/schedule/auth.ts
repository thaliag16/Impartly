// Who may call the pull route: only Supabase Cron, which sends
// "Authorization: Bearer <CRON_SECRET>" (the secret is read from Supabase Vault at each
// tick; the same value sits in the CRON_SECRET env var on Vercel).
//
// The comparison is constant-time: both sides are hashed with SHA-256 and the digests
// compared with timingSafeEqual, so neither the secret's length nor how many leading
// characters match shows in the response time. A secret shorter than 32 characters
// counts as not set, and then nothing is accepted (fail closed).

import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_CRON_SECRET_LENGTH = 32;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function cronSecretConfigured(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_CRON_SECRET_LENGTH;
}

export function isAuthorizedCronRequest(authorization: string | null, secret: string | undefined): boolean {
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(authorization ?? "");
  // Hash something either way, so a missing or malformed header takes the same path.
  const given = digest(match ? match[1] : "");
  const expected = digest(cronSecretConfigured(secret) ? secret : "");
  const equal = timingSafeEqual(given, expected);
  return equal && !!match && cronSecretConfigured(secret);
}
