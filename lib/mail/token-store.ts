// Where a mail connection's OAuth tokens live.
//
// In production the tokens sit in Supabase Vault, never in a table column: the SQL
// functions in supabase/migrations/20261123130000_mail_token_vault.sql create the Vault
// secret with vault.create_secret, keep only its id in mail_connections.token_secret_id,
// and delete the secret when the connection row is deleted (including when the user is
// deleted). Only the service role can call those functions.
//
// Nothing here logs or puts a token in an error message.

import type { MailProvider } from "./types";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token expiry, milliseconds since the epoch. */
  expiresAt: number;
  /** Space-separated scopes the provider granted. */
  scope: string;
}

export interface ConnectionRef {
  userId: string;
  provider: MailProvider;
  accountAddress: string;
}

export interface TokenStore {
  /** Creates the connection (or reconnects an existing one) with these tokens; returns its id. */
  saveConnection(ref: ConnectionRef, tokens: OAuthTokens): Promise<string>;
  read(connectionId: string): Promise<OAuthTokens>;
  update(connectionId: string, tokens: OAuthTokens): Promise<void>;
  /** Deletes the connection and its stored tokens. */
  removeConnection(connectionId: string): Promise<void>;
}

/**
 * Calls a Postgres function by name with named arguments and returns its scalar result,
 * the way supabase-js's `rpc(fn, args)` returns `data`. Wire it to a service-role client.
 */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export function serializeTokens(tokens: OAuthTokens): string {
  return JSON.stringify({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
  });
}

export function parseTokens(raw: unknown): OAuthTokens {
  let data: Record<string, unknown>;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    throw new Error("Stored mail tokens are not valid JSON");
  }
  const { access_token, refresh_token, expires_at, scope } = data ?? {};
  if (
    typeof access_token !== "string" ||
    typeof refresh_token !== "string" ||
    !refresh_token ||
    typeof expires_at !== "number" ||
    typeof scope !== "string"
  ) {
    throw new Error("Stored mail tokens are missing a field");
  }
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: expires_at, scope };
}

/** Token store backed by Supabase Vault through the migration's SQL functions. */
export function createVaultTokenStore(rpc: Rpc): TokenStore {
  return {
    async saveConnection(ref, tokens) {
      const id = await rpc("mail_connection_save", {
        p_user_id: ref.userId,
        p_provider: ref.provider,
        p_account_address: ref.accountAddress.toLowerCase(),
        p_tokens: serializeTokens(tokens),
      });
      if (typeof id !== "string") throw new Error("mail_connection_save returned no id");
      return id;
    },
    async read(connectionId) {
      const raw = await rpc("mail_connection_tokens", { p_connection_id: connectionId });
      if (raw === null || raw === undefined) throw new Error("No stored tokens for this mail connection");
      return parseTokens(raw);
    },
    async update(connectionId, tokens) {
      await rpc("mail_connection_update_tokens", {
        p_connection_id: connectionId,
        p_tokens: serializeTokens(tokens),
      });
    },
    async removeConnection(connectionId) {
      await rpc("mail_connection_remove", { p_connection_id: connectionId });
    },
  };
}

/** In-memory token store for tests and local experiments. Holds nothing after exit. */
export function createMemoryTokenStore(): TokenStore & { size(): number } {
  const byId = new Map<string, { ref: ConnectionRef; secret: string }>();
  return {
    async saveConnection(ref, tokens) {
      const key = { ...ref, accountAddress: ref.accountAddress.toLowerCase() };
      for (const [id, entry] of byId) {
        const r = entry.ref;
        if (r.userId === key.userId && r.provider === key.provider && r.accountAddress === key.accountAddress) {
          entry.secret = serializeTokens(tokens);
          return id;
        }
      }
      const id = crypto.randomUUID();
      byId.set(id, { ref: key, secret: serializeTokens(tokens) });
      return id;
    },
    async read(id) {
      const entry = byId.get(id);
      if (!entry) throw new Error("No stored tokens for this mail connection");
      return parseTokens(entry.secret);
    },
    async update(id, tokens) {
      const entry = byId.get(id);
      if (!entry) throw new Error("No stored tokens for this mail connection");
      entry.secret = serializeTokens(tokens);
    },
    async removeConnection(id) {
      byId.delete(id);
    },
    size: () => byId.size,
  };
}
