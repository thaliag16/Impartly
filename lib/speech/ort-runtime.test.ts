import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ORT_RUNTIME_FILES, ORT_RUNTIME_PATH, ORT_RUNTIME_VERSION, ORT_WASM_FILE, prepareOrtRuntime, type OrtEnvLike } from "./ort-runtime";

const subtle = globalThis.crypto.subtle;
const ORIGIN = "https://impartly.example";

async function realWasm() {
  return new Uint8Array(await readFile(`node_modules/onnxruntime-web/dist/${ORT_WASM_FILE}`));
}

function fakeFetch(body: Uint8Array | null, status = 200) {
  const urls: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (!body) throw new TypeError("network down");
    return new Response(body.slice(), { status });
  };
  return { fetch, urls };
}

const freshEnv = (): OrtEnvLike => ({
  versions: { web: ORT_RUNTIME_VERSION },
  // Transformers.js's default, which must be replaced.
  wasm: { wasmPaths: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/" },
});

describe("ONNX Runtime served by the app", () => {
  it("serves from a versioned same-origin path", () => {
    expect(ORT_RUNTIME_PATH).toBe(`/onnxruntime/${ORT_RUNTIME_VERSION}/`);
    expect(ORT_RUNTIME_FILES.map((f) => f.name).sort()).toEqual([
      "ort-wasm-simd-threaded.jsep.mjs",
      "ort-wasm-simd-threaded.jsep.wasm",
    ]);
  });

  it("the runtime Transformers.js bundles is the pinned version", async () => {
    const ort = (await import("onnxruntime-web")) as unknown as { env: { versions: { web?: string } } };
    // Node resolves onnxruntime-web's Node build, which reports the same package version.
    const pkg = JSON.parse(await readFile("node_modules/onnxruntime-web/package.json", "utf8"));
    expect(pkg.version).toBe(ORT_RUNTIME_VERSION);
    expect(ort.env.versions.web ?? pkg.version).toBe(ORT_RUNTIME_VERSION);
  });

  it("points ONNX Runtime at the local folder and hands it the verified WASM binary", async () => {
    const onnx = freshEnv();
    const wasm = await realWasm();
    const { fetch, urls } = fakeFetch(wasm);
    const result = await prepareOrtRuntime({ onnx, origin: ORIGIN, fetch, subtle, threads: 4 });
    expect(onnx.wasm!.wasmPaths).toBe(`${ORIGIN}${ORT_RUNTIME_PATH}`);
    expect(String(onnx.wasm!.wasmPaths)).not.toContain("jsdelivr");
    expect(onnx.wasm!.numThreads).toBe(4);
    expect(onnx.wasm!.wasmBinary).toBeInstanceOf(Uint8Array);
    expect((onnx.wasm!.wasmBinary as Uint8Array).length).toBe(wasm.length);
    expect(urls).toEqual([`${ORIGIN}${ORT_RUNTIME_PATH}${ORT_WASM_FILE}`]);
    expect(result).toEqual({ bytes: wasm.length, url: urls[0] });
  });

  it("refuses a WASM binary that does not match its pin, and never falls back to the CDN", async () => {
    const onnx = freshEnv();
    const { fetch } = fakeFetch(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await expect(prepareOrtRuntime({ onnx, origin: ORIGIN, fetch, subtle })).rejects.toThrow(/SHA-256 mismatch/);
    expect(onnx.wasm!.wasmBinary).toBeUndefined();
    expect(onnx.wasm!.wasmPaths).toBe(`${ORIGIN}${ORT_RUNTIME_PATH}`);
  });

  it("names the file on an HTTP error or a network failure", async () => {
    await expect(prepareOrtRuntime({ onnx: freshEnv(), origin: ORIGIN, fetch: fakeFetch(new Uint8Array(), 404).fetch, subtle })).rejects.toThrow(
      `${ORT_WASM_FILE}: HTTP 404`,
    );
    await expect(prepareOrtRuntime({ onnx: freshEnv(), origin: ORIGIN, fetch: fakeFetch(null).fetch, subtle })).rejects.toThrow(
      `${ORT_WASM_FILE}: download failed (network down)`,
    );
  });

  it("refuses when the bundled runtime is another version than the served files", async () => {
    const onnx = freshEnv();
    onnx.versions = { web: "1.0.0" };
    const { fetch, urls } = fakeFetch(await realWasm());
    await expect(prepareOrtRuntime({ onnx, origin: ORIGIN, fetch, subtle })).rejects.toThrow(/1\.0\.0 is bundled/);
    expect(urls).toEqual([]);
  });

  it("fails clearly without a WASM backend", async () => {
    await expect(prepareOrtRuntime({ onnx: {}, origin: ORIGIN, fetch: fakeFetch(null).fetch, subtle })).rejects.toThrow(/not available/);
  });
});
