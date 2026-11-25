// The budget for one briefing (GOAL.md Phase 2: "Render cost per briefing logged and within
// budget"; section 6: $0–5 a month for one user). Defaults set provisionally in run 26; see
// PROGRESS.md "Questions for Thalia".
//
// Money. Speech is rendered on the listener's own device (Kokoro in the browser) and the
// clips stay in the browser's Cache Storage, so rendering costs the server nothing: no
// function time, no Supabase Storage, no paid API. The render log rows are about 150 bytes
// each, well inside the free database. The one cost per briefing is the summary model, so
// the money budget per briefing belongs to the summarizer: $0.10, which over 31 days is
// $3.10, leaving about $1.90 of the $5 monthly target for Phase 3's spoken answers.
//
// Device. Rendering costs the listener time and storage instead of money:
//   * real-time factor at most 1.0: the phone renders a minute of audio in at most a
//     minute. Slower than that, rendering ahead falls behind listening.
//   * at most 300 s of rendering per briefing (every render of it summed: a voice change
//     renders it again): /listen renders before Play is offered, so this is the wait.
//   * at most 150 MB of clips per briefing: float32 mono at 24 kHz is 5.76 MB a minute,
//     so about 26 minutes of audio. iOS Safari may evict a site's storage under pressure,
//     and the player also holds the briefing as one 16-bit file in memory.
// The briefing's storage is its largest single render, not the sum: clips of an old voice
// or speed are deleted after each render (lib/briefing/render-ahead.ts, pruneClips).

export const KOKORO_SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 4; // float32, as cacheApiClipStore stores clips

/** The full-briefing size used to project the summarizer's cost: the pipeline's cap. */
export const SUMMARIES_PER_FULL_BRIEFING = 30; // lib/pipeline/run.ts, maxSummariesPerRun

export const RENDER_BUDGET = Object.freeze({
  /** Server money spent on rendering a briefing. Rendering is on the device. */
  serverCostUsd: 0,
  /** Device render seconds per second of newly rendered audio. */
  maxRealTimeFactor: 1,
  /** Device render seconds per briefing, every render of it summed (the wait before Play). */
  maxRenderSeconds: 300,
  /** Device storage for one briefing's clips, bytes (150 MB). */
  maxClipBytes: 150_000_000,
  /** Summary model spend per briefing, US dollars. */
  maxSummaryCostUsd: 0.1,
});

export type BudgetFlag = "real_time_factor" | "render_time" | "storage";

/** One render of a briefing, as the render log stores it. */
export interface BudgetRow {
  deliveryAt: string;
  audioSeconds: number;
  renderedAudioSeconds: number;
  renderSeconds: number;
}

export interface BriefingBudget {
  deliveryAt: string;
  renders: number;
  renderSeconds: number;
  /** Device seconds per second of newly rendered audio over every render (0 if none). */
  realTimeFactor: number;
  clipBytes: number;
  serverCostUsd: number;
  over: BudgetFlag[];
}

/** Bytes the stored clips of this much audio take on the device. */
export function clipBytes(audioSeconds: number, sampleRate = KOKORO_SAMPLE_RATE): number {
  return Math.round(audioSeconds * sampleRate * BYTES_PER_SAMPLE);
}

/** Checks one briefing (every render logged for one delivery) against the budget. */
export function checkBriefingBudget(rows: readonly BudgetRow[]): BriefingBudget {
  if (rows.length === 0) throw new Error("A briefing's budget needs at least one render");
  const deliveryAt = rows[0].deliveryAt;
  if (rows.some((r) => r.deliveryAt !== deliveryAt)) throw new Error("Rows must belong to one briefing");

  const renderSeconds = rows.reduce((n, r) => n + r.renderSeconds, 0);
  const renderedAudio = rows.reduce((n, r) => n + r.renderedAudioSeconds, 0);
  const realTimeFactor = renderedAudio > 0 ? renderSeconds / renderedAudio : 0;
  const bytes = clipBytes(Math.max(...rows.map((r) => r.audioSeconds)));

  const over: BudgetFlag[] = [];
  if (realTimeFactor > RENDER_BUDGET.maxRealTimeFactor) over.push("real_time_factor");
  if (renderSeconds > RENDER_BUDGET.maxRenderSeconds) over.push("render_time");
  if (bytes > RENDER_BUDGET.maxClipBytes) over.push("storage");

  return {
    deliveryAt,
    renders: rows.length,
    renderSeconds,
    realTimeFactor,
    clipBytes: bytes,
    serverCostUsd: RENDER_BUDGET.serverCostUsd,
    over,
  };
}

/** The briefings over budget among these rows, newest delivery first. */
export function flagBriefings(rows: readonly BudgetRow[]): BriefingBudget[] {
  const byDelivery = new Map<string, BudgetRow[]>();
  for (const r of rows) byDelivery.set(r.deliveryAt, [...(byDelivery.get(r.deliveryAt) ?? []), r]);
  return [...byDelivery.keys()]
    .sort((a, b) => b.localeCompare(a))
    .map((d) => checkBriefingBudget(byDelivery.get(d)!))
    .filter((b) => b.over.length > 0);
}

/**
 * The summary model's cost for a full briefing, projected from a measured run (the cost
 * the provider reported for `summaries` summaries). The app does not yet store per-summary
 * usage, so the measured runs are the real-model summary evals (see PROGRESS.md).
 */
export function summaryCostPerBriefing(
  measured: { costUsd: number; summaries: number },
  summariesPerBriefing = SUMMARIES_PER_FULL_BRIEFING,
): number {
  const { costUsd, summaries } = measured;
  if (!(Number.isFinite(costUsd) && costUsd >= 0)) throw new Error("costUsd must be a finite amount, 0 or more");
  if (!(Number.isInteger(summaries) && summaries > 0)) throw new Error("summaries must be a positive whole number");
  if (!(Number.isInteger(summariesPerBriefing) && summariesPerBriefing > 0)) {
    throw new Error("summariesPerBriefing must be a positive whole number");
  }
  return (costUsd / summaries) * summariesPerBriefing;
}
