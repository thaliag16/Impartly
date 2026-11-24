// Renders a briefing's script to audio ahead of time, on the listener's own device
// (Kokoro in the browser worker: no server cost, and the device renders sentence by
// sentence so no text is cut off). Each sentence's clip is stored under a key made from
// its text, voice and speed, so a second run renders only what changed, and the player
// can play the whole briefing as one queue from the store.
//
// Returns a render report (device seconds, audio seconds, characters) for the render
// cost log (GOAL.md Phase 2, section 6 budget).
//
// The renderer is injected: the browser passes the Kokoro worker renderer
// (lib/briefing/worker-renderer.ts); tests pass a fake.

import { sha256Hex } from "../speech/pinned-files";
import { isBriefingVoice, type BriefingVoice } from "../speech/pins";
import type { BriefingScript } from "./script";

export interface AudioClip {
  sampleRate: number;
  samples: Float32Array;
}

/** Renders one sentence; `seconds` is the wall-clock render time. An aborted signal
 * cancels the render (lib/briefing/worker-renderer.ts is the browser's renderer). */
export type RenderSentence = (
  text: string,
  voice: BriefingVoice,
  speed: number,
  signal?: AbortSignal,
) => Promise<{ clip: AudioClip; seconds: number }>;

export interface ClipStore {
  get(key: string): Promise<AudioClip | undefined>;
  put(key: string, clip: AudioClip): Promise<void>;
  /** The stored keys (optional: a store without keys and delete is never pruned). */
  keys?(): Promise<string[]>;
  delete?(key: string): Promise<void>;
}

export interface RenderReport {
  voice: BriefingVoice;
  speed: number;
  sentences: number;
  rendered: number;
  cached: number;
  characters: number;
  /** Device time spent rendering, seconds. */
  renderSeconds: number;
  /** Length of the whole briefing's audio, seconds. */
  audioSeconds: number;
  /** renderSeconds / audio seconds of what was rendered this run (0 when nothing was). */
  realTimeFactor: number;
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
/** Bumped when the renderer's output for the same text, voice and speed changes. */
const CLIP_VERSION = "kokoro-v1";

export async function clipKey(subtle: SubtleCrypto, text: string, voice: BriefingVoice, speed: number): Promise<string> {
  const hash = await sha256Hex(subtle, new TextEncoder().encode(text));
  return `${CLIP_VERSION}/${voice}/${speed.toFixed(2)}/${hash}`;
}

export async function renderAhead(
  script: BriefingScript,
  options: {
    voice: BriefingVoice;
    speed: number;
    store: ClipStore;
    render: RenderSentence;
    subtle: SubtleCrypto;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<RenderReport> {
  const { voice, speed, store, render, subtle, signal, onProgress } = options;
  if (!isBriefingVoice(voice)) throw new Error(`Unknown voice: ${String(voice)}`);
  if (!(Number.isFinite(speed) && speed >= MIN_SPEED && speed <= MAX_SPEED)) {
    throw new Error(`Playback speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
  }

  const report: RenderReport = {
    voice,
    speed,
    sentences: script.sentences.length,
    rendered: 0,
    cached: 0,
    characters: 0,
    renderSeconds: 0,
    audioSeconds: 0,
    realTimeFactor: 0,
  };
  let renderedAudio = 0;
  const total = script.sentences.length;

  for (const sentence of script.sentences) {
    signal?.throwIfAborted();
    report.characters += sentence.text.length;
    const key = await clipKey(subtle, sentence.text, voice, speed);
    const kept = await store.get(key);
    if (kept) {
      report.cached++;
      report.audioSeconds += kept.samples.length / kept.sampleRate;
    } else {
      const { clip, seconds } = await render(sentence.text, voice, speed, signal);
      await store.put(key, clip);
      const length = clip.samples.length / clip.sampleRate;
      report.rendered++;
      report.renderSeconds += seconds;
      report.audioSeconds += length;
      renderedAudio += length;
    }
    onProgress?.(report.rendered + report.cached, total);
  }
  report.realTimeFactor = renderedAudio > 0 ? report.renderSeconds / renderedAudio : 0;
  return report;
}

/** The keys of every clip this script needs in this voice and speed. */
export async function scriptClipKeys(
  script: BriefingScript,
  options: { voice: BriefingVoice; speed: number; subtle: SubtleCrypto },
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const sentence of script.sentences) keys.add(await clipKey(options.subtle, sentence.text, options.voice, options.speed));
  return keys;
}

/**
 * Deletes every stored clip not in `keep` (the current briefing in the current voice and
 * speed): clips of an old voice or speed, or of an old briefing, are never played again
 * (their keys differ), so they only take up the device's storage. Returns how many went.
 */
export async function pruneClips(store: ClipStore, keep: ReadonlySet<string>): Promise<number> {
  if (!store.keys || !store.delete) return 0;
  let removed = 0;
  for (const key of await store.keys()) {
    if (keep.has(key)) continue;
    await store.delete(key);
    removed++;
  }
  return removed;
}

export function memoryClipStore(): ClipStore {
  const clips = new Map<string, AudioClip>();
  return {
    get: async (key) => clips.get(key),
    put: async (key, clip) => void clips.set(key, clip),
    keys: async () => [...clips.keys()],
    delete: async (key) => void clips.delete(key),
  };
}

/** Cache Storage needs URL keys; this made-up origin is never fetched. */
const CLIP_URL_PREFIX = "https://impartly.invalid/audio/";

/** Clips kept in the browser's Cache Storage as raw little-endian float32 samples. */
export function cacheApiClipStore(storage: CacheStorage, name: string): ClipStore {
  return {
    async get(key) {
      const hit = await (await storage.open(name)).match(CLIP_URL_PREFIX + key);
      if (!hit) return undefined;
      const sampleRate = Number(hit.headers.get("x-sample-rate"));
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) return undefined;
      return { sampleRate, samples: new Float32Array(await hit.arrayBuffer()) };
    },
    async put(key, clip) {
      const body = new Float32Array(clip.samples);
      await (await storage.open(name)).put(
        CLIP_URL_PREFIX + key,
        new Response(body.buffer, {
          headers: { "content-type": "application/octet-stream", "x-sample-rate": String(clip.sampleRate) },
        }),
      );
    },
    async keys() {
      const requests = await (await storage.open(name)).keys();
      return requests.map((r) => r.url).filter((url) => url.startsWith(CLIP_URL_PREFIX)).map((url) => url.slice(CLIP_URL_PREFIX.length));
    },
    async delete(key) {
      await (await storage.open(name)).delete(CLIP_URL_PREFIX + key);
    },
  };
}
