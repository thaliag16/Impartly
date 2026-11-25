import { describe, expect, it } from "vitest";
import {
  KOKORO_SAMPLE_RATE,
  RENDER_BUDGET,
  checkBriefingBudget,
  clipBytes,
  flagBriefings,
  summaryCostPerBriefing,
  type BudgetRow,
} from "./render-budget";

const DELIVERY = "2026-11-24T15:00:00.000Z";

const row = (over: Partial<BudgetRow> = {}): BudgetRow => ({
  deliveryAt: DELIVERY,
  audioSeconds: 180,
  renderedAudioSeconds: 180,
  renderSeconds: 90,
  ...over,
});

describe("render budget (GOAL.md section 6)", () => {
  it("rendering costs the server nothing: the money budget for rendering is $0", () => {
    expect(RENDER_BUDGET.serverCostUsd).toBe(0);
    expect(checkBriefingBudget([row()]).serverCostUsd).toBe(0);
  });

  it("the summarizer's share of $5 a month leaves room for Phase 3 answers", () => {
    // 31 briefings a month at the per-briefing limit stay under the $5 monthly target.
    expect(RENDER_BUDGET.maxSummaryCostUsd * 31).toBeLessThan(5);
    expect(RENDER_BUDGET.maxSummaryCostUsd).toBeGreaterThan(0);
  });

  it("stored clips are float32 mono at Kokoro's 24 kHz: 96,000 bytes per second", () => {
    expect(KOKORO_SAMPLE_RATE).toBe(24_000);
    expect(clipBytes(1)).toBe(96_000);
    expect(clipBytes(60)).toBe(5_760_000);
    // The storage limit is about 26 minutes of audio.
    expect(RENDER_BUDGET.maxClipBytes / clipBytes(60)).toBeCloseTo(26.04, 1);
  });

  it("a typical briefing is within budget", () => {
    const b = checkBriefingBudget([row()]);
    expect(b).toMatchObject({ deliveryAt: DELIVERY, renders: 1, renderSeconds: 90, realTimeFactor: 0.5, over: [] });
    expect(b.clipBytes).toBe(clipBytes(180));
  });

  it("flags a device rendering slower than real time", () => {
    expect(checkBriefingBudget([row({ renderSeconds: 180 })]).over).toEqual([]); // exactly 1.0x
    expect(checkBriefingBudget([row({ renderSeconds: 181 })]).over).toEqual(["real_time_factor"]);
  });

  it("flags a wait over the render-time limit, summed over every render of the briefing", () => {
    const long = { audioSeconds: 1200, renderedAudioSeconds: 600 };
    expect(checkBriefingBudget([row({ ...long, renderSeconds: 150 }), row({ ...long, renderSeconds: 150 })]).over).toEqual([]);
    const b = checkBriefingBudget([row({ ...long, renderSeconds: 150 }), row({ ...long, renderSeconds: 151 })]);
    expect(b.renderSeconds).toBe(301);
    expect(b.renders).toBe(2);
    expect(b.over).toEqual(["render_time"]);
  });

  it("flags a briefing whose clips would take more than the storage limit", () => {
    const limitSeconds = RENDER_BUDGET.maxClipBytes / clipBytes(1);
    expect(checkBriefingBudget([row({ audioSeconds: limitSeconds, renderedAudioSeconds: 600, renderSeconds: 60 })]).over).toEqual([]);
    expect(
      checkBriefingBudget([row({ audioSeconds: limitSeconds + 1, renderedAudioSeconds: 600, renderSeconds: 60 })]).over,
    ).toEqual(["storage"]);
  });

  it("storage is the largest single render, not the sum (old voices' clips are pruned)", () => {
    const b = checkBriefingBudget([row({ audioSeconds: 900 }), row({ audioSeconds: 1000 })]);
    expect(b.clipBytes).toBe(clipBytes(1000));
  });

  it("the real-time factor is device time over newly rendered audio only (cached clips are free)", () => {
    const b = checkBriefingBudget([row({ audioSeconds: 600, renderedAudioSeconds: 60, renderSeconds: 30 })]);
    expect(b.realTimeFactor).toBe(0.5);
  });

  it("can report every flag at once", () => {
    const b = checkBriefingBudget([row({ audioSeconds: 2000, renderedAudioSeconds: 200, renderSeconds: 400 })]);
    expect(b.over).toEqual(["real_time_factor", "render_time", "storage"]);
  });

  it("refuses an empty list or rows of more than one briefing", () => {
    expect(() => checkBriefingBudget([])).toThrow(/at least one/);
    expect(() => checkBriefingBudget([row(), row({ deliveryAt: "2026-11-25T15:00:00.000Z" })])).toThrow(/one briefing/);
  });

  it("flagBriefings groups by delivery and lists only those over budget, newest first", () => {
    const rows = [
      row({ deliveryAt: "2026-11-22T15:00:00.000Z", renderSeconds: 400, audioSeconds: 600, renderedAudioSeconds: 600 }),
      row({ deliveryAt: "2026-11-23T15:00:00.000Z" }),
      row({ deliveryAt: "2026-11-24T15:00:00.000Z", renderSeconds: 200 }),
    ];
    expect(flagBriefings(rows).map((b) => [b.deliveryAt, b.over])).toEqual([
      ["2026-11-24T15:00:00.000Z", ["real_time_factor"]],
      ["2026-11-22T15:00:00.000Z", ["render_time"]],
    ]);
    expect(flagBriefings([row()])).toEqual([]);
  });

  describe("summarizer cost per briefing", () => {
    // Measured, not invented: the real-model summary eval runs logged in PROGRESS.md
    // ("Summary eval history"), 20 summaries each, cost as the provider reported it.
    const EVAL_RUNS_USD = [0.00654, 0.00274, 0.00278, 0.01443, 0.0025];

    it("projects the cost of a full briefing (30 summaries, the pipeline's cap) from a measured run", () => {
      expect(summaryCostPerBriefing({ costUsd: 0.01, summaries: 20 })).toBeCloseTo(0.015, 6);
      expect(summaryCostPerBriefing({ costUsd: 0.01, summaries: 20 }, 10)).toBeCloseTo(0.005, 6);
    });

    it("every measured eval run, scaled to a full briefing, is within the per-briefing budget", () => {
      for (const costUsd of EVAL_RUNS_USD) {
        expect(summaryCostPerBriefing({ costUsd, summaries: 20 })).toBeLessThanOrEqual(RENDER_BUDGET.maxSummaryCostUsd);
      }
      // The worst one (thinking came back on) is about 2 cents.
      expect(summaryCostPerBriefing({ costUsd: Math.max(...EVAL_RUNS_USD), summaries: 20 })).toBeCloseTo(0.0216, 3);
    });

    it("refuses nonsense input", () => {
      expect(() => summaryCostPerBriefing({ costUsd: -1, summaries: 20 })).toThrow();
      expect(() => summaryCostPerBriefing({ costUsd: 0.01, summaries: 0 })).toThrow();
      expect(() => summaryCostPerBriefing({ costUsd: Number.NaN, summaries: 20 })).toThrow();
    });
  });
});
