import "server-only";

// The service-role Supabase client. It bypasses row-level security, so:
//   * this is the only module that reads SUPABASE_SECRET_KEY (boundary test:
//     lib/supabase/boundary.test.ts), and it is marked server-only, so the build fails if
//     a client component imports it, directly or through another module;
//   * callers scope every write to one user id (the pipeline and mail-token SQL functions
//     take the user id and touch only that user's rows).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Rpc } from "../mail/token-store";
import { supabasePublicConfig } from "./config";

export function createAdminClient(env: Record<string, string | undefined> = process.env): SupabaseClient {
  const config = supabasePublicConfig(env);
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  if (!config || !secretKey) {
    throw new Error("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  }
  return createClient(config.url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** supabase-js rpc as the Rpc shape lib/mail and lib/pipeline use. Errors carry the code only. */
export function adminRpc(client: SupabaseClient): Rpc {
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      const code = typeof error.code === "string" && /^[A-Za-z0-9]{1,10}$/.test(error.code) ? error.code : "unknown";
      throw new Error(`${fn} failed (${code})`);
    }
    return data;
  };
}
