// Phase 2: the briefing's render path on the real model. Two sentences go through
// render-ahead, the shared worker renderer (lib/briefing/worker-renderer.ts) and the
// worker's own logic (lib/briefing/worker-core.ts), with Kokoro on the pinned,
// SHA-256-verified files in models/.
//
// Node has no browser Worker, so the page and worker sides are joined in one process by
// lib/briefing/in-process-worker.ts (messages cross by structuredClone with transfer lists,
// on a later task, as with a real worker). Kokoro runs on onnxruntime-node here; the
// browser's ONNX Runtime files are checked against the same model in ort-runtime.models.ts.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { beforeAll, describe, expect, it } from "vitest";
import { MODELS_DIR, readPins, verifyModel } from "../../scripts/fetch-models.mjs";
import { inProcessWorker } from "../../lib/briefing/in-process-worker";
import { clipKey, memoryClipStore, renderAhead } from "../../lib/briefing/render-ahead";
import type { BriefingScript } from "../../lib/briefing/script";
import { createWorkerRenderer, type RendererEvent } from "../../lib/briefing/worker-renderer";
import { speechSpan } from "../../lib/speech/audio-checks";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID } from "../../lib/speech/kokoro";

const { kokoro: pins } = await readPins();
const verified = await verifyModel(pins, MODELS_DIR);
const required = process.env.CI === "true" || process.env.REQUIRE_MODELS === "1";

const SENTENCES = [
  "Larkspur Robotics raised forty million dollars in a round led by Fernhill Capital.",
  "The company plans to double its engineering team next year.",
];
const SCRIPT: BriefingScript = {
  sentences: SENTENCES.map((text, index) => ({ index, kind: "summary", text, section: null, itemId: null })),
  sections: [],
  storyCount: 1,
};

describe.skipIf(!verified.ok && !required)("Kokoro renders through the shared worker renderer", () => {
  beforeAll(() => {
    if (!verified.ok) throw new Error(`Kokoro model files not verified:\n  ${verified.problems.join("\n  ")}`);
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${MODELS_DIR}/`;
  });

  it("renders 2 sentences with the chosen voice and speed, then serves them from the store", async () => {
    let loads = 0;
    const events: RendererEvent[] = [];
    const renderer = createWorkerRenderer({
      onEvent: (event) => events.push(event),
      createWorker: () =>
        inProcessWorker({
          loadModel: async ({ onPercent }) => {
            loads++;
            return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
              dtype: KOKORO_CPU_DTYPE,
              device: "cpu",
              progress_callback: (info) => {
                if (info.status === "progress") onPercent(info.progress);
              },
            });
          },
        }),
    });
    const store = memoryClipStore();
    const options = { voice: "bm_daniel" as const, speed: 1.1, store, render: renderer.render, subtle: crypto.subtle };

    const first = await renderAhead(SCRIPT, options);
    console.log(
      `\nworker renderer (Node): ${first.audioSeconds.toFixed(2)}s of audio in ${first.renderSeconds.toFixed(2)}s, ` +
        `real-time factor ${first.realTimeFactor.toFixed(2)}`,
    );
    expect(first).toMatchObject({ sentences: 2, rendered: 2, cached: 0 });
    expect(first.audioSeconds).toBeGreaterThan(3);
    expect(first.audioSeconds).toBeLessThan(15);
    expect(events.filter((e) => e.type === "ready")).toHaveLength(1);
    expect(events.filter((e) => e.type === "rendered")).toHaveLength(2);

    // Each clip is real speech, spoken to the end.
    for (const text of SENTENCES) {
      const clip = await store.get(await clipKey(crypto.subtle, text, "bm_daniel", 1.1));
      expect(clip, text).toBeTruthy();
      expect(clip!.sampleRate).toBe(24000);
      const span = speechSpan(clip!.samples, clip!.sampleRate);
      expect(span.end - span.start, text).toBeGreaterThan(1);
      expect(span.trailingSilence, text).toBeLessThanOrEqual(0.75);
    }

    const second = await renderAhead(SCRIPT, options);
    expect(second).toMatchObject({ rendered: 0, cached: 2 });
    expect(loads).toBe(1);
    renderer.dispose();
  });
});
