// Trims a newsletter's text before it is sent to the summary model (cost: every input
// token is billed). Drops what a listener never hears and the summary must not contain
// anyway: link targets, footer lines (unsubscribe, "view in browser", preferences,
// forward-to-a-friend, copyright), short sponsor blocks and separator lines. Then caps the
// text per summary length, cutting at a paragraph end.
//
// Conservative on purpose: a line is dropped only when it is short and looks like a footer
// or a sponsor heading, so news that merely mentions unsubscribing, subscribers or a
// sponsor stays (lib/summarizer/trim.test.ts pins both sides, and checks that every eval
// fixture keeps all its key facts). The text stays untrusted: this changes no rule about
// how it is wrapped in the prompt (./prompt.ts).

import type { SummaryLength } from "./types";

/**
 * The most characters sent per newsletter, by length. A headline is one or two sentences
 * about the lead story, so it needs far less of the issue than a deep summary. Never more
 * than the pipeline stores (20,000, DEFAULT_PIPELINE_LIMITS.maxCharsPerNewsletter).
 * Provisional (PROGRESS.md, run 27).
 */
export const INPUT_CHAR_CAP: Readonly<Record<SummaryLength, number>> = Object.freeze({
  headline: 8_000,
  brief: 14_000,
  deep: 20_000,
});

/** Longest line that may be dropped as a footer or sponsor heading. */
const FOOTER_MAX_CHARS = 200;

const URL = /\bhttps?:\/\/[^\s<>()[\]]+|\bwww\.[^\s<>()[\]]+/gi;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\([^)\s]*\)/g;

/** Footer lines, matched on the line with its link targets already removed. */
const FOOTER: RegExp[] = [
  /^(?:you(?:'| a)re|you are) receiving this\b/i,
  /^you received this (?:email|newsletter|message)\b/i,
  /^(?:view|read|open) (?:this|it|the)?\s*(?:email|newsletter|issue|post)?\s*(?:in|on) (?:your|a|the)? ?(?:browser|web)\b/i,
  /^(?:view|read) (?:this|it) online\b/i,
  /^(?:manage|update|change) (?:your )?(?:email )?(?:preferences|subscription|settings)\b/i,
  /^forward (?:this|it) to a friend\b/i,
  /^(?:was this|did someone|got this) forward(?:ed)?\b/i,
  /^(?:sign up|subscribe) (?:here|now|today|for free)\b/i,
  /^share (?:this|on)\b/i,
  /^(?:©|\(c\)|copyright\s+(?:©\s*)?\d{4})/i,
  /\ball rights reserved\.?$/i,
];

/** "unsubscribe" is a footer only with footer words around it (news can mention it too). */
const UNSUBSCRIBE = /\bunsubscribe\b/i;
const UNSUBSCRIBE_CONTEXT = /\b(?:click (?:here|to|the|this)|here|link|preferences|receiving|mailing list|opt out|from (?:this|these|our|all) (?:list|emails?|newsletters?|mailings?))\b|[|:]/i;

/** A short sponsor heading. The paragraph under it is the ad. */
const SPONSOR_HEADING = /^(?:sponsored|sponsor|presented by|together with|brought to you by|a (?:word|message) from (?:our|this week's|today's) sponsors?)\b/i;
const SPONSOR_HEADING_MAX_WORDS = 8;

const SEPARATOR = /^[\s*_=~\-–—•·.#]+$/;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function isFooter(line: string, hadUrl: boolean): boolean {
  if (line.length > FOOTER_MAX_CHARS) return false;
  if (FOOTER.some((re) => re.test(line))) return true;
  if (UNSUBSCRIBE.test(line)) {
    const rest = line.replace(UNSUBSCRIBE, "").replace(/[\s:|.]+/g, " ").trim();
    return hadUrl || UNSUBSCRIBE_CONTEXT.test(line) || words(rest) <= 2;
  }
  return false;
}

function cleanLine(raw: string): { line: string; hadUrl: boolean } {
  let hadUrl = false;
  const line = raw
    .replace(MARKDOWN_LINK, (_, text: string) => {
      hadUrl = true;
      return text;
    })
    .replace(URL, (url: string) => {
      hadUrl = true;
      // Sentence punctuation right after a link belongs to the sentence.
      return /[.,;:!?]+$/.exec(url)?.[0] ?? "";
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
  return { line, hadUrl };
}

/** Cuts to at most `max` characters: at a paragraph end, else a sentence end, else a word end. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const floor = max * 0.5;
  const para = head.lastIndexOf("\n\n");
  if (para >= floor) return head.slice(0, para).trimEnd();
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"));
  if (sentence >= floor) return head.slice(0, sentence + 1).trimEnd();
  const space = head.lastIndexOf(" ", max);
  return (space > 0 ? head.slice(0, space) : text.slice(0, max)).trimEnd();
}

export function trimForSummary(text: string, length: SummaryLength): string {
  const out: string[] = [];
  // After a bare sponsor heading: "await" skips blank lines up to the ad paragraph, "in"
  // skips the ad paragraph up to the next blank line.
  let sponsor: "off" | "await" | "in" = "off";
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const { line, hadUrl } = cleanLine(raw);
    if (!line) {
      if (sponsor === "in") sponsor = "off";
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (sponsor !== "off") {
      sponsor = "in";
      continue;
    }
    if (SEPARATOR.test(line) || isFooter(line, hadUrl)) continue;
    if (line.length <= FOOTER_MAX_CHARS && SPONSOR_HEADING.test(line)) {
      // A bare heading ("SPONSORED", "Together with Acme") hides the paragraph under it; a
      // heading with its ad on the same line ("Sponsored by Acme: try it") is that line only.
      if (words(line) <= SPONSOR_HEADING_MAX_WORDS && !/[:.!?]/.test(line)) sponsor = "await";
      continue;
    }
    out.push(line);
  }
  return cap(out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), INPUT_CHAR_CAP[length]);
}
