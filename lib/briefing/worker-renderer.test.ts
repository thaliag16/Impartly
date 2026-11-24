import { describe, expect, it, vi } from "vitest";
import type { KokoroLike } from "../speech/kokoro";
import { inProcessWorker, type InProcessWorker } from "./in-process-worker";
import { memoryClipStore, renderAhead } from "./render-ahead";
import { assembleBriefing } from "./script";
import { createWorkerCore, MAX_CHUNK_CHARACTERS } from "./worker-core";
import type { WorkerReply } from "./worker-protocol";
import { createWorkerRenderer, WorkerRendererError, type RendererEvent } from "./worker-renderer";

const SAMPLE_RATE = 24_000;

/** A fake Kokoro: 0.01 s of audio per character at 1x, a constant tone per voice. */
function fakeTts(options: { delay?: () => Promise<void>; fail?: (text: string) => boolean } = {}) {
  const calls: { text: string; voice: string; speed: number }[] = [];
  const tts: KokoroLike = {
    async generate(text, { voice, speed }) {
      calls.push({ text, voice: voice as string, speed });
      await options.delay?.();
      if (options.fail?.(text)) throw new Error("phoneme failure");
      const audio = new Float32Array(Math.round((text.length * 0.01 * SAMPLE_RATE) / speed));
      audio.fill(voice === ("af_heart" as never) ? 0.25 : 0.5);
      return { audio, sampling_rate: SAMPLE_RATE };
    },
  };
  return { tts, calls };
}

/** Lets messages already posted to the fake worker arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function setup(
  deps: Partial<Parameters<typeof inProcessWorker>[0]> & { tts?: KokoroLike } = {},
  options: { threads?: number } = {},
) {
  const fake = fakeTts();
  const tts = deps.tts ?? fake.tts;
  const workers: InProcessWorker[] = [];
  const loads = { count: 0 };
  const events: RendererEvent[] = [];
  const renderer = createWorkerRenderer({
    threads: options.threads,
    onEvent: (event) => events.push(event),
    createWorker: () => {
      const worker = inProcessWorker({
        prepareRuntime: deps.prepareRuntime ?? (async () => "runtime ok"),
        loadModel:
          deps.loadModel ??
          (async ({ onPercent }) => {
            loads.count++;
            onPercent(0);
            onPercent(50.2);
            onPercent(50.4);
            onPercent(100);
            return tts;
          }),
        describeFailure: deps.describeFailure,
      });
      workers.push(worker);
      return worker;
    },
  });
  return { renderer, workers, loads, events, calls: fake.calls };
}

describe("worker renderer (fake worker)", () => {
  it("loads the model once and renders each chunk with its voice and speed", async () => {
    const { renderer, workers, loads, events, calls } = setup({}, { threads: 4 });
    const [a, b] = await Promise.all([
      renderer.render("First sentence.", "af_heart", 1),
      renderer.render("Second, faster.", "bm_daniel", 1.5),
    ]);
    const c = await renderer.render("Third.", "af_heart", 0.75);
    expect(workers).toHaveLength(1);
    expect(loads.count).toBe(1);
    expect(workers[0].sent.filter((m) => m.type === "load")).toEqual([{ type: "load", device: "wasm", threads: 4 }]);
    expect(calls).toEqual([
      { text: "First sentence.", voice: "af_heart", speed: 1 },
      { text: "Second, faster.", voice: "bm_daniel", speed: 1.5 },
      { text: "Third.", voice: "af_heart", speed: 0.75 },
    ]);
    expect(a.clip.sampleRate).toBe(SAMPLE_RATE);
    expect(a.clip.samples).toBeInstanceOf(Float32Array);
    expect(a.clip.samples.length).toBe(Math.round(15 * 0.01 * SAMPLE_RATE));
    expect(a.clip.samples[0]).toBeCloseTo(0.25);
    expect(b.clip.samples[0]).toBeCloseTo(0.5);
    expect(b.clip.samples.length).toBe(Math.round((15 * 0.01 * SAMPLE_RATE) / 1.5));
    expect(c.clip.samples.length).toBe(Math.round((6 * 0.01 * SAMPLE_RATE) / 0.75));
    expect(a.seconds).toBeGreaterThanOrEqual(0);

    // Progress: runtime, then model percentages (deduplicated), then ready once.
    const progress = events.filter((e) => e.type === "progress");
    expect(progress[0]).toMatchObject({ stage: "runtime" });
    expect(progress.filter((e) => e.type === "progress" && e.stage === "model").map((e) => (e as { percent?: number }).percent)).toEqual([0, 50, 100]);
    expect(events.filter((e) => e.type === "ready")).toHaveLength(1);
    expect(events).toContainEqual({ type: "log", message: "runtime ok" });
    expect(events.filter((e) => e.type === "rendered")).toHaveLength(3);
    expect(await renderer.load()).toEqual(expect.objectContaining({ seconds: expect.any(Number) }));
    expect(loads.count).toBe(1);
  });

  it("transfers the audio buffer from the worker instead of copying it", async () => {
    const posted: { reply: WorkerReply; transfer?: Transferable[] }[] = [];
    const { tts } = fakeTts();
    const core = createWorkerCore({
      post: (reply, transfer) => posted.push({ reply, transfer }),
      loadModel: async () => tts,
    });
    await core.handle({ type: "load", device: "wasm", threads: 1 });
    await core.handle({ type: "render", id: 7, text: "Hello there.", voice: "af_heart", speed: 1 });
    const rendered = posted.find((p) => p.reply.type === "rendered")!;
    expect(rendered.reply).toMatchObject({ type: "rendered", id: 7, sampleRate: SAMPLE_RATE });
    const samples = (rendered.reply as { samples: Float32Array }).samples;
    expect(rendered.transfer).toEqual([samples.buffer]);

    // Through structuredClone the sender's buffer is detached: really transferred.
    const { tts: tts2 } = fakeTts();
    const worker = inProcessWorker({ loadModel: async () => tts2 });
    const renderer = createWorkerRenderer({ createWorker: () => worker });
    const { clip } = await renderer.render("Hello there.", "af_heart", 1);
    expect(clip.samples.byteLength).toBeGreaterThan(0);
  });

  it("an aborted signal cancels a queued render; the others still render", async () => {
    const hold = gate();
    const fake = fakeTts({ delay: () => hold.promise });
    const { renderer, workers } = setup({ tts: fake.tts });
    const controller = new AbortController();
    const first = renderer.render("One.", "af_heart", 1);
    const second = renderer.render("Two.", "af_heart", 1, controller.signal);
    const third = renderer.render("Three.", "af_heart", 1);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    hold.open();
    await expect(first).resolves.toBeTruthy();
    await expect(third).resolves.toBeTruthy();
    expect(fake.calls.map((c) => c.text)).toEqual(["One.", "Three."]);
    expect(workers[0].sent).toContainEqual({ type: "cancel", ids: [2] });
  });

  it("an already aborted signal rejects without sending anything", async () => {
    const { renderer, workers } = setup();
    const controller = new AbortController();
    controller.abort(new Error("stop now"));
    await expect(renderer.render("x.", "af_heart", 1, controller.signal)).rejects.toThrow("stop now");
    expect(workers).toHaveLength(0);
  });

  it("cancel() rejects every pending render, and the running one's audio is dropped", async () => {
    const hold = gate();
    const fake = fakeTts({ delay: () => hold.promise });
    const { renderer, workers } = setup({ tts: fake.tts });
    const all = [renderer.render("A.", "af_heart", 1), renderer.render("B.", "af_heart", 1), renderer.render("C.", "af_heart", 1)];
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    renderer.cancel();
    for (const p of all) await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].sent.at(-1)).toEqual({ type: "cancel", ids: [1, 2, 3] });
    await settle();
    hold.open();
    // The worker drops B and C without rendering them.
    await settle();
    expect(fake.calls.map((c) => c.text)).toEqual(["A."]);
    // The renderer still works afterwards, on the same model.
    await expect(renderer.render("D.", "af_heart", 1)).resolves.toBeTruthy();
    expect(workers).toHaveLength(1);
  });

  it("a runtime failure rejects the load and every render with stage runtime", async () => {
    const { renderer, events } = setup({
      prepareRuntime: async () => {
        throw new Error("ort-wasm-simd-threaded.jsep.wasm: HTTP 404");
      },
    });
    const a = renderer.render("A.", "af_heart", 1);
    const b = renderer.render("B.", "af_heart", 1);
    for (const p of [a, b, renderer.load()]) {
      const error = await p.then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(WorkerRendererError);
      expect(error).toMatchObject({ stage: "runtime", message: "ort-wasm-simd-threaded.jsep.wasm: HTTP 404" });
    }
    expect(events.some((e) => e.type === "ready")).toBe(false);
  });

  it("a model failure names the pinned files that failed, and a later load can retry", async () => {
    let attempts = 0;
    const { tts } = fakeTts();
    const { renderer } = setup({
      loadModel: async () => {
        attempts++;
        if (attempts === 1) throw new Error("load failed");
        return tts;
      },
      describeFailure: () => "pinned files: onnx/model_quantized.onnx: HTTP 503",
    });
    await expect(renderer.render("A.", "af_heart", 1)).rejects.toMatchObject({
      stage: "model",
      message: "load failed (pinned files: onnx/model_quantized.onnx: HTTP 503)",
    });
    await expect(renderer.render("A.", "af_heart", 1)).resolves.toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("a failed sentence rejects only that render, with stage render", async () => {
    const fake = fakeTts({ fail: (text) => text.startsWith("Bad") });
    const { renderer } = setup({ tts: fake.tts });
    const results = await Promise.allSettled([
      renderer.render("Good.", "af_heart", 1),
      renderer.render("Bad one.", "af_heart", 1),
      renderer.render("Good again.", "af_heart", 1),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ stage: "render", message: "phoneme failure" });
  });

  it("the worker refuses an unknown voice, a speed out of range and an over-long chunk", async () => {
    const { renderer, calls } = setup();
    await expect(renderer.render("x.", "zz_nobody" as never, 1)).rejects.toMatchObject({ stage: "render", message: "Unknown voice: zz_nobody" });
    await expect(renderer.render("x.", "af_heart", 3)).rejects.toMatchObject({ stage: "render" });
    await expect(renderer.render("x.", "af_heart", Number.NaN)).rejects.toMatchObject({ stage: "render" });
    await expect(renderer.render("a".repeat(MAX_CHUNK_CHARACTERS + 1), "af_heart", 1)).rejects.toMatchObject({ stage: "render" });
    await expect(renderer.render("   ", "af_heart", 1)).rejects.toMatchObject({ stage: "render", message: "Nothing to render" });
    expect(calls).toEqual([]);
  });

  it("a crashed worker rejects pending work with stage worker; the next render starts a new worker", async () => {
    const hold = gate();
    const fake = fakeTts({ delay: () => hold.promise });
    const { renderer, workers } = setup({ tts: fake.tts });
    const pending = renderer.render("A.", "af_heart", 1);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    workers[0].crash("out of memory");
    await expect(pending).rejects.toMatchObject({ stage: "worker", message: "The speech worker stopped: out of memory" });
    expect(workers[0].terminated).toBe(true);
    hold.open();
    await expect(renderer.render("B.", "af_heart", 1)).resolves.toBeTruthy();
    expect(workers).toHaveLength(2);
  });

  it("dispose() stops the worker and rejects pending renders", async () => {
    const hold = gate();
    const fake = fakeTts({ delay: () => hold.promise });
    const { renderer, workers } = setup({ tts: fake.tts });
    const pending = renderer.render("A.", "af_heart", 1);
    renderer.dispose();
    await expect(pending).rejects.toMatchObject({ stage: "worker" });
    expect(workers[0].terminated).toBe(true);
    hold.open();
  });

  it("the worker refuses the graphics-chip device through its runtime step", async () => {
    const posted: WorkerReply[] = [];
    const core = createWorkerCore({
      post: (reply) => posted.push(reply),
      prepareRuntime: async ({ device }) => {
        if (device === "webgpu") throw new Error("not pinned");
      },
      loadModel: async () => fakeTts().tts,
    });
    await core.handle({ type: "load", device: "webgpu", threads: 1 });
    expect(posted.at(-1)).toEqual({ type: "error", stage: "runtime", message: "not pinned" });
  });

  it("a render before any load is refused with stage model", async () => {
    const posted: WorkerReply[] = [];
    const core = createWorkerCore({ post: (reply) => posted.push(reply), loadModel: async () => fakeTts().tts });
    await core.handle({ type: "render", id: 1, text: "Hi.", voice: "af_heart", speed: 1 });
    expect(posted).toEqual([{ type: "error", id: 1, stage: "model", message: "The model is not loaded" }]);
  });
});

describe("render-ahead through the worker renderer", () => {
  const ITEMS = [
    {
      id: "n1",
      feedId: "11111111-1111-4111-8111-111111111111",
      source: "The Invented Ledger",
      subject: "Larkspur Robotics raises a Series B",
      summary: "Larkspur Robotics raised $40 million. The round was led by Fernhill Capital.",
      partial: false,
      receivedAt: "2026-11-24T06:00:00Z",
    },
  ];

  it("renders the whole script once, then serves it from the store", async () => {
    const script = assembleBriefing(ITEMS);
    const { renderer, calls, loads } = setup();
    const store = memoryClipStore();
    const options = { voice: "bm_daniel" as const, speed: 1.25, store, render: renderer.render, subtle: crypto.subtle };
    const first = await renderAhead(script, options);
    expect(first.rendered).toBe(script.sentences.length);
    expect(calls.map((c) => c.text)).toEqual(script.sentences.map((s) => s.text));
    expect(calls.every((c) => c.voice === "bm_daniel" && c.speed === 1.25)).toBe(true);
    const second = await renderAhead(script, options);
    expect(second).toMatchObject({ rendered: 0, cached: script.sentences.length });
    expect(loads.count).toBe(1);
  });

  it("aborting render-ahead cancels the render in flight", async () => {
    const script = assembleBriefing(ITEMS);
    const hold = gate();
    const fake = fakeTts({ delay: () => hold.promise });
    const { renderer, workers } = setup({ tts: fake.tts });
    const controller = new AbortController();
    const run = renderAhead(script, {
      voice: "af_heart",
      speed: 1,
      store: memoryClipStore(),
      render: renderer.render,
      subtle: crypto.subtle,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].sent.some((m) => m.type === "cancel")).toBe(true);
    hold.open();
  });
});
