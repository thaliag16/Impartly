import "server-only";

// Real dependencies for the Gmail routes: Supabase Auth for the user, Google OAuth from
// env, the Vault token store on the service-role client, and the user's own connection
// read under RLS with the user's session (not the service role).

import { googleOAuthFromEnv } from "../mail/gmail/oauth";
import { createVaultTokenStore } from "../mail/token-store";
import type { MailProvider } from "../mail/types";
import { adminRpc, createAdminClient } from "../supabase/admin";
import { createRequestClient, getRequestUser } from "../supabase/request-client";
import type { GmailRouteDeps } from "./gmail";

export function gmailRouteDeps(): GmailRouteDeps {
  return {
    getUser: async (request) => getRequestUser(createRequestClient(request)),
    oauth: () => googleOAuthFromEnv(),
    tokenStore: () => createVaultTokenStore(adminRpc(createAdminClient())),
    async ownedConnection(request, userId, connectionId) {
      const rc = createRequestClient(request);
      if (!rc) return null;
      const { data, error } = await rc.client
        .from("mail_connections")
        .select("id, provider, user_id")
        .eq("id", connectionId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error || !data || data.user_id !== userId) return null;
      return { id: String(data.id), provider: data.provider as MailProvider };
    },
  };
}
