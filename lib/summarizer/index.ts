import { createOpenAICompatibleProvider } from "./openai-compatible";
import type { SummaryProvider } from "./types";

export * from "./types";

type Env = Record<string, string | undefined>;

/** Names a real summarizer needs; SUMMARY_API_KEY is optional for a local model. */
export const REQUIRED_SUMMARY_ENV = ["SUMMARY_BASE_URL", "SUMMARY_MODEL"] as const;

export function missingSummaryEnv(env: Env = process.env): string[] {
  return REQUIRED_SUMMARY_ENV.filter((name) => !env[name]?.trim());
}

/** The configured summarizer, from SUMMARY_BASE_URL, SUMMARY_MODEL and SUMMARY_API_KEY. */
export function summarizerFromEnv(env: Env = process.env, fetchImpl?: typeof fetch): SummaryProvider {
  const missing = missingSummaryEnv(env);
  if (missing.length) throw new Error(`Summarizer not configured: set ${missing.join(", ")}`);
  return createOpenAICompatibleProvider({
    baseUrl: env.SUMMARY_BASE_URL!.trim(),
    model: env.SUMMARY_MODEL!.trim(),
    apiKey: env.SUMMARY_API_KEY?.trim() || undefined,
    fetch: fetchImpl,
  });
}
