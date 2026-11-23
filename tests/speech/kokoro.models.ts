// Phase 0 gate: "Kokoro renders a 60-second sample in both voices (bm_daniel, af_heart)
// with no cut-off text; an automated test compares output duration to expected duration."
//
// Runs the app's own render path (lib/speech: splitSentences + renderBySentence) on the
// pinned, SHA-256-verified model files in models/. Nothing is downloaded here and remote
// loading is switched off, so only verified files can be loaded.
//
//   npm run fetch:models && npm run test:models
//
// Locally, without verified model files, the suite is skipped with a message. In CI
// (CI=true) or with REQUIRE_MODELS=1, missing or unverified files fail it.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { beforeAll, describe, expect, it } from "vitest";
import { MODELS_DIR, readPins, verifyModel } from "../../scripts/fetch-models.mjs";
import { NOMINAL_WORDS_PER_MINUTE, countWords, expectedSeconds, speechSpan } from "../../lib/speech/audio-checks";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID, renderBySentence, type RenderedSentence } from "../../lib/speech/kokoro";
import { splitSentences } from "../../lib/speech/sentences";
import { PASSAGE } from "./passage";

const VOICES = ["af_heart", "bm_daniel"] as const;

/** Total duration may differ from words-per-minute expectation by this share. */
const DURATION_TOLERANCE = 0.25;
/** Silence allowed before the first and after the last speech in a sentence chunk. */
const MAX_EDGE_SILENCE_SECONDS = 0.75;
/** A chunk whose speech stops early (text dropped, silence padded) fails this. */
const MIN_SPEECH_IN_LAST_QUARTER = 0.25;
/** Each chunk's seconds per letter must be within this factor of the median chunk's. */
const PACE_FACTOR = 2;

const { kokoro: pins } = await readPins();
const verified = await verifyModel(pins, MODELS_DIR);
const required = process.env.CI === "true" || process.env.REQUIRE_MODELS === "1";
// The skip message is printed by tests/speech/global-setup.ts (output from a skipped
// file is swallowed by Vitest).

const letters = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
const seconds = (chunks: RenderedSentence[]) =>
  chunks.reduce((sum, chunk) => sum + chunk.audio.length / chunk.sampleRate, 0);

describe.skipIf(!verified.ok && !required)("Kokoro renders a 60-second sample without cutting off text", () => {
  let tts: KokoroTTS;
  const expected = expectedSeconds(PASSAGE);

  beforeAll(async () => {
    if (!verified.ok) throw new Error(`Kokoro model files not verified:\n  ${verified.problems.join("\n  ")}`);
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${MODELS_DIR}/`;
    tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: KOKORO_CPU_DTYPE, device: "cpu" });
  });

  it("uses a passage of about 60 seconds", () => {
    expect(countWords(PASSAGE)).toBe(165);
    expect(expected).toBeCloseTo(60, 0);
  });

  for (const voice of VOICES) {
    it(`${voice}: duration matches the text and every sentence is spoken to the end`, async () => {
      const sentences = splitSentences(PASSAGE);
      const chunks: RenderedSentence[] = [];
      for await (const chunk of renderBySentence(tts, PASSAGE, voice)) chunks.push(chunk);

      // Every sentence rendered, in order, ending with the passage's last words.
      expect(chunks.map((chunk) => chunk.text)).toEqual(sentences);
      expect(chunks.at(-1)?.text.endsWith("bright green kites over the river.")).toBe(true);

      const spans = chunks.map((chunk) => speechSpan(chunk.audio, chunk.sampleRate));
      const paces = chunks.map((chunk, i) => (spans[i].end - spans[i].start) / letters(chunk.text));
      const medianPace = [...paces].sort((a, b) => a - b)[Math.floor(paces.length / 2)];
      const total = seconds(chunks);

      const rows = chunks.map((chunk, i) => ({
        chunk: i + 1,
        words: countWords(chunk.text),
        seconds: Number(spans[i].total.toFixed(2)),
        lead: Number(spans[i].leadingSilence.toFixed(2)),
        tail: Number(spans[i].trailingSilence.toFixed(2)),
        lastQuarter: Number(spans[i].speechInLastQuarter.toFixed(2)),
        pace: Number((paces[i] / medianPace).toFixed(2)),
      }));
      console.log(
        `\n${voice}: ${total.toFixed(1)}s rendered, ${expected.toFixed(1)}s expected at ` +
          `${NOMINAL_WORDS_PER_MINUTE} wpm (${((total / expected - 1) * 100).toFixed(1)}%), ` +
          `${((countWords(PASSAGE) / total) * 60).toFixed(0)} wpm actual`,
      );
      console.table(rows);

      for (const chunk of chunks) expect(chunk.sampleRate).toBe(24000);
      expect(Math.abs(total - expected) / expected, "total duration vs expected").toBeLessThanOrEqual(DURATION_TOLERANCE);
      spans.forEach((span, i) => {
        const label = `chunk ${i + 1}: "${chunks[i].text}"`;
        expect(span.end, `${label} has speech`).toBeGreaterThan(0);
        expect(span.leadingSilence, `${label} leading silence`).toBeLessThanOrEqual(MAX_EDGE_SILENCE_SECONDS);
        expect(span.trailingSilence, `${label} trailing silence`).toBeLessThanOrEqual(MAX_EDGE_SILENCE_SECONDS);
        expect(span.speechInLastQuarter, `${label} speech in its last quarter`).toBeGreaterThanOrEqual(MIN_SPEECH_IN_LAST_QUARTER);
        expect(paces[i] / medianPace, `${label} pace vs median`).toBeLessThanOrEqual(PACE_FACTOR);
        expect(paces[i] / medianPace, `${label} pace vs median`).toBeGreaterThanOrEqual(1 / PACE_FACTOR);
      });
    });
  }

  // Control: proves the duration check catches a real cut-off. One generate() call on
  // the whole passage (what the speech-test route used to do) is truncated by Kokoro's
  // 512-token limit, so it must come out far short of the expected duration.
  it("control: rendering the whole passage in one call is cut off, and the check catches it", async () => {
    const whole = await tts.generate(PASSAGE, { voice: "af_heart" });
    const total = whole.audio.length / whole.sampling_rate;
    console.log(`\ncontrol (one call, af_heart): ${total.toFixed(1)}s vs ${expected.toFixed(1)}s expected`);
    expect(Math.abs(total - expected) / expected).toBeGreaterThan(DURATION_TOLERANCE);
  });
});
