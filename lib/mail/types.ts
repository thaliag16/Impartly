// The mail adapter interface. Everything outside lib/mail talks to a mailbox through these
// types only. Mail access is read-only (CLAUDE.md): an adapter can list and read messages
// and nothing else. There is no method to send, change, label, move or delete mail, and
// adding one is a rule change, not a feature.
//
// Gmail is the first implementation (lib/mail/gmail). Outlook comes second and fits the
// same shape: Microsoft Graph's /me/messages with a receivedDateTime filter and
// internetMessageHeaders gives the same fields.

export type MailProvider = "gmail" | "outlook";

export interface MailAddress {
  /** Lower-cased address, e.g. "news@weekly.example". */
  address: string;
  /** Display name, if the From header had one. */
  name?: string;
}

/** One message as the adapter read it. Every field is untrusted (it came from an inbox). */
export interface MailMessage {
  /** The provider's message id (stable, used to skip messages already pulled). */
  id: string;
  from: MailAddress;
  subject: string;
  /** When the mailbox received it (ISO 8601). */
  receivedAt: string;
  /**
   * Headers that matter for newsletter detection, names lower-cased (list-unsubscribe,
   * list-id, precedence, ...). Not every header: only the ones the adapter keeps.
   */
  headers: Record<string, string>;
  /** The provider sorted it as bulk mail (Gmail's Promotions or Updates tabs). */
  bulkCategory: boolean;
  /** The text/html body, decoded to a string, if there was one. */
  html?: string;
  /** The text/plain body, decoded to a string, if there was one. */
  text?: string;
}

export interface ListOptions {
  /** Upper bound on messages returned, newest first. Default 200. */
  limit?: number;
}

export interface MailAdapter {
  readonly provider: MailProvider;
  /** The connected mailbox's own address. */
  accountAddress(): Promise<string>;
  /** Messages received at or after `since`, newest first. Read-only. */
  listMessagesSince(since: Date, options?: ListOptions): Promise<MailMessage[]>;
}

/** The connection needs the user to sign in again (revoked, expired or refused grant). */
export class MailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAuthError";
  }
}

/** Header names an adapter keeps on MailMessage.headers. */
export const KEPT_HEADERS = [
  "list-unsubscribe",
  "list-unsubscribe-post",
  "list-id",
  "precedence",
  "auto-submitted",
] as const;
