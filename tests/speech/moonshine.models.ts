// Phase 0 gate: "Moonshine transcribes three recorded fixture clips with word error rate
// under 15%."
//
// SYNTHETIC STAND-IN: no human recordings exist yet, and real inbox data is not allowed
// (SECURITY.md), so the three clips are invented questions (tests/speech/questions.ts)
// rendered at test time by Kokoro in both voices, one at a faster speed and one with
// light background noise. They are passed through the app's own speech-in path
// (lib/speech/moonshine.ts, behind the SpeechToText interface) and scored with
// lib/speech/wer.ts.
//
// Real recordings: put `<name>.wav` (16-bit PCM WAV, mono or stereo, any sample rate)
// with `<name>.txt` (exactly what was said) in tests/speech/fixtures/clips/. Each pair is
// tested here with the same 15% limit. They are committed to a public repository.
//
// Runs on the pinned, SHA-256-verified model files in models/ with remote loading off.
//   npm run fetch:models && npm run test:models
// Locally, without verified files, the suite is skipped; with CI=true or
// REQUIRE_MODELS=1 it fails instead.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODELS_DIR, readPins, verifyModel } from "../../scripts/fetch-models.mjs";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID, renderBySentence } from "../../lib/speech/kokoro";
import { loadMoonshine } from "../../lib/speech/moonshine";
import { addNoise } from "../../lib/speech/noise";
import type { SpeechToText } from "../../lib/speech/speech-to-text";
import { decodeWav } from "../../lib/speech/wav";
import { normalizeTranscript, wordErrorRate } from "../../lib/speech/wer";
import { MAX_WORD_ERROR_RATE, QUESTION_CLIPS } from "./questions";

const CLIPS_DIR = fileURLToPath(new URL("./fixtures/clips/", import.meta.url));

const pins = await readPins();
const checks = await Promise.all([verifyModel(pins.kokoro, MODELS_DIR), verifyModel(pins.moonshine, MODELS_DIR)]);
const verified = checks.every((check) => check.ok);
const required = process.env.CI === "true" || process.env.REQUIRE_MODELS === "1";

/** Real recordings, if any have been added: `<name>.wav` with `<name>.txt`. */
const recorded = await readdir(CLIPS_DIR).then(
  (names) => names.filter((name) => name.endsWith(".wav")).map((name) => name.slice(0, -4)).sort(),
  () => [] as string[],
);

describe.skipIf(!verified && !required)("Moonshine transcribes spoken questions with WER under 15%", () => {
  let tts: KokoroTTS;
  let stt: SpeechToText;
  const transcripts = new Map<string, string>();

  beforeAll(async () => {
    if (!verified) {
      throw new Error(`model files not verified:\n  ${checks.flatMap((check) => check.problems).join("\n  ")}`);
    }
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${MODELS_DIR}/`;
    tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: KOKORO_CPU_DTYPE, device: "cpu" });
    stt = await loadMoonshine({ device: "cpu" });
  });

  afterAll(async () => {
    await stt?.dispose();
  });

  for (const [index, clip] of QUESTION_CLIPS.entries()) {
    const label = `${clip.id} (synthetic: ${clip.voice}, speed ${clip.speed}${clip.noiseSnrDb ? `, noise ${clip.noiseSnrDb} dB SNR` : ""})`;
    it(label, async () => {
      const parts: Float32Array[] = [];
      let sampleRate = 24000;
      for await (const chunk of renderBySentence(tts, clip.text, clip.voice, clip.speed)) {
        parts.push(chunk.audio);
        sampleRate = chunk.sampleRate;
      }
      let audio: Float32Array = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      parts.reduce((offset, part) => (audio.set(part, offset), offset + part.length), 0);
      if (clip.noiseSnrDb !== undefined) audio = addNoise(audio, clip.noiseSnrDb, index + 1);

      const transcript = await stt.transcribe(audio, sampleRate);
      transcripts.set(clip.id, transcript);
      const wer = wordErrorRate(clip.text, transcript);
      console.log(
        `\n${label}: ${(audio.length / sampleRate).toFixed(1)}s audio, WER ${(wer * 100).toFixed(1)}%\n` +
          `  said:  ${normalizeTranscript(clip.text).join(" ")}\n` +
          `  heard: ${normalizeTranscript(transcript).join(" ")}`,
      );
      expect(wer, `WER for ${clip.id}`).toBeLessThan(MAX_WORD_ERROR_RATE);
    });
  }

  // Control: the score is not trivially low. One clip's transcript scored against another
  // clip's text must fail badly.
  it("control: a transcript scored against the wrong question fails", () => {
    const [first, second] = QUESTION_CLIPS;
    const transcript = transcripts.get(first.id);
    expect(transcript, "first clip was transcribed").toBeTruthy();
    expect(wordErrorRate(second.text, transcript!)).toBeGreaterThan(0.5);
  });

  for (const name of recorded) {
    it(`recorded clip ${name}`, async () => {
      const reference = (await readFile(join(CLIPS_DIR, `${name}.txt`), "utf8")).trim();
      const bytes = await readFile(join(CLIPS_DIR, `${name}.wav`));
      const { samples, sampleRate } = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const transcript = await stt.transcribe(samples, sampleRate);
      const wer = wordErrorRate(reference, transcript);
      console.log(`\nrecorded ${name}: WER ${(wer * 100).toFixed(1)}%\n  said:  ${reference}\n  heard: ${transcript}`);
      expect(wer, `WER for recorded clip ${name}`).toBeLessThan(MAX_WORD_ERROR_RATE);
    });
  }
});
