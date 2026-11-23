// The mail module: one read-only adapter interface (types.ts), the Gmail implementation,
// newsletter detection and HTML to text. Outlook is planned as a second adapter.

import { createGmailAdapter } from "./gmail/adapter";
import { refreshAccessToken, type GoogleOAuthConfig } from "./gmail/oauth";
import { createStoredTokenSource } from "./token-session";
import type { TokenStore } from "./token-store";
import type { MailAdapter } from "./types";

export * from "./types";
export { htmlToText, plainTextToText } from "../text/html-to-text";
export { detectNewsletter, pullNewsletters, selectNewsletters, toSummarizerInput } from "./newsletters";
export type { NewsletterSource, PulledNewsletter, Selection } from "./newsletters";
export { createVaultTokenStore, createMemoryTokenStore } from "./token-store";
export type { OAuthTokens, TokenStore, Rpc } from "./token-store";

/** The Gmail adapter for one stored connection, refreshing its tokens as needed. */
export function gmailAdapterForConnection(options: {
  connectionId: string;
  store: TokenStore;
  oauth: GoogleOAuthConfig;
  fetch?: typeof fetch;
}): MailAdapter {
  const tokens = createStoredTokenSource({
    connectionId: options.connectionId,
    store: options.store,
    refresh: (refreshToken) => refreshAccessToken(options.oauth, refreshToken),
    now: options.oauth.now,
  });
  return createGmailAdapter({ tokens, fetch: options.fetch });
}
