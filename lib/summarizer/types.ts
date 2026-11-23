// The summarizer's provider interface. Everything outside lib/summarizer talks to
// summaries through these types only: no model name and no vendor call leaves this module.

/** One newsletter issue as plain text. Every field is untrusted (it came from an inbox). */
export interface Newsletter {
  from: string;
  subject: string;
  /** ISO 8601 time the issue arrived. */
  receivedAt: string;
  text: string;
}

/** The lengths the listener can choose (README: headline, brief or deep). */
export type SummaryLength = "headline" | "brief" | "deep";

/**
 * Word limits per length. Provisional, a product call for Thalia (see PROGRESS.md):
 * headline is one or two sentences, brief a short paragraph, deep a full read-out.
 */
export const LENGTH_LIMITS: Record<SummaryLength, { minWords: number; maxWords: number }> = {
  headline: { minWords: 8, maxWords: 40 },
  brief: { minWords: 25, maxWords: 90 },
  deep: { minWords: 60, maxWords: 180 },
};

export const SUMMARY_LENGTHS = Object.keys(LENGTH_LIMITS) as SummaryLength[];

export interface SummaryProvider {
  /** Returns the spoken-style summary text. */
  summarize(newsletter: Newsletter, options: { length: SummaryLength }): Promise<string>;
}
