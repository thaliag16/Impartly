import { buildSummaryMessages } from "./prompt";
import {
  SummaryError,
  type SummarizeOptions,
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
 * With thinking off this is the whole first request's cap (cost: see summarize below).
 */
export const ANSWER_TOKENS: Record<SummaryLength, number> = { headline: 160, brief: 320, deep: 600 };

/**
 * Extra room for thinking. With an effort level, the endpoint sizes thinking from the whole
 * budget. With thinking asked off it is not reserved up front: a request cut off at
 * ANSWER_TOKENS is retried once with it (eval run 22 saw some requests think about 1,000
 * tokens with thinking off), and once a model has thought, the rest of the run gets it at
 * once. A cap only: a model that does not think stops at the end of its answer.
 */
export const REASONING_ALLOWANCE: Record<"off" | "on", number> = { off: 3072, on: 4096 };

export function maxTokensFor(length: SummaryLength, reasoning: SummaryReasoning): number {
  return ANSWER_TOKENS[length] + REASONING_ALLOWANCE[reasoning === "off" ? "off" : "on"];
}

/**
 * The request field for a reasoning setting, in the shape OpenAI-compatible routers accept
 * (`reasoning: { effort | enabled }`); `exclude` keeps thinking text out of the reply.
 * "off" sends effort "none", which OpenRouter documents as disabling reasoning entirely;
 * REASONING_OFF_FALLBACKS lists what is tried when an endpoint rejects it. "default" sends
 * nothing.
 */
export function reasoningField(reasoning: SummaryReasoning): Record<string, unknown> | undefined {
  if (reasoning === "default") return undefined;
  if (reasoning === "off") return { effort: "none" };
  return { effort: reasoning, exclude: true };
}

/** For "off", in order, after an HTTP 400: the older switch, then no field at all. */
export const REASONING_OFF_FALLBACKS: readonly (Record<string, unknown> | undefined)[] = [{ enabled: false }, undefined];

/**
 * OpenRouter's provider routing (its documented `provider` object): `require_parameters`
 * sends the request only to providers that honour every parameter in it, so a provider
 * that would ignore "thinking off" (and bill thinking anyway) is never chosen; `sort:
 * "price"` tries the cheapest of those first. Sent to openrouter.ai only: other endpoints
 * may reject an unknown field.
 */
export function isOpenRouter(base: URL): boolean {
  return base.hostname === "openrouter.ai" || base.hostname.endsWith(".openrouter.ai");
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

interface RequestUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cost?: number;
}

function usageOf(data: ChatCompletion): RequestUsage {
  const u = data.usage ?? {};
  const usage: RequestUsage = {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
  };
  if (typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0) usage.cost = u.cost;
  return usage;
}

/** Status, finish reason and counts only: what a log may hold (no text of any kind). */
function describe(finishReason: string, usage: RequestUsage, thinkingReturned: boolean): string {
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

  // The request variants, best first; on a rejection (see `rejected`) the next is tried,
  // and the one that worked is kept for the rest of this provider's life (one pipeline or
  // eval run), so a rejected setting is not sent again. Rejected requests are not billed.
  type Variant = { reasoning?: Record<string, unknown>; provider?: Record<string, unknown> };
  const reasoningChoices =
    reasoning === "off" ? [reasoningField("off"), ...REASONING_OFF_FALLBACKS] : [reasoningField(reasoning)];
  const variants: Variant[] = [];
  if (isOpenRouter(base)) {
    // Thinking off: effort "none", then enabled false, on providers that honour them; only
    // then any provider (enabled false, then nothing), as before this routing existed.
    const strict = reasoning === "off" ? reasoningChoices.slice(0, 2) : reasoningChoices;
    const loose = reasoning === "off" ? reasoningChoices.slice(1) : reasoningChoices;
    for (const r of strict) variants.push({ reasoning: r, provider: { require_parameters: true, sort: "price" } });
    for (const r of loose) variants.push({ reasoning: r, provider: { sort: "price" } });
  } else {
    for (const r of reasoningChoices) variants.push({ reasoning: r });
  }
  let variantIndex = 0;
  // A 404 means "no provider honours every parameter" only on a router asked to require
  // them; elsewhere it is a wrong URL.
  const rejected = (status: number, v: Variant) =>
    status === 400 || (status === 404 && v.provider?.require_parameters === true);

  // Thinking room: reserved up front only with an effort level, or once thinking appeared.
  let thinkingSeen = reasoning !== "off";
  let warned = false;

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

  /**
   * One request, falling back through the variants while the endpoint rejects them. The
   * variant that answered is kept; when every variant is rejected (a request that is bad
   * for another reason, such as one too long) nothing is kept, so one bad request never
   * leaves the rest of the run without "thinking off".
   */
  async function request(messages: unknown, maxTokens: number): Promise<ChatCompletion> {
    for (let i = variantIndex; ; i++) {
      const v = variants[i];
      // No tools, ever: the summarizer can only return text (CLAUDE.md).
      const body: Record<string, unknown> = { model: config.model, messages, temperature: 0, max_tokens: maxTokens };
      if (v.reasoning) body.reasoning = v.reasoning;
      if (v.provider) body.provider = v.provider;
      const response = await post(body);
      if (!response.ok && rejected(response.status, v) && i + 1 < variants.length) continue;
      if (!response.ok) {
        // Status only: a provider's error body can echo request headers.
        throw new SummaryError(`Summary request failed with HTTP ${response.status}`, {
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      variantIndex = i;
      return (await response.json()) as ChatCompletion;
    }
  }

  return {
    async summarize(newsletter: Newsletter, { length, onUsage }: SummarizeOptions) {
      const messages = buildSummaryMessages(newsletter, length);
      const total: SummaryUsage = { model: config.model, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, requests: 0, thinking: false };
      const report = () => {
        if (total.requests === 0) return;
        config.onUsage?.({ ...total });
        onUsage?.({ ...total });
      };
      let roomy = thinkingSeen;
      try {
        for (;;) {
          const data = await request(messages, roomy ? maxTokensFor(length, reasoning) : ANSWER_TOKENS[length]);
          const choice = data.choices?.[0];
          const usage = usageOf(data);
          const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "none";
          const message = choice?.message;
          const thinkingReturned = Boolean(
            message &&
              (message.reasoning || message.reasoning_content || message.reasoning_details ||
                (typeof message.content === "string" && /<(think|thinking|reasoning)>/i.test(message.content))),
          );
          total.requests++;
          total.promptTokens += usage.promptTokens;
          total.completionTokens += usage.completionTokens;
          total.reasoningTokens += usage.reasoningTokens;
          if (usage.cost !== undefined) total.cost = (total.cost ?? 0) + usage.cost;
          const thought = usage.reasoningTokens > 0 || thinkingReturned;
          if (thought) total.thinking = true;
          if (thought && reasoning === "off") {
            thinkingSeen = true;
            if (!warned) {
              warned = true;
              // Counts only. The model (or the provider serving it) ignored "thinking off":
              // thinking is billed as output, so this run costs more than it should.
              console.warn(`[summarizer] the model is thinking although SUMMARY_REASONING is off (${describe(finishReason, usage, thinkingReturned)})`);
            }
          }
          const text = answerText(message);
          if (finishReason === "length" && !roomy) {
            // Cut off at the tight cap: once more with room for thinking.
            roomy = true;
            continue;
          }
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
        }
      } finally {
        report();
      }
    },
  };
}
