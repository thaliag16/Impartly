// The one place that says which Kokoro model the app loads and how it renders text.
// Shared by the voice spike worker, the speech-test route and the model tests, so the
// tests exercise the same code path the app runs.

import type { KokoroTTS } from "kokoro-js";
import { splitSentences } from "./sentences";

/** Hugging Face repository kokoro-js loads. The pinned revision and file hashes live in
 * scripts/model-pins.json; the app loads them only through lib/speech/pinned-files.ts. */
export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** 8-bit quantized weights (onnx/model_quantized.onnx) on CPU and WASM. */
export const KOKORO_CPU_DTYPE = "q8";

export type RenderedSentence = {
  index: number;
  text: string;
  audio: Float32Array;
  sampleRate: number;
  /** Wall-clock render time, seconds. */
  seconds: number;
};

/** Renders text one sentence at a time (Kokoro cuts off long input), in order. */
export async function* renderBySentence(
  tts: KokoroTTS,
  input: string | string[],
  voice: string,
  speed = 1,
): AsyncGenerator<RenderedSentence> {
  const sentences = typeof input === "string" ? splitSentences(input) : input;
  for (let index = 0; index < sentences.length; index++) {
    const began = performance.now();
    // The voice name is checked by the library; an unknown one throws.
    const result = await tts.generate(sentences[index], { voice: voice as never, speed });
    yield {
      index,
      text: sentences[index],
      // Copy, so the buffer can be transferred or kept without sharing model memory.
      audio: new Float32Array(result.audio),
      sampleRate: result.sampling_rate,
      seconds: (performance.now() - began) / 1000,
    };
  }
}
