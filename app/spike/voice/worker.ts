/// <reference lib="webworker" />

// Runs Kokoro off the main thread. The speech model blocks whatever thread it
// runs on, and with several CPU threads it can deadlock a page outright, so it
// lives here and reports back by message.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID, renderBySentence } from "../../../lib/speech/kokoro";

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
      const wasm = (env.backends.onnx as { wasm?: { numThreads?: number } }).wasm;
      if (wasm) wasm.numThreads = request.threads;
      reply({
        type: "log",
        message: `worker: threads = ${request.threads}, isolated = ${self.crossOriginIsolated}`,
      });

      const began = performance.now();
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: request.device === "webgpu" ? "fp32" : KOKORO_CPU_DTYPE,
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
    reply({ type: "error", message: `${(error as Error).name}: ${(error as Error).message}` });
  }
});
