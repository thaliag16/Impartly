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

/**
 * How much the model may "think" before answering, for models that support it. Thinking
 * counts against the answer budget, so a thinking model can spend the whole budget and
 * return no summary; summaries need none. "off" (the default) asks the endpoint to turn it
 * off, an effort level asks for that much, and "default" sends no setting at all (for an
 * endpoint that rejects the field).
 */
export const SUMMARY_REASONING_SETTINGS = ["off", "minimal", "low", "medium", "high", "default"] as const;
export type SummaryReasoning = (typeof SUMMARY_REASONING_SETTINGS)[number];

/** Token counts for one summary request, as the endpoint reported them (for spend logs). */
export interface SummaryUsage {
  promptTokens: number;
  completionTokens: number;
  /** Thinking tokens, when the endpoint reports them separately (they are billed as output). */
  reasoningTokens: number;
  /** The request's cost in the endpoint's billing unit, when the endpoint reports one. */
  cost?: number;
}

/**
 * A summary request that did not produce a usable summary. The message holds only the
 * status, finish reason and token counts: never newsletter text, never a response body.
 * `retryable` says a later attempt may succeed (the pipeline retries failed summaries on its
 * next run).
 */
export class SummaryError extends Error {
  readonly retryable: boolean;
  readonly finishReason?: string;
  constructor(message: string, options: { retryable: boolean; finishReason?: string }) {
    super(message);
    this.name = "SummaryError";
    this.retryable = options.retryable;
    this.finishReason = options.finishReason;
  }
}
