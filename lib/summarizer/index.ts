import { createOpenAICompatibleProvider } from "./openai-compatible";
import { SUMMARY_REASONING_SETTINGS, type SummaryProvider, type SummaryReasoning, type SummaryUsage } from "./types";

export * from "./types";

type Env = Record<string, string | undefined>;

/** Names a real summarizer needs; SUMMARY_API_KEY is optional for a local model. */
export const REQUIRED_SUMMARY_ENV = ["SUMMARY_BASE_URL", "SUMMARY_MODEL"] as const;

export function missingSummaryEnv(env: Env = process.env): string[] {
  return REQUIRED_SUMMARY_ENV.filter((name) => !env[name]?.trim());
}

/** SUMMARY_REASONING: unset or empty means "off" (summaries need no thinking). */
export function reasoningFromEnv(env: Env = process.env): SummaryReasoning {
  const raw = env.SUMMARY_REASONING?.trim().toLowerCase() || "off";
  if (!(SUMMARY_REASONING_SETTINGS as readonly string[]).includes(raw)) {
    throw new Error(`SUMMARY_REASONING must be one of ${SUMMARY_REASONING_SETTINGS.join(", ")}`);
  }
  return raw as SummaryReasoning;
}

/**
 * The configured summarizer, from SUMMARY_BASE_URL, SUMMARY_MODEL, SUMMARY_API_KEY and
 * SUMMARY_REASONING.
 * `timeoutMs` caps each call (the scheduled pull passes a shorter one to fit its budget).
 */
export function summarizerFromEnv(
  env: Env = process.env,
  fetchImpl?: typeof fetch,
  options: { timeoutMs?: number; onUsage?: (usage: SummaryUsage) => void } = {},
): SummaryProvider {
  const missing = missingSummaryEnv(env);
  if (missing.length) throw new Error(`Summarizer not configured: set ${missing.join(", ")}`);
  return createOpenAICompatibleProvider({
    baseUrl: env.SUMMARY_BASE_URL!.trim(),
    model: env.SUMMARY_MODEL!.trim(),
    apiKey: env.SUMMARY_API_KEY?.trim() || undefined,
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs,
    reasoning: reasoningFromEnv(env),
    onUsage: options.onUsage,
  });
}
