// Supabase settings that may be known to the browser: the project URL and the publishable
// key. The secret key is NOT here: it is read only in lib/supabase/admin.ts, which is
// server-only (a boundary test in lib/supabase/boundary.test.ts enforces both).

type Env = Record<string, string | undefined>;

export interface SupabasePublicConfig {
  url: string;
  publishableKey: string;
}

/** The public config, or null when the app has not been configured (sign-in then fails closed). */
export function supabasePublicConfig(env: Env = process.env): SupabasePublicConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) return null;
  return { url: parsed.origin, publishableKey };
}

/**
 * Options for the session cookies @supabase/ssr writes. httpOnly because the app has no
 * browser-side Supabase client (all auth runs on the server); sameSite lax so the cookies
 * are not sent on cross-site POSTs; secure whenever the site is served over https.
 */
export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/" };
}
