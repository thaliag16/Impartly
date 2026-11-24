// Turns a day's summaries into the briefing's script: what is said, in what order, cut
// into the sentence-sized chunks Kokoro renders one at a time (lib/speech/sentences.ts).
//
//   intro, then for each newsletter: a spoken transition ("First, <newsletter>."), and
//   for each of its issues (oldest first): the subject as a headline, a preview note for
//   partial issues, then the summary; then the outro.
//
// Newsletters follow the user's order (user_settings.feed_order); any not in it follow,
// the one with the newest issue first. Pure: no I/O, so the player, the render-ahead step
// and tests all build the same script from the same items.
//
// Titles and subjects come from newsletters, so they are untrusted. They are only ever
// spoken, never sent to a model, and are cleaned for speech here (no markup or URLs,
// bounded length).

import { MAX_CHUNK_CHARS, splitSentences } from "../speech/sentences";

export interface BriefingItem {
  /** The newsletter (issue) id. */
  id: string;
  /** The web feed it came from; null for a mail source. Groups issues into sections. */
  feedId: string | null;
  /** The newsletter's name as shown to the user (feed title or sender name). */
  source: string;
  subject: string;
  summary: string;
  /** Only a preview was public (PROGRESS.md: partial issues). */
  partial: boolean;
  /** ISO 8601. */
  receivedAt: string;
}

export interface ScriptOptions {
  /** Web feed ids in the user's chosen order. */
  feedOrder?: readonly string[];
}

export type SentenceKind = "transition" | "headline" | "note" | "summary";

export interface ScriptSentence {
  /** Position in play order, from 0. */
  index: number;
  kind: SentenceKind;
  text: string;
  /** Index into `sections`, or null for the intro and outro. */
  section: number | null;
  /** The issue this sentence belongs to, or null for transitions. */
  itemId: string | null;
}

export interface ScriptSection {
  title: string;
  feedId: string | null;
  itemIds: string[];
  /** Index of the section's opening transition in `sentences`. */
  firstSentence: number;
}

export interface BriefingScript {
  sentences: ScriptSentence[];
  sections: ScriptSection[];
  storyCount: number;
}

const TITLE_MAX = 80;
const SUBJECT_MAX = 160;
export const PREVIEW_NOTE = "This one is a preview; the rest is for paid subscribers.";

/** Removes markup, URLs and stray separators; collapses spaces; caps length at a word. */
export function cleanForSpeech(text: string, max: number): string {
  let out = text
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/[|•·]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\-–—:;,]+|[\s\-–—:;,]+$/g, "");
  if (out.length > max) {
    const cut = out.lastIndexOf(" ", max);
    out = out.slice(0, cut > max / 2 ? cut : max).replace(/[\s,;:\-–—]+$/, "");
  }
  return out;
}

const withStop = (text: string) => (/[.!?]["'”’)]*$/.test(text) ? text : `${text}.`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function assembleBriefing(items: readonly BriefingItem[], options: ScriptOptions = {}): BriefingScript {
  const usable = items.filter((item) => item.summary.trim().length > 0);

  // Group by feed (or, for mail, by source name).
  const groups = new Map<string, { feedId: string | null; title: string; items: BriefingItem[]; newest: number }>();
  for (const item of usable) {
    const key = item.feedId ?? `source:${item.source.trim().toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = { feedId: item.feedId, title: cleanForSpeech(item.source, TITLE_MAX) || "a newsletter", items: [], newest: 0 };
      groups.set(key, group);
    }
    group.items.push(item);
    group.newest = Math.max(group.newest, Date.parse(item.receivedAt) || 0);
  }

  const rank = new Map<string, number>();
  for (const id of options.feedOrder ?? []) if (!rank.has(id)) rank.set(id, rank.size);
  const ordered = [...groups.values()].sort((a, b) => {
    const ra = a.feedId !== null ? rank.get(a.feedId) : undefined;
    const rb = b.feedId !== null ? rank.get(b.feedId) : undefined;
    if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity);
    return b.newest - a.newest || a.title.localeCompare(b.title);
  });

  const sentences: ScriptSentence[] = [];
  const sections: ScriptSection[] = [];
  const say = (kind: SentenceKind, text: string, section: number | null, itemId: string | null) => {
    for (const chunk of splitSentences(text, MAX_CHUNK_CHARS)) {
      sentences.push({ index: sentences.length, kind, text: chunk, section, itemId });
    }
  };

  if (ordered.length === 0) {
    say("transition", "No new newsletters since your last briefing.", null, null);
    return { sentences, sections, storyCount: 0 };
  }

  say(
    "transition",
    `Here is your briefing: ${plural(usable.length, "story", "stories")} from ${plural(ordered.length, "newsletter", "newsletters")}.`,
    null,
    null,
  );

  ordered.forEach((group, s) => {
    const lead = ordered.length === 1 ? "From" : s === 0 ? "First," : s === ordered.length - 1 ? "Finally," : "Next,";
    sections.push({ title: group.title, feedId: group.feedId, itemIds: [], firstSentence: sentences.length });
    say("transition", `${lead} ${group.title}.`, s, null);
    const chronological = [...group.items].sort((a, b) => (Date.parse(a.receivedAt) || 0) - (Date.parse(b.receivedAt) || 0));
    for (const item of chronological) {
      sections[s].itemIds.push(item.id);
      const subject = cleanForSpeech(item.subject, SUBJECT_MAX);
      if (subject) say("headline", withStop(subject), s, item.id);
      if (item.partial) say("note", PREVIEW_NOTE, s, item.id);
      say("summary", item.summary, s, item.id);
    }
  });

  say("transition", "That's your briefing.", null, null);
  return { sentences, sections, storyCount: usable.length };
}
