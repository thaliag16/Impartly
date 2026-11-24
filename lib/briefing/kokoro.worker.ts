/// <reference lib="webworker" />

// The Kokoro worker: renders the briefing off the main thread. The speech model blocks
// whatever thread it runs on, and with several CPU threads it can deadlock a page
// outright, so it lives here and answers by message (lib/briefing/worker-protocol.ts).
// Started by lib/briefing/worker-renderer.ts; the logic is in lib/briefing/worker-core.ts.
//
// Nothing it runs comes from a third party at run time except the pinned model files:
//   * ONNX Runtime's WASM files are served by the app (lib/speech/ort-runtime.ts), the
//     binary checked by SHA-256 here before use; never jsDelivr.
//   * Every model and voice file comes from the pinned Hugging Face commit and is checked
//     by SHA-256 before use (lib/speech/pinned-files.ts). kokoro-js fetches voices with the
//     global fetch, so fetch is replaced by one that only serves pinned files, and its own
//     voice cache is cleared so nothing unverified from an earlier visit is used.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID } from "../speech/kokoro";
import { ORT_RUNTIME_PATH, prepareOrtRuntime, type OrtEnvLike } from "../speech/ort-runtime";
import { cacheApiStore, createPinnedFiles, pinnedFetch, restrictToPinnedModels } from "../speech/pinned-files";
import { KOKORO_PINNED_FILES } from "../speech/pins";
import { createWorkerCore } from "./worker-core";
import type { WorkerReply, WorkerRequest } from "./worker-protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const networkFetch = scope.fetch.bind(scope);
const onnx = env.backends.onnx as unknown as OrtEnvLike;
// Before anything can create a session: the app's own runtime folder, never the CDN.
if (onnx?.wasm) onnx.wasm.wasmPaths = new URL(ORT_RUNTIME_PATH, scope.location.origin).href;

const pinned = createPinnedFiles({
  files: KOKORO_PINNED_FILES,
  fetch: networkFetch,
  subtle: scope.crypto.subtle,
  store: typeof caches === "undefined" ? undefined : cacheApiStore(caches, "impartly-models-v1"),
});
restrictToPinnedModels(env as unknown as Record<string, unknown>, pinned);
scope.fetch = pinnedFetch(pinned, networkFetch);

const post = (reply: WorkerReply, transfer: Transferable[] = []) => scope.postMessage(reply, transfer);

const core = createWorkerCore({
  post,
  async prepareRuntime({ device, threads }) {
    if (device === "webgpu") {
      // The graphics-chip path loads the full-precision onnx/model.onnx, which is not
      // pinned (only the 8-bit model is). Refuse rather than load it unverified.
      throw new Error("The graphics-chip model is not pinned; use a Standard option");
    }
    const runtime = await prepareOrtRuntime({
      onnx,
      origin: scope.location.origin,
      fetch: networkFetch,
      subtle: scope.crypto.subtle,
      threads,
    });
    if (typeof caches !== "undefined") await caches.delete("kokoro-voices");
    return `worker: runtime ${new URL(runtime.url).pathname} verified, threads = ${threads}, isolated = ${scope.crossOriginIsolated}`;
  },
  loadModel: ({ device, onPercent }) =>
    KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype: KOKORO_CPU_DTYPE,
      device,
      progress_callback: (info) => {
        if (info.status === "progress" && info.file.endsWith(".onnx")) onPercent(info.progress);
      },
    }),
  describeFailure: () => (pinned.failures.length ? `pinned files: ${pinned.failures.join("; ")}` : ""),
});

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void core.handle(event.data);
});
