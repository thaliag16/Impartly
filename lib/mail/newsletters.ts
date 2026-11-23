// Which messages are newsletters, and which of those this user wants in the briefing.
// Provider-neutral: works on MailMessage from any adapter.
//
// A message is a newsletter if any strong signal is present:
//   * a List-Unsubscribe or List-Id header (RFC 2369 / RFC 2919; bulk senders must send
//     List-Unsubscribe to reach Gmail and Yahoo inboxes)
//   * the sender is in the user's newsletter_sources (included or not)
// or at least two weak signals:
//   * Precedence: bulk / list
//   * the provider filed it as bulk mail (Gmail's Promotions or Updates tab)
//   * a newsletter-style sender name (news@, newsletter@, digest@, weekly@, ...)
//   * "unsubscribe" or "view in browser" in the body
// Auto-replies (Auto-Submitted: auto-replied) are never newsletters.
//
// Then: senders the user switched off (included = false) are dropped, messages before
// `since` are dropped, and a newsletter from a sender not yet in newsletter_sources is kept
// (new senders are included by default) and reported in discoveredSenders so the pipeline
// can add it to the user's list.

import type { Newsletter } from "../summarizer/types";
import { htmlToText, plainTextToText, DEFAULT_MAX_CHARS } from "../text/html-to-text";
import type { MailAdapter, MailMessage } from "./types";

export interface NewsletterSource {
  senderAddress: string;
  included: boolean;
}

export interface Detection {
  isNewsletter: boolean;
  reasons: string[];
}

const NEWSLETTER_LOCAL_PART =
  /^(?:news|newsletters?|digest|weekly|daily|briefing|bulletin|roundup|dispatch|editors?|the-?brief)(?:[._+-]|$)/;

export function detectNewsletter(message: MailMessage, knownSenders: ReadonlySet<string>): Detection {
  const h = message.headers;
  if (/^auto-replied/i.test(h["auto-submitted"] ?? "")) {
    return { isNewsletter: false, reasons: ["auto-reply"] };
  }

  const strong: string[] = [];
  if (h["list-unsubscribe"]?.trim()) strong.push("list-unsubscribe header");
  if (h["list-id"]?.trim()) strong.push("list-id header");
  if (knownSenders.has(message.from.address)) strong.push("known sender");
  if (strong.length) return { isNewsletter: true, reasons: strong };

  const weak: string[] = [];
  if (/^(?:bulk|list)\b/i.test(h["precedence"]?.trim() ?? "")) weak.push("precedence bulk");
  if (message.bulkCategory) weak.push("bulk category");
  if (NEWSLETTER_LOCAL_PART.test(message.from.address.split("@")[0] ?? "")) weak.push("newsletter sender name");
  const body = `${message.html ?? ""}\n${message.text ?? ""}`;
  if (/unsubscribe/i.test(body)) weak.push("unsubscribe link");
  if (/view (?:this |it )?(?:email |newsletter )?(?:in (?:your |a )?browser|online)/i.test(body)) {
    weak.push("view in browser link");
  }
  return weak.length >= 2 ? { isNewsletter: true, reasons: weak } : { isNewsletter: false, reasons: weak };
}

/** A newsletter ready to store (newsletters table) and summarize. All text is untrusted. */
export interface PulledNewsletter {
  providerMessageId: string;
  senderAddress: string;
  senderName?: string;
  subject: string;
  receivedAt: string;
  /** Visible text only (see lib/text/html-to-text.ts), capped at maxChars. */
  bodyText: string;
  truncated: boolean;
  reasons: string[];
}

export interface SelectOptions {
  /** The user's newsletter_sources rows. */
  sources: readonly NewsletterSource[];
  /** Keep only messages received at or after this time. */
  since: Date;
  maxChars?: number;
}

export interface Selection {
  newsletters: PulledNewsletter[];
  /** Newsletter senders not yet in newsletter_sources (included by default). */
  discoveredSenders: { address: string; name?: string }[];
  skipped: { beforeSince: number; notNewsletter: number; excluded: number; empty: number };
}

/** The text the summarizer sees: the HTML part if there is one (what the reader sees). */
export function visibleText(message: MailMessage, maxChars = DEFAULT_MAX_CHARS) {
  // Prefer HTML over the text/plain alternative even when both exist. Mail clients show
  // the HTML part, so a text/plain part is something the reader never sees, and could
  // carry instructions that are not in the visible HTML.
  if (message.html?.trim()) return htmlToText(message.html, { maxChars });
  if (message.text?.trim()) return plainTextToText(message.text, { maxChars });
  return { text: "", truncated: false };
}

export function selectNewsletters(messages: readonly MailMessage[], options: SelectOptions): Selection {
  const sourceByAddress = new Map(options.sources.map((s) => [s.senderAddress.toLowerCase(), s]));
  const known = new Set(sourceByAddress.keys());
  const since = options.since.getTime();
  const result: Selection = {
    newsletters: [],
    discoveredSenders: [],
    skipped: { beforeSince: 0, notNewsletter: 0, excluded: 0, empty: 0 },
  };
  const seenIds = new Set<string>();
  const discovered = new Map<string, string | undefined>();

  for (const message of messages) {
    if (seenIds.has(message.id)) continue;
    seenIds.add(message.id);

    const received = Date.parse(message.receivedAt);
    if (!(received >= since)) {
      result.skipped.beforeSince++;
      continue;
    }
    const detection = detectNewsletter(message, known);
    if (!detection.isNewsletter) {
      result.skipped.notNewsletter++;
      continue;
    }
    const source = sourceByAddress.get(message.from.address);
    if (source && !source.included) {
      result.skipped.excluded++;
      continue;
    }
    const { text, truncated } = visibleText(message, options.maxChars);
    if (!text) {
      result.skipped.empty++;
      continue;
    }
    if (!source && !discovered.has(message.from.address)) {
      discovered.set(message.from.address, message.from.name);
    }
    result.newsletters.push({
      providerMessageId: message.id,
      senderAddress: message.from.address,
      senderName: message.from.name,
      subject: message.subject,
      receivedAt: message.receivedAt,
      bodyText: text,
      truncated,
      reasons: detection.reasons,
    });
  }
  result.discoveredSenders = [...discovered].map(([address, name]) => ({ address, ...(name ? { name } : {}) }));
  return result;
}

/** List, detect, filter and convert in one step. */
export async function pullNewsletters(
  adapter: MailAdapter,
  options: SelectOptions & { limit?: number },
): Promise<Selection> {
  const messages = await adapter.listMessagesSince(options.since, { limit: options.limit });
  return selectNewsletters(messages, options);
}

/** The summarizer's input for a pulled newsletter. */
export function toSummarizerInput(n: PulledNewsletter): Newsletter {
  return {
    from: n.senderName ? `${n.senderName} <${n.senderAddress}>` : n.senderAddress,
    subject: n.subject,
    receivedAt: n.receivedAt,
    text: n.bodyText,
  };
}
