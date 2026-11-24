// ONNX Runtime Web's WASM runtime, served by the app itself (never a CDN).
//
// Transformers.js points ONNX Runtime at jsDelivr by default. The build copies the
// pinned package's runtime files into public/onnxruntime/<version>/ after checking each
// one's SHA-256 (scripts/copy-ort-runtime.mjs, pins in scripts/ort-runtime-pins.json).
// In the browser worker, prepareOrtRuntime() then:
//   * points ONNX Runtime at that local folder (`wasmPaths`), so the small JavaScript
//     glue file it imports comes from the app, and
//   * downloads the WASM binary itself, checks its SHA-256 against the pin, and hands
//     ONNX Runtime the verified bytes (`wasmBinary`), so it never fetches the binary.

import runtimePins from "../../scripts/ort-runtime-pins.json";
import { sha256Hex } from "./pinned-files";

export const ORT_RUNTIME_VERSION: string = runtimePins.version;
/** Same-origin path the runtime files are served from. */
export const ORT_RUNTIME_PATH = `/onnxruntime/${ORT_RUNTIME_VERSION}/`;
export const ORT_RUNTIME_FILES: readonly { name: string; sha256: string }[] = Object.freeze(
  runtimePins.files.map((file) => ({ ...file })),
);
export const ORT_WASM_FILE = "ort-wasm-simd-threaded.jsep.wasm";

/** The part of ONNX Runtime's `env` (Transformers.js `env.backends.onnx`) this touches. */
export interface OrtEnvLike {
  versions?: { web?: string };
  wasm?: { wasmPaths?: unknown; wasmBinary?: unknown; numThreads?: number };
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OrtRuntimeError extends Error {
  override name = "OrtRuntimeError";
}

/** Points ONNX Runtime at the app's own copy and loads the verified WASM binary. */
export async function prepareOrtRuntime(options: {
  onnx: OrtEnvLike | undefined;
  /** The page's or worker's origin, e.g. self.location.origin. */
  origin: string;
  fetch: Fetch;
  subtle: SubtleCrypto;
  threads?: number;
}): Promise<{ bytes: number; url: string }> {
  const { onnx, origin, fetch, subtle, threads } = options;
  if (!onnx?.wasm) throw new OrtRuntimeError("ONNX Runtime's WASM backend is not available");
  const loaded = onnx.versions?.web;
  if (loaded && loaded !== ORT_RUNTIME_VERSION) {
    throw new OrtRuntimeError(`ONNX Runtime ${loaded} is bundled, but the served runtime files are ${ORT_RUNTIME_VERSION}`);
  }
  const base = new URL(ORT_RUNTIME_PATH, origin);
  if (base.origin !== new URL(origin).origin) throw new OrtRuntimeError("ONNX Runtime path must be same-origin");
  // Set before anything else, so even a failure below can never fall back to the CDN.
  onnx.wasm.wasmPaths = base.href;
  if (threads !== undefined) onnx.wasm.numThreads = threads;

  const pin = ORT_RUNTIME_FILES.find((file) => file.name === ORT_WASM_FILE);
  if (!pin) throw new OrtRuntimeError(`${ORT_WASM_FILE} is not pinned`);
  const url = new URL(ORT_WASM_FILE, base).href;
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin" });
  } catch (error) {
    throw new OrtRuntimeError(`${ORT_WASM_FILE}: download failed (${(error as Error).message})`);
  }
  if (!response.ok) {
    throw new OrtRuntimeError(`${ORT_WASM_FILE}: HTTP ${response.status} (is the app built with npm run build?)`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = await sha256Hex(subtle, bytes);
  if (actual !== pin.sha256) throw new OrtRuntimeError(`${ORT_WASM_FILE}: SHA-256 mismatch (got ${actual})`);
  onnx.wasm.wasmBinary = bytes;
  return { bytes: bytes.length, url };
}
