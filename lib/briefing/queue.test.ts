import { describe, expect, it } from "vitest";
import { createFakeRenderer } from "./fake-renderer";
import {
  buildQueue,
  encodeWav,
  loadClips,
  MissingClipsError,
  nextNewsletterStart,
  previousNewsletterStart,
  SECTION_GAP,
  SENTENCE_GAP,
  sectionAt,
  sentenceAt,
  waveformLevels,
} from "./queue";
import { memoryClipStore, renderAhead, type AudioClip } from "./render-ahead";
import { assembleBriefing, type BriefingItem } from "./script";

const subtle = globalThis.crypto.subtle;
const RATE = 24_000;

const item = (n: number, feed: string, source: string): BriefingItem => ({
  id: `n${n}`,
  feedId: feed,
  source,
  subject: `Invented story ${n}`,
  summary: `Story ${n} happened. It mattered a little.`,
  partial: false,
  receivedAt: `2026-11-24T0${n}:00:00Z`,
});
const FEED_A = "11111111-1111-4111-8111-111111111111";
const FEED_B = "22222222-2222-4222-8222-222222222222";
const script = assembleBriefing([item(1, FEED_A, "The Invented Ledger"), item(2, FEED_B, "Harbor Notes")], {
  feedOrder: [FEED_A, FEED_B],
});

/** One clip per sentence, `seconds[i]` long, filled with the value i + 1 (to trace order). */
const clipsOf = (seconds: number[]): AudioClip[] =>
  seconds.map((s, i) => ({ sampleRate: RATE, samples: new Float32Array(Math.round(s * RATE)).fill((i + 1) / 100) }));
const oneSecondEach = () => clipsOf(script.sentences.map(() => 1));

describe("buildQueue: one timeline over the stored clips", () => {
  it("places every sentence in play order with short gaps, longer before a newsletter", () => {
    const q = buildQueue(script, oneSecondEach());
    expect(q.timeline.sentences).toHaveLength(script.sentences.length);
    expect(q.timeline.sentences[0].start).toBe(0);
    for (let i = 1; i < script.sentences.length; i++) {
      const gap = script.sentences[i].kind === "transition" ? SECTION_GAP : SENTENCE_GAP;
      expect(q.timeline.sentences[i].start).toBeCloseTo(q.timeline.sentences[i - 1].end + gap, 4);
      expect(q.timeline.sentences[i].end - q.timeline.sentences[i].start).toBeCloseTo(1, 4);
    }
    expect(q.timeline.duration).toBeCloseTo(q.timeline.sentences.at(-1)!.end, 4);
    expect(SENTENCE_GAP).toBeLessThanOrEqual(0.2); // gapless enough between sentences
  });

  it("lists each newsletter with its title and its span", () => {
    const { timeline } = buildQueue(script, oneSecondEach());
    expect(timeline.sections.map((s) => s.title)).toEqual(["The Invented Ledger", "Harbor Notes"]);
    const [a, b] = timeline.sections;
    expect(a.start).toBe(timeline.sentences[script.sections[0].firstSentence].start);
    expect(b.start).toBe(timeline.sentences[script.sections[1].firstSentence].start);
    expect(a.end).toBeLessThanOrEqual(b.start);
    // The outro comes after the last newsletter.
    expect(timeline.outroStart).toBe(timeline.sentences.at(-1)!.start);
  });

  it("writes one 16-bit mono WAV whose samples follow the timeline", () => {
    const clips = oneSecondEach();
    const q = buildQueue(script, clips);
    const view = new DataView(q.wav.buffer, q.wav.byteOffset, q.wav.byteLength);
    const ascii = (o: number) => String.fromCharCode(...q.wav.subarray(o, o + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(16);
    const frames = view.getUint32(40, true) / 2;
    expect(frames / RATE).toBeCloseTo(q.timeline.duration, 3);
    const sampleAt = (t: number) => view.getInt16(44 + 2 * Math.floor(t * RATE), true) / 32767;
    q.timeline.sentences.forEach((s, i) => {
      expect(sampleAt(s.start + 0.5)).toBeCloseTo((i + 1) / 100, 3); // its own clip
      if (i > 0) expect(sampleAt(s.start - 0.05)).toBe(0); // silence in the gap before it
    });
  });

  it("refuses clips with different sample rates or a count that does not match", () => {
    const clips = oneSecondEach();
    clips[2] = { sampleRate: 22_050, samples: new Float32Array(22_050) };
    expect(() => buildQueue(script, clips)).toThrow(/sample rate/);
    expect(() => buildQueue(script, oneSecondEach().slice(1))).toThrow(/clip/);
  });

  it("clamps samples outside -1..1 when encoding", () => {
    const wav = encodeWav([{ sampleRate: RATE, samples: Float32Array.of(2, -2, 0.5) }], [0], 3, RATE);
    const view = new DataView(wav.buffer);
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([32767, -32767]);
    expect(view.getInt16(48, true)).toBe(Math.round(0.5 * 32767));
  });
});

describe("loadClips: the queue plays only what render-ahead stored", () => {
  it("reads every sentence's clip for the voice and speed, in order", async () => {
    const store = memoryClipStore();
    const fake = createFakeRenderer();
    await renderAhead(script, { voice: "af_heart", speed: 1.25, store, render: fake.render, subtle });
    const clips = await loadClips(script, { store, subtle, voice: "af_heart", speed: 1.25 });
    expect(clips).toHaveLength(script.sentences.length);
    expect(clips[0].samples.length).toBe(fake.samplesFor(script.sentences[0].text, 1.25));
  });

  it("names how many clips are missing (render-ahead has not finished)", async () => {
    const store = memoryClipStore();
    const fake = createFakeRenderer();
    await renderAhead(script, { voice: "af_heart", speed: 1, store, render: fake.render, subtle });
    await expect(loadClips(script, { store, subtle, voice: "bm_daniel", speed: 1 })).rejects.toThrow(MissingClipsError);
    await expect(loadClips(script, { store, subtle, voice: "bm_daniel", speed: 1 })).rejects.toThrow(
      new RegExp(`${script.sentences.length} of ${script.sentences.length}`),
    );
  });
});

describe("finding the place in the timeline", () => {
  const { timeline } = buildQueue(script, oneSecondEach());
  const s = timeline.sentences;

  it("sentenceAt: the sentence playing, which stays current through the gap after it", () => {
    expect(sentenceAt(timeline, 0)).toBe(0);
    expect(sentenceAt(timeline, s[3].start)).toBe(3);
    expect(sentenceAt(timeline, s[3].end + 0.01)).toBe(3);
    expect(sentenceAt(timeline, s[4].start + 0.001)).toBe(4);
    expect(sentenceAt(timeline, timeline.duration + 5)).toBe(s.length - 1);
    expect(sentenceAt(timeline, -1)).toBe(0);
  });

  it("sectionAt: the newsletter playing, or null in the intro and outro", () => {
    expect(sectionAt(timeline, 0.2)).toBeNull();
    expect(sectionAt(timeline, timeline.sections[0].start + 0.1)).toBe(0);
    expect(sectionAt(timeline, timeline.sections[1].start + 0.1)).toBe(1);
    expect(sectionAt(timeline, timeline.outroStart! + 0.1)).toBeNull();
  });

  it("next newsletter: the next one's start, then the outro, then nothing", () => {
    const [a, b] = timeline.sections;
    expect(nextNewsletterStart(timeline, 0)).toBe(a.start);
    expect(nextNewsletterStart(timeline, a.start)).toBe(b.start);
    expect(nextNewsletterStart(timeline, a.start + 1.2)).toBe(b.start);
    expect(nextNewsletterStart(timeline, b.start + 0.3)).toBe(timeline.outroStart);
    expect(nextNewsletterStart(timeline, timeline.outroStart! + 0.1)).toBeNull();
  });

  it("previous newsletter: back to this one's start, or to the one before when just started", () => {
    const [a, b] = timeline.sections;
    expect(previousNewsletterStart(timeline, b.start + 5)).toBe(b.start);
    expect(previousNewsletterStart(timeline, b.start + 1)).toBe(a.start);
    expect(previousNewsletterStart(timeline, a.start + 1)).toBe(0);
    expect(previousNewsletterStart(timeline, 0.5)).toBe(0);
    expect(previousNewsletterStart(timeline, timeline.outroStart! + 0.5)).toBe(b.start);
  });
});

describe("waveformLevels", () => {
  it("gives one level per bar from 0 to 1, louder where the audio is louder", () => {
    const clips = clipsOf(script.sentences.map(() => 1));
    const q = buildQueue(script, clips);
    const levels = waveformLevels(q, 20);
    expect(levels).toHaveLength(20);
    expect(Math.max(...levels)).toBeCloseTo(1, 5);
    expect(levels.every((l) => l >= 0 && l <= 1)).toBe(true);
    // The clips get louder sentence by sentence, so the last bar is above the first.
    expect(levels.at(-1)!).toBeGreaterThan(levels[0]);
  });

  it("is flat (but visible) for silence", () => {
    const q = buildQueue(script, script.sentences.map(() => ({ sampleRate: RATE, samples: new Float32Array(RATE) })));
    expect(new Set(waveformLevels(q, 8)).size).toBe(1);
    expect(waveformLevels(q, 8)[0]).toBeGreaterThan(0);
  });
});
