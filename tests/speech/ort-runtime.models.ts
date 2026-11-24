// Phase 2: the ONNX Runtime files the app serves (public/onnxruntime/<version>/, copied
// from the pinned package by scripts/copy-ort-runtime.mjs) run the pinned Kokoro model.
//
// This is the browser's runtime: ONNX Runtime Web's browser bundle (the build the app's
// worker bundles), its JavaScript glue imported from the served folder, and the WASM
// binary handed over by prepareOrtRuntime() after its SHA-256 check. It runs in Node, so
// two things differ from the browser: files are read from disk instead of fetched over
// HTTP, and the glue's address is a file URL, because Node cannot import from https.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MODELS_DIR, readPins, verifyModel } from "../../scripts/fetch-models.mjs";
import { copyRuntime, readRuntimePins } from "../../scripts/copy-ort-runtime.mjs";
import { ORT_RUNTIME_PATH, prepareOrtRuntime, type OrtEnvLike } from "../../lib/speech/ort-runtime";
import { KOKORO_MODEL_ID } from "../../lib/speech/kokoro";

const { kokoro: pins } = await readPins();
const verified = await verifyModel(pins, MODELS_DIR);
const required = process.env.CI === "true" || process.env.REQUIRE_MODELS === "1";
const ORIGIN = "https://impartly.test";

interface OrtWeb {
  env: OrtEnvLike & { wasm: { proxy?: boolean } };
  Tensor: new (type: string, data: unknown, dims: number[]) => { data: Float32Array; dims: number[] };
  InferenceSession: {
    create(model: Uint8Array, options: object): Promise<{
      inputNames: string[];
      outputNames: string[];
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
    }>;
  };
}

describe.skipIf(!verified.ok && !required)("the app's ONNX Runtime files run the pinned Kokoro model", () => {
  const temps: string[] = [];
  afterAll(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  it("loads the served glue and the verified WASM binary, and Kokoro produces audio", async () => {
    if (!verified.ok) throw new Error(`Kokoro model files not verified:\n  ${verified.problems.join("\n  ")}`);
    const publicRoot = await mkdtemp(join(tmpdir(), "onnxruntime-"));
    temps.push(publicRoot);
    const servedDir = await copyRuntime(await readRuntimePins(), { publicRoot });

    const ort = (await import(
      pathToFileURL(join(process.cwd(), "node_modules/onnxruntime-web/dist/ort.bundle.min.mjs")).href
    )) as OrtWeb;
    const requested: string[] = [];
    // The served folder, as the worker would fetch it from the app.
    const fetchFromApp = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requested.push(url.href);
      if (url.origin !== ORIGIN || !url.pathname.startsWith(ORT_RUNTIME_PATH)) return new Response(null, { status: 404 });
      const name = url.pathname.slice(ORT_RUNTIME_PATH.length);
      return new Response(new Uint8Array(await readFile(join(servedDir, name))));
    };
    const runtime = await prepareOrtRuntime({ onnx: ort.env, origin: ORIGIN, fetch: fetchFromApp, subtle: crypto.subtle, threads: 1 });
    expect(requested).toEqual([`${ORIGIN}${ORT_RUNTIME_PATH}ort-wasm-simd-threaded.jsep.wasm`]);
    expect(ort.env.wasm!.wasmPaths).toBe(`${ORIGIN}${ORT_RUNTIME_PATH}`);
    expect(runtime.bytes).toBeGreaterThan(1_000_000);
    // Node only: the same served folder, by file URL.
    ort.env.wasm!.wasmPaths = pathToFileURL(`${servedDir}/`).href;

    const model = new Uint8Array(await readFile(join(MODELS_DIR, KOKORO_MODEL_ID, "onnx/model_quantized.onnx")));
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    expect(session.inputNames).toEqual(expect.arrayContaining(["input_ids", "style", "speed"]));

    // A short made-up token sequence (pad, a few phoneme ids, pad) and af_heart's style
    // row for its length, as kokoro-js builds them.
    const tokens = [0, 50, 157, 43, 135, 16, 53, 135, 46, 0];
    const raw = await readFile("node_modules/kokoro-js/voices/af_heart.bin");
    const voice = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const style = voice.slice((tokens.length - 2) * 256, (tokens.length - 1) * 256);
    const out = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]),
      style: new ort.Tensor("float32", style, [1, 256]),
      speed: new ort.Tensor("float32", new Float32Array([1]), [1]),
    });
    const waveform = out[session.outputNames[0]].data;
    console.log(`\nONNX Runtime Web (served files): ${waveform.length} samples from ${tokens.length} tokens`);
    expect(waveform.length).toBeGreaterThan(2400);
    expect(waveform.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(waveform, Math.abs))).toBeGreaterThan(0.001);
  });
});
