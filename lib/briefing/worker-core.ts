// What the Kokoro worker does with each message, without the worker itself: the browser
// worker (lib/briefing/kokoro.worker.ts) wires it to `self` and the real model; unit tests
// pass a fake model; the CI model test runs it in Node on the real model.
//
//   * One model load per worker: "load" starts it once, later "load"s answer "ready".
//   * Renders run one at a time, in the order sent, each as one sentence chunk with its
//     own voice and speed. Audio is transferred back, not copied.
//   * "cancel" drops queued renders at once; a render already running finishes inside
//     the model (it cannot be interrupted) but its audio is thrown away.
//   * Every failure is answered with its stage (runtime, model or render), never thrown.

import type { BriefingVoice } from "../speech/pins";
import { isBriefingVoice } from "../speech/pins";
import { renderSentence, type KokoroLike } from "../speech/kokoro";
import type { RenderStage, WorkerDevice, WorkerReply, WorkerRequest } from "./worker-protocol";

export const MIN_WORKER_SPEED = 0.5;
export const MAX_WORKER_SPEED = 2;
/** The briefing script keeps chunks at or under 300 characters; anything far longer would be cut off. */
export const MAX_CHUNK_CHARACTERS = 500;

export interface WorkerCoreDeps {
  post(reply: WorkerReply, transfer?: Transferable[]): void;
  /** Sets up the runtime before the model (the browser: ONNX Runtime's WASM files). */
  prepareRuntime?(options: { device: WorkerDevice; threads: number }): Promise<string | void>;
  /** Loads the model; reports download progress in percent. */
  loadModel(options: { device: WorkerDevice; onPercent: (percent: number) => void }): Promise<KokoroLike>;
  /** Extra detail for a failed load, e.g. which pinned files failed. */
  describeFailure?(): string;
}

type RenderRequest = Extract<WorkerRequest, { type: "render" }>;

class StageError extends Error {
  constructor(
    readonly stage: RenderStage,
    message: string,
  ) {
    super(message);
  }
}

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : String(error);

export function createWorkerCore(deps: WorkerCoreDeps): { handle(request: WorkerRequest): Promise<void> } {
  const { post } = deps;
  let loading: Promise<KokoroLike> | null = null;
  let loaded = false;
  const queue: RenderRequest[] = [];
  const cancelled = new Set<number>();
  let current: number | null = null;
  let pumping = false;

  async function load(device: WorkerDevice, threads: number): Promise<KokoroLike> {
    const began = performance.now();
    let stage: RenderStage = "runtime";
    try {
      if (deps.prepareRuntime) {
        post({ type: "progress", stage: "runtime", message: "Loading the speech runtime" });
        const note = await deps.prepareRuntime({ device, threads });
        if (note) post({ type: "log", message: note });
      }
      stage = "model";
      post({ type: "progress", stage: "model", message: "Loading the voice model", percent: 0 });
      let last = 0;
      const tts = await deps.loadModel({
        device,
        onPercent: (percent) => {
          const rounded = Math.max(0, Math.min(100, Math.round(percent)));
          if (rounded === last) return;
          last = rounded;
          post({ type: "progress", stage: "model", message: `Downloading voice model: ${rounded}%`, percent: rounded });
        },
      });
      loaded = true;
      post({ type: "ready", seconds: (performance.now() - began) / 1000 });
      return tts;
    } catch (error) {
      const extra = deps.describeFailure?.();
      throw new StageError(stage, `${describe(error)}${extra ? ` (${extra})` : ""}`);
    }
  }

  function checkRender(request: RenderRequest): string | null {
    if (!Number.isInteger(request.id)) return "Render id must be an integer";
    if (!isBriefingVoice(request.voice)) return `Unknown voice: ${String(request.voice)}`;
    const speed = request.speed;
    if (!(Number.isFinite(speed) && speed >= MIN_WORKER_SPEED && speed <= MAX_WORKER_SPEED)) {
      return `Playback speed must be between ${MIN_WORKER_SPEED} and ${MAX_WORKER_SPEED}`;
    }
    if (typeof request.text !== "string" || !request.text.trim()) return "Nothing to render";
    if (request.text.length > MAX_CHUNK_CHARACTERS) {
      return `Sentence chunk is ${request.text.length} characters; at most ${MAX_CHUNK_CHARACTERS} render without cutting off`;
    }
    return null;
  }

  async function renderOne(request: RenderRequest): Promise<void> {
    const { id } = request;
    if (!loading) {
      post({ type: "error", id, stage: "model", message: "The model is not loaded" });
      return;
    }
    current = id;
    let tts: KokoroLike;
    try {
      tts = await loading;
    } catch {
      current = null;
      cancelled.delete(id);
      // The load failure itself was already answered, without an id.
      post({ type: "error", id, stage: "model", message: "The model failed to load" });
      return;
    }
    if (cancelled.delete(id)) {
      current = null;
      post({ type: "cancelled", id });
      return;
    }
    try {
      const { audio, sampleRate, seconds } = await renderSentence(tts, request.text, request.voice as BriefingVoice, request.speed);
      if (cancelled.delete(id)) post({ type: "cancelled", id });
      else post({ type: "rendered", id, samples: audio, sampleRate, seconds }, [audio.buffer]);
    } catch (error) {
      cancelled.delete(id);
      post({ type: "error", id, stage: "render", message: describe(error) });
    } finally {
      current = null;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) await renderOne(queue.shift()!);
    } finally {
      pumping = false;
    }
  }

  async function handle(request: WorkerRequest): Promise<void> {
    switch (request.type) {
      case "load": {
        if (loaded) {
          post({ type: "ready", seconds: 0 });
          return;
        }
        if (loading) return; // the load under way answers "ready" or "error"
        const threads = Number.isInteger(request.threads) && request.threads > 0 ? request.threads : 1;
        loading = load(request.device === "webgpu" ? "webgpu" : "wasm", threads);
        try {
          await loading;
        } catch (error) {
          loading = null;
          for (const queued of queue.splice(0)) cancelled.delete(queued.id);
          const stage = error instanceof StageError ? error.stage : "model";
          post({ type: "error", stage, message: describe(error) });
        }
        return;
      }
      case "render": {
        const problem = checkRender(request);
        if (problem) {
          post({ type: "error", id: request.id, stage: "render", message: problem });
          return;
        }
        queue.push(request);
        await pump();
        return;
      }
      case "cancel": {
        const all = !request.ids;
        const ids = new Set(request.ids ?? []);
        for (let i = queue.length - 1; i >= 0; i--) {
          if (all || ids.has(queue[i].id)) {
            const [dropped] = queue.splice(i, 1);
            post({ type: "cancelled", id: dropped.id });
          }
        }
        if (current !== null && (all || ids.has(current))) cancelled.add(current);
        return;
      }
      default:
        post({ type: "error", stage: "worker", message: "Unknown request" });
    }
  }

  return { handle };
}
