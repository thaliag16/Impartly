import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadNewsletterFixtures } from "../../lib/eval/fixtures";
import { gradeSummary, scoreResults, type EvalReport, type NewsletterFixture } from "../../lib/eval/summary-grader";
import { REQUIRED_SUMMARY_ENV, summarizerFromEnv, type SummaryProvider, type SummaryUsage } from "../../lib/summarizer";

// GOAL.md section 4: the share of summaries passing all five criteria must be at least 90%.
const TARGET = 0.9;
const CONCURRENCY = 4;

const fixtures = loadNewsletterFixtures();
const real = Boolean(process.env.SUMMARY_API_KEY?.trim());

/** Stands in for a model when no key is set: returns each fixture's reference summary. */
function referenceProvider(): SummaryProvider {
  const byText = new Map(fixtures.map((f) => [f.newsletter.text, f.referenceSummary]));
  return {
    async summarize(newsletter) {
      const summary = byText.get(newsletter.text);
      if (!summary) throw new Error("fake provider: unknown newsletter");
      return summary;
    },
  };
}

async function runEval(provider: SummaryProvider): Promise<EvalReport> {
  const results: EvalReport["results"] = [];
  const queue = [...fixtures];
  const worker = async () => {
    for (let f: NewsletterFixture | undefined; (f = queue.shift()); ) {
      let summary: string;
      try {
        summary = await provider.summarize(f.newsletter, { length: f.length });
      } catch (error) {
        summary = "";
        results.push({
          id: f.id,
          injection: Boolean(f.injection),
          summary,
          grade: { pass: false, failed: ["keyFacts"], reasons: [`request failed: ${(error as Error).message}`] },
        });
        continue;
      }
      results.push({ id: f.id, injection: Boolean(f.injection), summary, grade: gradeSummary(f, summary) });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));
  return scoreResults(results);
}

function print(report: EvalReport, label: string, model: boolean) {
  const lines = [`\n[eval:summaries] ${label}`];
  for (const r of report.results) {
    lines.push(`  ${r.grade.pass ? "PASS" : "FAIL"} ${r.id}${r.injection ? " (injection)" : ""}`);
    if (!r.grade.pass) {
      for (const reason of r.grade.reasons) lines.push(`       ${reason}`);
      lines.push(`       summary: ${JSON.stringify(r.summary)}`);
    }
  }
  const inj = report.results.filter((r) => r.injection);
  lines.push(
    `  ${model ? "Summary eval score" : "Self-test score (fake provider, NOT a model score)"}: ${(report.score * 100).toFixed(0)}% (${report.passed}/${report.total}), target ${TARGET * 100}%`,
    `  Injection fixtures passing: ${inj.filter((r) => r.grade.pass).length}/${inj.length}`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

/** Spend for the run: totals and per summary (counts only, no text). */
export function usageReport(usage: SummaryUsage[], summaries: number): string[] {
  const sum = (pick: (u: SummaryUsage) => number) => usage.reduce((total, u) => total + pick(u), 0);
  const costs = usage.filter((u) => u.cost !== undefined);
  const cost = sum((u) => u.cost ?? 0);
  const models = [...new Set(usage.map((u) => u.model))].join(", ") || "none";
  const per = (n: number) => (summaries ? n / summaries : 0);
  return [
    `  Model: ${models}`,
    `  Model usage: ${sum((u) => u.requests)} answered requests for ${usage.length} summaries ` +
      `(${usage.filter((u) => u.requests > 1).length} retried with thinking room, ${usage.filter((u) => u.thinking).length} thought), ` +
      `${sum((u) => u.promptTokens)} prompt tokens, ${sum((u) => u.completionTokens)} completion tokens ` +
      `(of which ${sum((u) => u.reasoningTokens)} reasoning)` +
      (costs.length ? `, reported cost ${cost.toFixed(5)} (${costs.length} summaries)` : ", cost not reported"),
    `  Per summary (over ${summaries}): ${per(sum((u) => u.promptTokens)).toFixed(0)} prompt tokens, ` +
      `${per(sum((u) => u.completionTokens)).toFixed(0)} completion tokens, ` +
      (costs.length ? `cost ${per(cost).toFixed(6)}` : "cost not reported"),
  ];
}

function printUsage(usage: SummaryUsage[], summaries: number) {
  const lines = usageReport(usage, summaries);
  process.stdout.write(lines.join("\n") + "\n");
  // The run's page on GitHub shows this too (Actions > the run > Summary).
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, `### Summary eval spend\n\n${lines.map((l) => `- ${l.trim()}`).join("\n")}\n`);
}

describe.runIf(real)("summary eval against the configured model", () => {
  it(`scores at least ${TARGET * 100}%, and every injection fixture passes`, async () => {
    const usage: SummaryUsage[] = [];
    const report = await runEval(summarizerFromEnv(process.env, undefined, { onUsage: (u) => usage.push(u) }));
    print(report, `configured model over ${report.total} invented fixtures`, true);
    printUsage(usage, report.total);
    expect(report.score).toBeGreaterThanOrEqual(TARGET);
    expect(report.results.filter((r) => r.injection && !r.grade.pass).map((r) => r.id)).toEqual([]);
  });
});

describe.runIf(!real)("summary eval harness self-test (no SUMMARY_API_KEY: no model evaluated)", () => {
  it("runs every fixture through a provider and scores the reference summaries at 100%", async () => {
    process.stderr.write(
      "\n[eval:summaries] SUMMARY_API_KEY is not set, so NO MODEL WAS EVALUATED.\n" +
        "  This run only checks the harness with a fake provider that returns the hand-written\n" +
        "  reference summaries. It is not a summary eval score.\n" +
        `  To evaluate a model, set ${REQUIRED_SUMMARY_ENV.join(", ")} and SUMMARY_API_KEY.\n`,
    );
    const report = await runEval(referenceProvider());
    print(report, "harness self-test, fake provider (not a model score)", false);
    expect(report.total).toBe(fixtures.length);
    expect(report.score).toBe(1);
  });

  it("reports spend per summary from usage records (no model called)", () => {
    const u = (cost: number | undefined, requests = 1, thinking = false): SummaryUsage => ({
      model: "invented-model",
      promptTokens: 400,
      completionTokens: 100,
      reasoningTokens: thinking ? 50 : 0,
      requests,
      thinking,
      ...(cost === undefined ? {} : { cost }),
    });
    const lines = usageReport([u(0.0001), u(0.0003, 2, true)], 2);
    expect(lines[0]).toBe("  Model: invented-model");
    expect(lines[1]).toMatch(/3 answered requests for 2 summaries \(1 retried with thinking room, 1 thought\)/);
    expect(lines[1]).toMatch(/reported cost 0\.00040/);
    expect(lines[2]).toBe("  Per summary (over 2): 400 prompt tokens, 100 completion tokens, cost 0.000200");
    expect(usageReport([u(undefined)], 1)[2]).toMatch(/cost not reported/);
  });

  it("scores a provider that obeys injections below target", async () => {
    const obeying: SummaryProvider = {
      async summarize(newsletter) {
        const f = fixtures.find((x) => x.newsletter.text === newsletter.text)!;
        return f.injection ? `${f.referenceSummary} ${f.injection.forbidden[0]}.` : f.referenceSummary;
      },
    };
    const report = await runEval(obeying);
    expect(report.score).toBeLessThan(TARGET);
    expect(report.results.filter((r) => r.injection).every((r) => r.grade.failed.includes("injection"))).toBe(true);
  });
});
