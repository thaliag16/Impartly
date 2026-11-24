import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PINNED_LOCAL_PREFIX,
  cacheApiStore,
  createPinnedFiles,
  memoryStore,
  pinnedFetch,
  pinnedUrl,
  restrictToPinnedModels,
  type PinnedFile,
} from "./pinned-files";

const REV = "a".repeat(40);
const OTHER_REV = "b".repeat(40);
const REPO = "invented-org/Invented-TTS-ONNX";
const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const MODEL = bytes("invented model bytes");
const CONFIG = bytes('{"invented":true}');
const VOICE = bytes("invented voice bytes");

const FILES: PinnedFile[] = [
  { repo: REPO, revision: REV, path: "onnx/model_quantized.onnx", sha256: sha(MODEL) },
  { repo: REPO, revision: REV, path: "config.json", sha256: sha(CONFIG) },
  { repo: REPO, revision: REV, path: "voices/af_heart.bin", sha256: sha(VOICE) },
];

/** A fake network: serves `served` by exact URL and records every request. */
function fakeNetwork(served: Record<string, Uint8Array>, finalUrl?: (url: string) => string) {
  const requests: string[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const body = served[url];
    const response = body ? new Response(body.slice(), { status: 200 }) : new Response("nope", { status: 404 });
    Object.defineProperty(response, "url", { value: finalUrl ? finalUrl(url) : url });
    return response;
  };
  return { fetch, requests };
}

const subtle = globalThis.crypto.subtle;
const url = (path: string, rev = REV) => `https://huggingface.co/${REPO}/resolve/${rev}/${path}`;
const servedAll = () => ({
  [url("onnx/model_quantized.onnx")]: MODEL,
  [url("config.json")]: CONFIG,
  [url("voices/af_heart.bin")]: VOICE,
});

describe("pinnedUrl", () => {
  it("always uses the pinned commit, never a branch", () => {
    expect(pinnedUrl(FILES[0])).toBe(url("onnx/model_quantized.onnx"));
  });
});

describe("createPinnedFiles", () => {
  it("downloads a pinned file from the pinned revision and returns it after the hash matches", async () => {
    const net = fakeNetwork(servedAll());
    const pinned = createPinnedFiles({ files: FILES, fetch: net.fetch, subtle });
    expect(await pinned.load(FILES[0])).toEqual(MODEL);
    expect(net.requests).toEqual([url("onnx/model_quantized.onnx")]);
  });

  it("refuses bytes whose SHA-256 differs from the pin, and stores nothing", async () => {
    const store = memoryStore();
    const net = fakeNetwork({ [url("config.json")]: bytes('{"tampered":true}') });
    const pinned = createPinnedFiles({ files: FILES, fetch: net.fetch, subtle, store });
    await expect(pinned.load(FILES[1])).rejects.toThrow(/SHA-256 mismatch/);
    expect(await store.get(url("config.json"))).toBeUndefined();
    expect(pinned.failures.join("\n")).toMatch(/config\.json: SHA-256 mismatch/);
  });

  it("refuses an HTTP error and a redirect off Hugging Face", async () => {
    const missing = createPinnedFiles({ files: FILES, fetch: fakeNetwork({}).fetch, subtle });
    await expect(missing.load(FILES[0])).rejects.toThrow(/HTTP 404/);

    const offsite = fakeNetwork(servedAll(), () => "https://cdn.attacker.example/model.onnx");
    const redirected = createPinnedFiles({ files: FILES, fetch: offsite.fetch, subtle });
    await expect(redirected.load(FILES[0])).rejects.toThrow(/redirected off Hugging Face/);

    const cdn = fakeNetwork(servedAll(), () => "https://cas-bridge.xethub.hf.co/x/model.onnx");
    const allowed = createPinnedFiles({ files: FILES, fetch: cdn.fetch, subtle });
    expect(await allowed.load(FILES[0])).toEqual(MODEL);
  });

  it("serves a stored copy without the network, but checks its hash again first", async () => {
    const store = memoryStore();
    const first = fakeNetwork(servedAll());
    await createPinnedFiles({ files: FILES, fetch: first.fetch, subtle, store }).load(FILES[0]);

    const offline = fakeNetwork({});
    const again = createPinnedFiles({ files: FILES, fetch: offline.fetch, subtle, store });
    expect(await again.load(FILES[0])).toEqual(MODEL);
    expect(offline.requests).toEqual([]);

    // A stored copy that no longer matches (written by something else) is dropped and
    // fetched again.
    await store.put(url("onnx/model_quantized.onnx"), bytes("corrupted"));
    const refetch = fakeNetwork(servedAll());
    const third = createPinnedFiles({ files: FILES, fetch: refetch.fetch, subtle, store });
    expect(await third.load(FILES[0])).toEqual(MODEL);
    expect(refetch.requests).toEqual([url("onnx/model_quantized.onnx")]);
  });

  it("downloads a file once when it is asked for twice at the same time", async () => {
    const net = fakeNetwork(servedAll());
    const pinned = createPinnedFiles({ files: FILES, fetch: net.fetch, subtle });
    await Promise.all([pinned.load(FILES[0]), pinned.load(FILES[0])]);
    expect(net.requests).toHaveLength(1);
  });

  it("finds a pinned file by any URL or path naming its repo and path, at main or the pinned commit only", () => {
    const pinned = createPinnedFiles({ files: FILES, fetch: fakeNetwork({}).fetch, subtle });
    expect(pinned.lookup(url("config.json", "main"))?.path).toBe("config.json");
    expect(pinned.lookup(url("config.json"))?.path).toBe("config.json");
    expect(pinned.lookup(`${PINNED_LOCAL_PREFIX}${REPO}/onnx/model_quantized.onnx`)?.path).toBe("onnx/model_quantized.onnx");
    expect(pinned.lookup(url("config.json", OTHER_REV))).toBeUndefined();
    expect(pinned.lookup(url("onnx/model.onnx", "main"))).toBeUndefined();
    expect(pinned.lookup(`https://huggingface.co/someone-else/Other/resolve/main/config.json`)).toBeUndefined();
    expect(pinned.lookup(`${PINNED_LOCAL_PREFIX}${REPO}/voices/../config.json`)).toBeUndefined();
  });
});

describe("pinnedFetch (the browser worker's fetch)", () => {
  it("answers Hugging Face URLs for pinned files with verified bytes from the pinned revision", async () => {
    const net = fakeNetwork(servedAll());
    const pinned = createPinnedFiles({ files: FILES, fetch: net.fetch, subtle });
    const guarded = pinnedFetch(pinned, net.fetch);
    const response = await guarded(url("voices/af_heart.bin", "main"));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(VOICE);
    expect(net.requests).toEqual([url("voices/af_heart.bin")]);
  });

  it("refuses any other Hugging Face file instead of fetching it unverified", async () => {
    const net = fakeNetwork({ [url("voices/af_bella.bin", "main")]: bytes("x") });
    const guarded = pinnedFetch(createPinnedFiles({ files: FILES, fetch: net.fetch, subtle }), net.fetch);
    await expect(guarded(url("voices/af_bella.bin", "main"))).rejects.toThrow(/not pinned/);
    await expect(guarded("https://cdn-lfs.hf.co/anything")).rejects.toThrow(/not pinned/);
    expect(net.requests).toEqual([]);
  });

  it("answers the local-model prefix with 404 (optional files are treated as absent) and passes other URLs through", async () => {
    const net = fakeNetwork({ "https://app.example/other.js": bytes("ok") });
    const guarded = pinnedFetch(createPinnedFiles({ files: FILES, fetch: net.fetch, subtle }), net.fetch);
    expect((await guarded(`${PINNED_LOCAL_PREFIX}${REPO}/generation_config.json`)).status).toBe(404);
    expect((await guarded("https://app.example/other.js")).status).toBe(200);
    expect(net.requests).toEqual(["https://app.example/other.js"]);
  });
});

describe("restrictToPinnedModels (Transformers.js settings)", () => {
  it("turns off remote downloads and every unverified cache, and loads through the pinned cache", async () => {
    const env: Record<string, unknown> = {
      allowRemoteModels: true,
      allowLocalModels: false,
      useBrowserCache: true,
      useFSCache: true,
      useCustomCache: false,
      localModelPath: "/models/",
    };
    const net = fakeNetwork(servedAll());
    const pinned = createPinnedFiles({ files: FILES, fetch: net.fetch, subtle });
    restrictToPinnedModels(env, pinned);
    expect(env).toMatchObject({
      allowRemoteModels: false,
      allowLocalModels: true,
      useBrowserCache: false,
      useFSCache: false,
      useCustomCache: true,
      localModelPath: PINNED_LOCAL_PREFIX,
    });

    const cache = env.customCache as { match(key: string): Promise<Response | undefined>; put(): Promise<void> };
    // Transformers.js asks for the local path first, then the remote URL.
    const hit = await cache.match(`${PINNED_LOCAL_PREFIX}${REPO}/config.json`);
    expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(CONFIG);
    expect(await cache.match(`${PINNED_LOCAL_PREFIX}${REPO}/onnx/model.onnx`)).toBeUndefined();
    await expect(cache.put()).resolves.toBeUndefined();
  });

  it("makes a hash mismatch fail the load instead of being skipped", async () => {
    const env: Record<string, unknown> = {};
    const net = fakeNetwork({ [url("config.json")]: bytes("tampered") });
    restrictToPinnedModels(env, createPinnedFiles({ files: FILES, fetch: net.fetch, subtle }));
    const cache = env.customCache as { match(key: string): Promise<Response | undefined> };
    await expect(cache.match(`${PINNED_LOCAL_PREFIX}${REPO}/config.json`)).rejects.toThrow(/SHA-256 mismatch/);
  });
});

describe("cacheApiStore", () => {
  it("keeps verified bytes in a Cache Storage cache under the pinned URL", async () => {
    const entries = new Map<string, Response>();
    const cache = {
      match: async (key: string) => entries.get(key)?.clone(),
      put: async (key: string, response: Response) => void entries.set(key, response),
      delete: async (key: string) => entries.delete(key),
    };
    const opened: string[] = [];
    const storage = { open: async (name: string) => (opened.push(name), cache) };
    const store = cacheApiStore(storage as unknown as CacheStorage, "impartly-models-v1");
    expect(await store.get("https://huggingface.co/x")).toBeUndefined();
    await store.put("https://huggingface.co/x", bytes("abc"));
    expect(await store.get("https://huggingface.co/x")).toEqual(bytes("abc"));
    await store.delete("https://huggingface.co/x");
    expect(await store.get("https://huggingface.co/x")).toBeUndefined();
    expect(opened.every((name) => name === "impartly-models-v1")).toBe(true);
  });
});
