// Access tokens for one mail connection: reads the stored tokens, refreshes when they are
// about to expire or when the provider answers 401, and saves what the refresh returns.
// Provider-neutral: the refresh call is passed in (Google's for Gmail).

import type { OAuthTokens, TokenStore } from "./token-store";

export interface AccessTokenSource {
  /** A current access token (refreshed first if it expires within the skew). */
  get(): Promise<string>;
  /** Forces a refresh (after a 401) and returns the new access token. */
  refresh(): Promise<string>;
}

export type RefreshFn = (
  refreshToken: string,
) => Promise<{ accessToken: string; expiresAt: number; refreshToken?: string; scope?: string }>;

export function createStoredTokenSource(options: {
  connectionId: string;
  store: TokenStore;
  refresh: RefreshFn;
  now?: () => number;
  /** Refresh this long before expiry. Default 60 s. */
  skewMs?: number;
}): AccessTokenSource {
  const now = options.now ?? Date.now;
  const skew = options.skewMs ?? 60_000;
  let cached: OAuthTokens | undefined;
  let inFlight: Promise<string> | undefined;

  const load = async () => (cached ??= await options.store.read(options.connectionId));

  const doRefresh = () => {
    // One refresh at a time; concurrent callers share it.
    inFlight ??= (async () => {
      try {
        const current = await load();
        const fresh = await options.refresh(current.refreshToken);
        const next: OAuthTokens = {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken ?? current.refreshToken,
          expiresAt: fresh.expiresAt,
          scope: fresh.scope ?? current.scope,
        };
        await options.store.update(options.connectionId, next);
        cached = next;
        return next.accessToken;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    async get() {
      const tokens = await load();
      if (tokens.expiresAt - skew <= now()) return doRefresh();
      return tokens.accessToken;
    },
    refresh: doRefresh,
  };
}
