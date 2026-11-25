// Messages between the page (lib/briefing/worker-renderer.ts) and the Kokoro worker
// (lib/briefing/kokoro.worker.ts, logic in lib/briefing/worker-core.ts).
//
// One worker loads the model once and renders sentence chunks one at a time, in the order
// they were sent. Audio comes back as a transferred Float32Array (no copy).

import type { BriefingVoice } from "../speech/pins";

export type WorkerDevice = "wasm" | "webgpu";

/** Where a failure happened: the ONNX runtime files, the model files, one sentence, or the worker itself. */
export type RenderStage = "runtime" | "model" | "render" | "worker";

export type WorkerRequest =
  | { type: "load"; device: WorkerDevice; threads: number }
  | { type: "render"; id: number; text: string; voice: BriefingVoice; speed: number }
  /** Drops the named renders (all when `ids` is missing); each answers "cancelled". */
  | { type: "cancel"; ids?: number[] };

export type WorkerReply =
  | { type: "log"; message: string }
  | { type: "progress"; stage: "runtime" | "model"; message: string; percent?: number }
  | { type: "ready"; seconds: number }
  | { type: "rendered"; id: number; samples: Float32Array; sampleRate: number; seconds: number }
  | { type: "cancelled"; id: number }
  /** With `id`: that render failed. Without: loading failed, and every queued render too. */
  | { type: "error"; stage: RenderStage; message: string; id?: number };
