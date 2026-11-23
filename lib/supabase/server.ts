import "server-only";

// A Supabase client for server components, bound to the request's cookies through
// next/headers. Publishable key only: it acts as the signed-in user, under RLS. Server
// components cannot set cookies, so session refreshes are written by the proxy (proxy.ts).

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { sessionCookieOptions, supabasePublicConfig } from "./config";

export async function createComponentClient(): Promise<SupabaseClient | null> {
  const config = supabasePublicConfig();
  if (!config) return null;
  const jar = await cookies();
  const proto = (await headers()).get("x-forwarded-proto");
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => jar.getAll().map(({ name, value }) => ({ name, value })),
      setAll() {
        // Server components cannot write cookies; the proxy refreshes the session.
      },
    },
    cookieOptions: sessionCookieOptions(proto === "https"),
  });
}

/** The signed-in user, confirmed by Supabase Auth, or null. */
export async function getComponentUser(client: SupabaseClient | null): Promise<User | null> {
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getUser();
    return error ? null : (data.user ?? null);
  } catch {
    return null;
  }
}
