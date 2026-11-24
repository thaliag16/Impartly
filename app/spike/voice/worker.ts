/// <reference lib="webworker" />

// Runs Kokoro off the main thread. The speech model blocks whatever thread it
// runs on, and with several CPU threads it can deadlock a page outright, so it
// lives here and reports back by message.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID, renderBySentence } from "../../../lib/speech/kokoro";
import { cacheApiStore, createPinnedFiles, pinnedFetch, restrictToPinnedModels } from "../../../lib/speech/pinned-files";
import { KOKORO_PINNED_FILES } from "../../../lib/speech/pins";

// Every model and voice file comes from the pinned commit and is checked by SHA-256
// before use (lib/speech/pinned-files.ts). kokoro-js fetches voices with the global
// fetch, so the worker's fetch is replaced by one that only serves pinned files; its own
// voice cache is cleared so nothing unverified from an earlier visit is used.
const networkFetch = self.fetch.bind(self);
const pinned = createPinnedFiles({
  files: KOKORO_PINNED_FILES,
  fetch: networkFetch,
  subtle: self.crypto.subtle,
  store: typeof caches === "undefined" ? undefined : cacheApiStore(caches, "impartly-models-v1"),
});
restrictToPinnedModels(env as unknown as Record<string, unknown>, pinned);
self.fetch = pinnedFetch(pinned, networkFetch);

export type WorkerRequest =
  | { type: "load"; device: "wasm" | "webgpu"; threads: number }
  | { type: "render"; sentences: string[]; voice: string };

export type WorkerReply =
  | { type: "log"; message: string }
  | { type: "progress"; message: string }
  | { type: "ready"; seconds: number }
  | { type: "sentence"; index: number; audio: Float32Array; sampleRate: number; seconds: number }
  | { type: "done" }
  | { type: "error"; message: string };

let tts: KokoroTTS | null = null;

const reply = (message: WorkerReply, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "load") {
      if (request.device === "webgpu") {
        // The graphics-chip path loads the full-precision onnx/model.onnx, which is not
        // pinned yet (only the 8-bit model is). Refuse rather than load it unverified.
        throw new Error("The graphics-chip model is not pinned yet; use a Standard option");
      }
      if (typeof caches !== "undefined") await caches.delete("kokoro-voices");
      const wasm = (env.backends.onnx as { wasm?: { numThreads?: number } }).wasm;
      if (wasm) wasm.numThreads = request.threads;
      reply({
        type: "log",
        message: `worker: threads = ${request.threads}, isolated = ${self.crossOriginIsolated}`,
      });

      const began = performance.now();
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: KOKORO_CPU_DTYPE,
        device: request.device,
        progress_callback: (info) => {
          if (info.status === "progress" && info.file.endsWith(".onnx")) {
            reply({ type: "progress", message: `Downloading voice model: ${Math.round(info.progress)}%` });
          }
        },
      });
      reply({ type: "ready", seconds: (performance.now() - began) / 1000 });
      return;
    }

    if (!tts) throw new Error("Model is not loaded");
    const total = request.sentences.length;
    reply({ type: "progress", message: `Rendering sentence 1 of ${total}` });
    for await (const { index, audio, sampleRate, seconds } of renderBySentence(tts, request.sentences, request.voice)) {
      if (index + 1 < total) reply({ type: "progress", message: `Rendering sentence ${index + 2} of ${total}` });
      reply({ type: "sentence", index, audio, sampleRate, seconds }, [audio.buffer]);
    }
    reply({ type: "done" });
  } catch (error) {
    const pins = pinned.failures.length ? ` (pinned files: ${pinned.failures.join("; ")})` : "";
    reply({ type: "error", message: `${(error as Error).name}: ${(error as Error).message}${pins}` });
  }
});
