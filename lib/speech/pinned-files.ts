// Runtime model downloads, pinned and verified (SECURITY.md: models come from the
// publisher's repository at a pinned revision and are verified by hash).
//
// kokoro-js and Transformers.js download from `huggingface.co/<repo>/resolve/main/...`
// by default: a branch, never checked. This module is the only way their bytes arrive:
//   * every file must be listed with its repository, commit and SHA-256 (lib/speech/pins.ts);
//   * it is fetched from that commit, never `main`, and only from Hugging Face's hosts;
//   * its SHA-256 is computed with Web Crypto (SubtleCrypto, in browsers and Node) and
//     must equal the pin, or the load fails;
//   * a stored copy (Cache Storage in the browser) is checked again before every use.
//
// Two adapters hand the verified bytes to the libraries:
//   * restrictToPinnedModels(env, ...) points Transformers.js (the Kokoro model, tokenizer and
//     config) at a custom cache that answers only pinned files, with remote downloads off;
//   * pinnedFetch(...) replaces fetch in the browser worker, for kokoro-js's voice files,
//     and refuses every Hugging Face URL that is not pinned.

export interface PinnedFile {
  /** Hugging Face repository, e.g. "onnx-community/Kokoro-82M-v1.0-ONNX". */
  repo: string;
  /** Full 40-character commit hash. */
  revision: string;
  /** Path inside the repository, e.g. "onnx/model_quantized.onnx". */
  path: string;
  /** Lower-case hex SHA-256 of the file. */
  sha256: string;
}

/** Where verified bytes are kept between page loads. Keys are pinned URLs. */
export interface ByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PinnedFiles {
  /** The pinned file a URL or Transformers.js path names, if any. */
  lookup(urlOrPath: string): PinnedFile | undefined;
  /** The file's bytes, verified against its pin. Rejects on any mismatch or error. */
  load(file: PinnedFile): Promise<Uint8Array>;
  /** Human-readable reasons for every failed load, for the worker's error message. */
  readonly failures: readonly string[];
}

const HUB = "https://huggingface.co";

/**
 * A made-up local folder Transformers.js is told its models live in. Nothing is ever
 * served from it: the custom cache answers pinned files first, and pinnedFetch answers
 * anything else under it with 404, so optional files count as absent.
 */
export const PINNED_LOCAL_PREFIX = "/impartly-pinned-models/";

export function pinnedUrl(file: PinnedFile): string {
  return `${HUB}/${file.repo}/resolve/${file.revision}/${file.path}`;
}

function isHuggingFaceHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "huggingface.co" || hostname.endsWith(".hf.co"));
  } catch {
    return false;
  }
}

export async function sha256Hex(subtle: SubtleCrypto, bytes: Uint8Array): Promise<string> {
  const digest = await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createPinnedFiles(options: {
  files: readonly PinnedFile[];
  fetch: Fetch;
  subtle: SubtleCrypto;
  store?: ByteStore;
}): PinnedFiles {
  const { files, fetch, subtle, store } = options;
  const inFlight = new Map<string, Promise<Uint8Array>>();
  const failures: string[] = [];

  function lookup(urlOrPath: string): PinnedFile | undefined {
    let path = urlOrPath;
    try {
      path = new URL(urlOrPath).pathname;
    } catch {
      // Not a URL: a Transformers.js local path.
    }
    path = decodeURIComponent(path.split("?")[0]);
    if (path.split("/").some((part) => part === "..")) return undefined;
    for (const file of files) {
      const at = path.indexOf(`/${file.repo}/`);
      if (at < 0) continue;
      let rest = path.slice(at + file.repo.length + 2);
      const resolve = /^resolve\/([^/]+)\//.exec(rest);
      if (resolve) {
        if (resolve[1] !== "main" && resolve[1] !== file.revision) continue;
        rest = rest.slice(resolve[0].length);
      }
      if (rest === file.path) return file;
    }
    return undefined;
  }

  async function verified(file: PinnedFile, bytes: Uint8Array): Promise<boolean> {
    return (await sha256Hex(subtle, bytes)) === file.sha256;
  }

  async function download(file: PinnedFile): Promise<Uint8Array> {
    const key = pinnedUrl(file);
    if (store) {
      const kept = await store.get(key).catch(() => undefined);
      if (kept && (await verified(file, kept))) return kept;
      if (kept) await store.delete(key).catch(() => undefined);
    }
    const response = await fetch(key, { redirect: "follow" });
    if (response.url && !isHuggingFaceHost(response.url)) {
      throw new Error(`${file.path}: redirected off Hugging Face`);
    }
    if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = await sha256Hex(subtle, bytes);
    if (actual !== file.sha256) throw new Error(`${file.path}: SHA-256 mismatch (got ${actual})`);
    if (store) await store.put(key, bytes).catch(() => undefined);
    return bytes;
  }

  function load(file: PinnedFile): Promise<Uint8Array> {
    const key = pinnedUrl(file);
    let pending = inFlight.get(key);
    if (!pending) {
      pending = download(file).catch((error: Error) => {
        inFlight.delete(key);
        failures.push(error.message);
        throw error;
      });
      inFlight.set(key, pending);
    }
    return pending;
  }

  return { lookup, load, failures };
}

/** Points Transformers.js at the pinned files only. `env` is Transformers.js's `env`. */
export function restrictToPinnedModels(env: Record<string, unknown>, pinned: PinnedFiles): void {
  Object.assign(env, {
    allowRemoteModels: false,
    allowLocalModels: true,
    localModelPath: PINNED_LOCAL_PREFIX,
    useBrowserCache: false,
    useFSCache: false,
    useCustomCache: true,
    customCache: {
      async match(key: string): Promise<Response | undefined> {
        const file = pinned.lookup(String(key));
        if (!file) return undefined;
        const bytes = await pinned.load(file);
        return new Response(bytes.slice(), { status: 200 });
      },
      // Verified bytes are kept by the pinned store; nothing else is cached.
      async put(): Promise<void> {},
    },
  });
}

/**
 * A fetch for the browser worker: pinned Hugging Face files come back verified, any
 * other Hugging Face URL is refused, the made-up local folder answers 404, and every
 * other URL goes to `base`.
 */
export function pinnedFetch(pinned: PinnedFiles, base: Fetch): Fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    let path = url;
    try {
      path = new URL(url, "https://local.invalid").pathname;
    } catch {
      // keep as is
    }
    if (path.startsWith(PINNED_LOCAL_PREFIX)) {
      const file = pinned.lookup(path);
      if (!file) return new Response(null, { status: 404 });
      return new Response((await pinned.load(file)).slice(), { status: 200 });
    }
    if (isHuggingFaceHost(url)) {
      const file = pinned.lookup(url);
      if (!file) throw new Error(`Model file not pinned, refused: ${url}`);
      return new Response((await pinned.load(file)).slice(), { status: 200 });
    }
    return base(input, init);
  };
}

/** Verified bytes kept in the browser's Cache Storage, keyed by pinned URL. */
export function cacheApiStore(storage: CacheStorage, name: string): ByteStore {
  const open = () => storage.open(name);
  return {
    async get(key) {
      const hit = await (await open()).match(key);
      return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
    },
    async put(key, bytes) {
      await (await open()).put(key, new Response(bytes.slice(), { headers: { "content-type": "application/octet-stream" } }));
    },
    async delete(key) {
      await (await open()).delete(key);
    },
  };
}

/** Kept in memory only (the speech-test route, tests). */
export function memoryStore(): ByteStore {
  const entries = new Map<string, Uint8Array>();
  return {
    get: async (key) => entries.get(key),
    put: async (key, bytes) => void entries.set(key, bytes),
    delete: async (key) => void entries.delete(key),
  };
}
