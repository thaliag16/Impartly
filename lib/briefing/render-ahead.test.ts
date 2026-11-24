import { describe, expect, it } from "vitest";
import { assembleBriefing, type BriefingItem } from "./script";
import {
  cacheApiClipStore,
  clipKey,
  memoryClipStore,
  renderAhead,
  type AudioClip,
  type RenderSentence,
} from "./render-ahead";

const subtle = globalThis.crypto.subtle;

const ITEMS: BriefingItem[] = [
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
const script = assembleBriefing(ITEMS);

/** A fake renderer: 0.1 s of audio per character at 1x, render takes 0.01 s per char. */
function fakeRenderer() {
  const calls: { text: string; voice: string; speed: number }[] = [];
  const render: RenderSentence = async (text, voice, speed) => {
    calls.push({ text, voice, speed });
    const sampleRate = 24_000;
    return {
      clip: { sampleRate, samples: new Float32Array(Math.round((text.length * 0.1 * sampleRate) / speed)) },
      seconds: text.length * 0.01,
    };
  };
  return { render, calls };
}

describe("clipKey", () => {
  it("depends on the text, voice and speed, and holds no text", async () => {
    const a = await clipKey(subtle, "Hello there.", "af_heart", 1);
    expect(a).toMatch(/^kokoro-v1\/af_heart\/1\.00\/[0-9a-f]{64}$/);
    expect(a).not.toContain("Hello");
    expect(await clipKey(subtle, "Hello there.", "af_heart", 1)).toBe(a);
    expect(await clipKey(subtle, "Hello there!", "af_heart", 1)).not.toBe(a);
    expect(await clipKey(subtle, "Hello there.", "bm_daniel", 1)).not.toBe(a);
    expect(await clipKey(subtle, "Hello there.", "af_heart", 1.25)).not.toBe(a);
  });
});

describe("renderAhead", () => {
  it("renders every sentence in play order and stores each clip", async () => {
    const store = memoryClipStore();
    const { render, calls } = fakeRenderer();
    const report = await renderAhead(script, { voice: "af_heart", speed: 1, store, render, subtle });
    expect(calls.map((c) => c.text)).toEqual(script.sentences.map((s) => s.text));
    expect(report).toMatchObject({ sentences: script.sentences.length, rendered: script.sentences.length, cached: 0 });
    for (const s of script.sentences) {
      expect(await store.get(await clipKey(subtle, s.text, "af_heart", 1))).toBeDefined();
    }
  });

  it("reports render cost: device seconds, audio seconds and their ratio", async () => {
    const { render } = fakeRenderer();
    const report = await renderAhead(script, { voice: "af_heart", speed: 1, store: memoryClipStore(), render, subtle });
    const chars = script.sentences.reduce((n, s) => n + s.text.length, 0);
    expect(report.renderSeconds).toBeCloseTo(chars * 0.01, 6);
    expect(report.audioSeconds).toBeCloseTo(chars * 0.1, 3);
    expect(report.realTimeFactor).toBeCloseTo(0.1, 3);
    expect(report.characters).toBe(chars);
  });

  it("renders only what is missing on a second run, and again for another voice or speed", async () => {
    const store = memoryClipStore();
    const first = fakeRenderer();
    await renderAhead(script, { voice: "af_heart", speed: 1, store, render: first.render, subtle });

    const second = fakeRenderer();
    const again = await renderAhead(script, { voice: "af_heart", speed: 1, store, render: second.render, subtle });
    expect(second.calls).toEqual([]);
    expect(again).toMatchObject({ rendered: 0, cached: script.sentences.length, renderSeconds: 0 });

    const other = fakeRenderer();
    await renderAhead(script, { voice: "bm_daniel", speed: 1.25, store, render: other.render, subtle });
    expect(other.calls).toHaveLength(script.sentences.length);
    expect(other.calls.every((c) => c.voice === "bm_daniel" && c.speed === 1.25)).toBe(true);
  });

  it("reports progress after each sentence", async () => {
    const { render } = fakeRenderer();
    const seen: [number, number][] = [];
    await renderAhead(script, {
      voice: "af_heart",
      speed: 1,
      store: memoryClipStore(),
      render,
      subtle,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.at(-1)).toEqual([script.sentences.length, script.sentences.length]);
    expect(seen.map(([d]) => d)).toEqual(script.sentences.map((_, i) => i + 1));
  });

  it("stops when aborted, keeping the clips already rendered", async () => {
    const store = memoryClipStore();
    const controller = new AbortController();
    const { render, calls } = fakeRenderer();
    const stopAfterTwo: RenderSentence = async (...args) => {
      const out = await render(...args);
      if (calls.length === 2) controller.abort();
      return out;
    };
    await expect(
      renderAhead(script, { voice: "af_heart", speed: 1, store, render: stopAfterTwo, subtle, signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(calls).toHaveLength(2);
    expect(await store.get(await clipKey(subtle, script.sentences[1].text, "af_heart", 1))).toBeDefined();
  });

  it("refuses a voice or speed outside the settings' limits", async () => {
    const { render } = fakeRenderer();
    const base = { store: memoryClipStore(), render, subtle };
    await expect(renderAhead(script, { ...base, voice: "af_bella" as never, speed: 1 })).rejects.toThrow(/voice/);
    await expect(renderAhead(script, { ...base, voice: "af_heart", speed: 3 })).rejects.toThrow(/speed/);
  });
});

describe("cacheApiClipStore", () => {
  it("round-trips a clip through Cache Storage as raw float32 with its sample rate", async () => {
    const entries = new Map<string, Response>();
    const cache = {
      match: async (key: string) => entries.get(key)?.clone(),
      put: async (key: string, response: Response) => void entries.set(key, response),
    };
    const storage = { open: async () => cache } as unknown as CacheStorage;
    const store = cacheApiClipStore(storage, "impartly-briefing-audio-v1");
    const clip: AudioClip = { sampleRate: 24_000, samples: Float32Array.from([0, 0.5, -0.25, 1]) };
    const key = "kokoro-v1/af_heart/1.00/" + "0".repeat(64);
    expect(await store.get(key)).toBeUndefined();
    await store.put(key, clip);
    // Keys are stored as same-origin-looking URLs, never with sentence text.
    expect([...entries.keys()][0]).toBe(`https://impartly.invalid/audio/${key}`);
    expect(await store.get(key)).toEqual(clip);
  });
});
