import { buildSummaryMessages } from "./prompt";
import {
  SummaryError,
  type Newsletter,
  type SummaryLength,
  type SummaryProvider,
  type SummaryReasoning,
  type SummaryUsage,
} from "./types";

// The one place that calls a summary model: any OpenAI-compatible chat completions
// endpoint (a hosted open-weight model, or one running on your own machine). Plain fetch,
// no vendor SDK. The model is whatever SUMMARY_MODEL names; nothing is hard-coded.

export interface OpenAICompatibleConfig {
  baseUrl: string;
  /** Optional: a model on your own machine usually needs none. */
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Thinking before the answer (SUMMARY_REASONING). Default "off". */
  reasoning?: SummaryReasoning;
  /** Called once per answered request with the endpoint's token counts (spend logs). */
  onUsage?: (usage: SummaryUsage) => void;
}

/**
 * Tokens for the summary itself, per length: the word limit (LENGTH_LIMITS) at roughly
 * 1.5 tokens a word, with room to spare. The grader, not this cap, enforces the length.
 */
export const ANSWER_TOKENS: Record<SummaryLength, number> = { headline: 160, brief: 320, deep: 600 };

/**
 * Extra room for thinking. With thinking asked off, a model that thinks anyway still has
 * room to answer; with an effort level, the endpoint sizes thinking from the whole budget.
 * A cap only: a model that does not think stops at the end of its answer.
 */
export const REASONING_ALLOWANCE: Record<"off" | "on", number> = { off: 1024, on: 4096 };

export function maxTokensFor(length: SummaryLength, reasoning: SummaryReasoning): number {
  return ANSWER_TOKENS[length] + REASONING_ALLOWANCE[reasoning === "off" ? "off" : "on"];
}

/**
 * The request field for a reasoning setting, in the shape OpenAI-compatible routers accept
 * (`reasoning: { enabled | effort }`); `exclude` keeps thinking text out of the reply.
 * "default" sends nothing.
 */
export function reasoningField(reasoning: SummaryReasoning): Record<string, unknown> | undefined {
  if (reasoning === "default") return undefined;
  if (reasoning === "off") return { enabled: false };
  return { effort: reasoning, exclude: true };
}

/** https anywhere; plain http only to this machine (for a local model server). */
export function checkBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SUMMARY_BASE_URL is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("SUMMARY_BASE_URL must use https (plain http is allowed only for localhost)");
  }
  if (url.username || url.password) throw new Error("SUMMARY_BASE_URL must not contain credentials");
  return url;
}

/** Thinking some models write inline before the answer, closed or cut off. */
const INLINE_THINKING = /<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * The answer text of a chat completions message. `content` may be a string or a list of
 * parts; only text parts count. Thinking never counts: not the separate `reasoning` /
 * `reasoning_content` fields, not thinking parts, not inline <think> blocks.
 */
export function answerText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (part): part is { type?: unknown; text: string } =>
          typeof part === "object" &&
          part !== null &&
          typeof (part as { text?: unknown }).text === "string" &&
          ["text", "output_text", undefined].includes((part as { type?: string }).type),
      )
      .map((part) => part.text)
      .join("");
  }
  return text.replace(INLINE_THINKING, "").trim();
}

interface ChatCompletion {
  choices?: { finish_reason?: unknown; message?: Record<string, unknown> }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function usageOf(data: ChatCompletion): SummaryUsage {
  const u = data.usage ?? {};
  const usage: SummaryUsage = {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
  };
  if (typeof u.cost === "number" && Number.isFinite(u.cost)) usage.cost = u.cost;
  return usage;
}

/** Status, finish reason and counts only: what a log may hold (no text of any kind). */
function describe(finishReason: string, usage: SummaryUsage, thinkingReturned: boolean): string {
  return [
    `finish_reason=${finishReason}`,
    `completion_tokens=${usage.completionTokens}`,
    `reasoning_tokens=${usage.reasoningTokens}`,
    `thinking_returned=${thinkingReturned ? "yes" : "no"}`,
  ].join(", ");
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): SummaryProvider {
  const base = checkBaseUrl(config.baseUrl);
  if (!config.model.trim()) throw new Error("SUMMARY_MODEL is empty");
  const endpoint = `${base.href.replace(/\/+$/, "")}/chat/completions`;
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const reasoning = config.reasoning ?? "off";

  async function post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    return doFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async summarize(newsletter: Newsletter, { length }: { length: SummaryLength }) {
      // No tools, ever: the summarizer can only return text (CLAUDE.md).
      const body: Record<string, unknown> = {
        model: config.model,
        messages: buildSummaryMessages(newsletter, length),
        temperature: 0,
        max_tokens: maxTokensFor(length, reasoning),
      };
      const field = reasoningField(reasoning);
      if (field) body.reasoning = field;

      let response = await post(body);
      if (response.status === 400 && field) {
        // An endpoint that does not know the reasoning field (or a model that cannot turn
        // thinking off) may reject it: try once more without it.
        delete body.reasoning;
        response = await post(body);
      }
      if (!response.ok) {
        // Status only: a provider's error body can echo request headers.
        throw new SummaryError(`Summary request failed with HTTP ${response.status}`, {
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }

      const data = (await response.json()) as ChatCompletion;
      const choice = data.choices?.[0];
      const usage = usageOf(data);
      config.onUsage?.(usage);
      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "none";
      const message = choice?.message;
      const thinkingReturned = Boolean(
        message &&
          (message.reasoning || message.reasoning_content || message.reasoning_details ||
            (typeof message.content === "string" && /<(think|thinking|reasoning)>/i.test(message.content))),
      );

      const text = answerText(message);
      if (!text) {
        throw new SummaryError(`Summary response had no text (${describe(finishReason, usage, thinkingReturned)})`, {
          retryable: true,
          finishReason,
        });
      }
      if (finishReason === "length") {
        throw new SummaryError(`Summary was cut off at the token limit (${describe(finishReason, usage, thinkingReturned)})`, {
          retryable: true,
          finishReason,
        });
      }
      return text;
    },
  };
}
