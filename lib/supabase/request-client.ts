// A Supabase client bound to one request's cookies, for the proxy and route handlers.
// It uses the publishable key only, so it acts as the signed-in user, under RLS.
// Session refreshes are collected and written onto the response with applyTo().

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";
import { sessionCookieOptions, supabasePublicConfig } from "./config";

type Env = Record<string, string | undefined>;

export interface RequestClient {
  client: SupabaseClient;
  /** Writes any refreshed session cookies (and their no-store headers) onto the response. */
  applyTo<R extends NextResponse>(response: R): R;
}

export interface RequestClientOptions {
  env?: Env;
  fetch?: typeof fetch;
}

export function isHttps(request: NextRequest): boolean {
  return request.nextUrl.protocol === "https:";
}

/** Null when Supabase is not configured. */
export function createRequestClient(request: NextRequest, options: RequestClientOptions = {}): RequestClient | null {
  const config = supabasePublicConfig(options.env);
  if (!config) return null;
  const pending: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const pendingHeaders: Record<string, string> = {};
  const client = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll().map(({ name, value }) => ({ name, value })),
      setAll(cookies, headers) {
        for (const c of cookies) {
          pending.push(c);
          // Later reads in the same request (e.g. the route after the proxy) see the update.
          request.cookies.set(c.name, c.value);
        }
        Object.assign(pendingHeaders, headers);
      },
    },
    cookieOptions: sessionCookieOptions(isHttps(request)),
    global: options.fetch ? { fetch: options.fetch } : undefined,
  });
  return {
    client,
    applyTo(response) {
      for (const c of pending) response.cookies.set(c.name, c.value, c.options);
      for (const [k, v] of Object.entries(pendingHeaders)) response.headers.set(k, v);
      return response;
    },
  };
}

/**
 * The signed-in user, confirmed by Supabase Auth (getUser asks the Auth server; it does
 * not trust the cookie alone). Null when signed out, on any error, or when unconfigured.
 */
export async function getRequestUser(rc: RequestClient | null): Promise<User | null> {
  if (!rc) return null;
  try {
    const { data, error } = await rc.client.auth.getUser();
    if (error || !data.user?.id) return null;
    return data.user;
  } catch {
    return null;
  }
}
