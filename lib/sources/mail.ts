// A connected mailbox as a NewsletterSource. Optional (GOAL.md Phase 1: Gmail is not a
// gate). It wraps the read-only mail adapter (lib/mail): list, detect newsletters, drop
// switched-off senders and convert to visible text, exactly as before the source layer.

import { MailAuthError, pullNewsletters, type MailAdapter, type NewsletterSource as SenderRule } from "../mail";
import { SourceAuthError, type NewsletterSource, type PullResult } from "./types";

export function mailSource(options: {
  id: string;
  adapter: MailAdapter;
  /** The user's sender rules as they stand when the pull starts (senders found by an
   * earlier source in the same run count as known). */
  senderRules: () => readonly SenderRule[];
}): NewsletterSource {
  return {
    kind: "mail",
    id: options.id,
    async pull({ since, limit, maxChars }): Promise<PullResult> {
      let selection;
      try {
        selection = await pullNewsletters(options.adapter, { sources: options.senderRules(), since, limit, maxChars });
      } catch (err) {
        if (err instanceof MailAuthError) throw new SourceAuthError("mail_auth");
        throw err;
      }
      const s = selection.skipped;
      const listed = selection.newsletters.length + s.beforeSince + s.notNewsletter + s.excluded + s.empty;
      return {
        items: selection.newsletters.map((n) => ({
          key: n.providerMessageId,
          senderAddress: n.senderAddress,
          senderName: n.senderName,
          subject: n.subject,
          receivedAt: n.receivedAt,
          bodyText: n.bodyText,
          truncated: n.truncated,
          partial: false,
        })),
        listed,
        capped: listed >= limit,
        discoveredSenders: selection.discoveredSenders,
      };
    },
  };
}
