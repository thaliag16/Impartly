// The one place that says which Moonshine model the app loads and how it is called.
// Implements SpeechToText; shared by the model tests and (later) the app, so the tests
// exercise the same code path the app runs.

import { pipeline, type AutomaticSpeechRecognitionPipelineType } from "@huggingface/transformers";
import { resample } from "./resample";
import type { SpeechToText } from "./speech-to-text";

/** Hugging Face repository loaded by Transformers.js. The pinned revision and file
 * hashes live in scripts/model-pins.json (`moonshine`). */
export const MOONSHINE_MODEL_ID = "onnx-community/moonshine-base-ONNX";
/** Full-precision encoder (onnx/encoder_model.onnx) and 4-bit decoder
 * (onnx/decoder_model_merged_q4.onnx): the split Transformers.js uses for Moonshine in
 * its own browser example. Changing this changes which files must be pinned. */
export const MOONSHINE_DTYPE = { encoder_model: "fp32", decoder_model_merged: "q4" } as const;
export const MOONSHINE_SAMPLE_RATE = 16000;

/** Moonshine decodes greedily with a cap on output tokens per second of audio, to stop
 * repeated output. Transformers.js uses floor(seconds) * 6, which can cut off a short,
 * fast question; this allows a little more. */
export function maxNewTokens(seconds: number): number {
  return Math.ceil(seconds * 8) + 4;
}

export type MoonshineOptions = {
  device?: "cpu" | "wasm" | "webgpu";
};

export async function loadMoonshine(options: MoonshineOptions = {}): Promise<SpeechToText> {
  // Narrowed by hand: the library's own overloads are too large for the type checker.
  const load = pipeline as unknown as (
    task: "automatic-speech-recognition",
    model: string,
    options: { dtype: Record<string, string>; device: string },
  ) => Promise<AutomaticSpeechRecognitionPipelineType>;
  const transcriber = await load("automatic-speech-recognition", MOONSHINE_MODEL_ID, {
    dtype: { ...MOONSHINE_DTYPE },
    device: options.device ?? "cpu",
  });

  return {
    async transcribe(samples, sampleRate) {
      const audio = resample(samples, sampleRate, MOONSHINE_SAMPLE_RATE);
      const seconds = audio.length / MOONSHINE_SAMPLE_RATE;
      const output = await transcriber(audio, { max_new_tokens: maxNewTokens(seconds) } as never);
      const first = Array.isArray(output) ? output[0] : output;
      return (first?.text ?? "").trim();
    },
    async dispose() {
      await transcriber.dispose();
    },
  };
}
