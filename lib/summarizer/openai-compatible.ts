import { buildSummaryMessages } from "./prompt";
import type { Newsletter, SummaryLength, SummaryProvider } from "./types";

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
}

const MAX_TOKENS: Record<SummaryLength, number> = { headline: 120, brief: 260, deep: 500 };

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

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): SummaryProvider {
  const base = checkBaseUrl(config.baseUrl);
  if (!config.model.trim()) throw new Error("SUMMARY_MODEL is empty");
  const endpoint = `${base.href.replace(/\/+$/, "")}/chat/completions`;
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 60_000;

  return {
    async summarize(newsletter: Newsletter, { length }: { length: SummaryLength }) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      // No tools, ever: the summarizer can only return text (CLAUDE.md).
      const body = {
        model: config.model,
        messages: buildSummaryMessages(newsletter, length),
        temperature: 0,
        max_tokens: MAX_TOKENS[length],
      };
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // Status only: a provider's error body can echo request headers.
        throw new Error(`Summary request failed with HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Summary response had no text");
      }
      return content.trim();
    },
  };
}
