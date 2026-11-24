// The page's side of the Kokoro worker: a `RenderSentence` for render-ahead
// (lib/briefing/render-ahead.ts) and for the voice spike page.
//
//   * One model load per renderer (per page session); every render waits for it.
//   * Each sentence chunk goes with its voice and speed; audio comes back transferred.
//   * An AbortSignal cancels one render; cancel() cancels every pending one.
//   * Progress and log events go to `onEvent`.
//   * Failures reject with a WorkerRendererError naming the stage (runtime, model,
//     render or worker). A crashed worker is dropped; the next render starts a new one.

import type { AudioClip, RenderSentence } from "./render-ahead";
import type { RenderStage, WorkerDevice, WorkerReply, WorkerRequest } from "./worker-protocol";
import type { BriefingVoice } from "../speech/pins";

/** The parts of a browser Worker the renderer uses (a fake in unit tests). */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: WorkerReply }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

export type RendererEvent =
  | { type: "log"; message: string }
  | { type: "progress"; stage: "runtime" | "model"; message: string; percent?: number }
  | { type: "ready"; seconds: number }
  | { type: "rendered"; seconds: number; audioSeconds: number };

export class WorkerRendererError extends Error {
  override name = "WorkerRendererError";
  constructor(
    readonly stage: RenderStage,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkerRenderer {
  /** Loads the model once; later calls return the same promise. */
  load(): Promise<{ seconds: number }>;
  render: RenderSentence;
  /** Cancels every pending render (each rejects with an AbortError). */
  cancel(): void;
  /** Stops the worker; pending work rejects. The renderer can be used again after. */
  dispose(): void;
}

/** The app's Kokoro worker. The bundler sees this `new Worker(new URL(...))` and builds the worker file. */
export function createKokoroWorker(): WorkerLike {
  return new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

const abortError = (reason?: unknown) =>
  reason instanceof Error ? reason : new DOMException("The render was cancelled", "AbortError");

interface Pending {
  resolve: (value: { clip: AudioClip; seconds: number }) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export function createWorkerRenderer(options: {
  createWorker?: () => WorkerLike;
  device?: WorkerDevice;
  threads?: number;
  onEvent?: (event: RendererEvent) => void;
}): WorkerRenderer {
  const createWorker = options.createWorker ?? createKokoroWorker;
  const device = options.device ?? "wasm";
  const threads = options.threads ?? 1;
  const emit = (event: RendererEvent) => options.onEvent?.(event);

  let worker: WorkerLike | null = null;
  let loading: Promise<{ seconds: number }> | null = null;
  let settleLoad: { resolve: (value: { seconds: number }) => void; reject: (error: Error) => void } | null = null;
  const pending = new Map<number, Pending>();
  let nextId = 1;

  function failAll(error: Error) {
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) {
      entry.cleanup();
      entry.reject(error);
    }
    if (settleLoad) {
      settleLoad.reject(error);
      settleLoad = null;
    }
    loading = null;
  }

  function onReply(reply: WorkerReply) {
    switch (reply.type) {
      case "log":
        emit({ type: "log", message: reply.message });
        return;
      case "progress":
        emit({ type: "progress", stage: reply.stage, message: reply.message, percent: reply.percent });
        return;
      case "ready":
        emit({ type: "ready", seconds: reply.seconds });
        settleLoad?.resolve({ seconds: reply.seconds });
        settleLoad = null;
        return;
      case "rendered": {
        const entry = pending.get(reply.id);
        if (!entry) return; // cancelled here already
        pending.delete(reply.id);
        entry.cleanup();
        const clip = { samples: reply.samples, sampleRate: reply.sampleRate };
        emit({ type: "rendered", seconds: reply.seconds, audioSeconds: reply.samples.length / reply.sampleRate });
        entry.resolve({ clip, seconds: reply.seconds });
        return;
      }
      case "cancelled": {
        const entry = pending.get(reply.id);
        if (!entry) return;
        pending.delete(reply.id);
        entry.cleanup();
        entry.reject(abortError());
        return;
      }
      case "error": {
        const error = new WorkerRendererError(reply.stage, reply.message);
        if (reply.id === undefined) {
          failAll(error); // loading failed: nothing queued can render
          return;
        }
        const entry = pending.get(reply.id);
        if (!entry) return;
        pending.delete(reply.id);
        entry.cleanup();
        entry.reject(error);
        return;
      }
    }
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const created = createWorker();
    created.addEventListener("message", (event) => {
      if (worker === created) onReply(event.data);
    });
    created.addEventListener("error", (event) => {
      if (worker !== created) return;
      worker = null;
      created.terminate();
      failAll(new WorkerRendererError("worker", `The speech worker stopped: ${event.message || "no details given"}`));
    });
    worker = created;
    return created;
  }

  function load(): Promise<{ seconds: number }> {
    if (loading) return loading;
    const target = ensureWorker();
    loading = new Promise((resolve, reject) => {
      settleLoad = { resolve, reject };
    });
    // A failed load is reported to whoever awaits it; keep it from being unhandled here.
    loading.catch(() => undefined);
    target.postMessage({ type: "load", device, threads });
    return loading;
  }

  const render: RenderSentence = (text: string, voice: BriefingVoice, speed: number, signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    void load(); // once per session; a failed load rejects every pending render (failAll)
    const target = worker!;
    const id = nextId++;
    const result = new Promise<{ clip: AudioClip; seconds: number }>((resolve, reject) => {
      const onAbort = () => {
        if (!pending.delete(id)) return;
        target.postMessage({ type: "cancel", ids: [id] });
        reject(abortError(signal?.reason));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) });
    });
    // Queued now, rendered once the model is ready (the worker waits for its own load).
    target.postMessage({ type: "render", id, text, voice, speed });
    return result;
  };

  function cancel() {
    if (!pending.size) return;
    const ids = [...pending.keys()];
    worker?.postMessage({ type: "cancel", ids });
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) {
      entry.cleanup();
      entry.reject(abortError());
    }
  }

  function dispose() {
    const stopping = worker;
    worker = null;
    stopping?.terminate();
    failAll(new WorkerRendererError("worker", "The speech worker was stopped"));
  }

  return { load, render, cancel, dispose };
}
