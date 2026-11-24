// A stand-in for Kokoro: a `RenderSentence` that returns a soft tone whose length follows
// the text (0.04 s per character at 1x, at least 0.4 s, shorter at higher speeds) and whose
// pitch follows the voice (220 Hz Heart, 330 Hz Daniel). Used by
// unit tests and, in the UI tests only, by /listen when the server sets
// IMPARTLY_E2E_FAKE_RENDER=1 (no model download in the checks job). Never used otherwise.

import type { BriefingVoice } from "../speech/pins";
import type { AudioClip, RenderSentence } from "./render-ahead";

export const FAKE_SAMPLE_RATE = 24_000;
const SECONDS_PER_CHAR = 0.04;
const MIN_SECONDS = 0.4;

/** Each voice gets its own tone, so a UI test can tell which voice's clips are playing. */
export const fakeToneHz = (voice: BriefingVoice) => (voice === "bm_daniel" ? 330 : 220);

export interface FakeRenderer {
  render: RenderSentence;
  calls: { text: string; voice: string; speed: number }[];
  /** Samples the fake returns for this text and speed. */
  samplesFor(text: string, speed: number): number;
}

export function createFakeRenderer(options: { delayMs?: number } = {}): FakeRenderer {
  const calls: FakeRenderer["calls"] = [];
  const samplesFor = (text: string, speed: number) =>
    Math.round((Math.max(MIN_SECONDS, text.length * SECONDS_PER_CHAR) * FAKE_SAMPLE_RATE) / speed);
  const render: RenderSentence = async (text, voice, speed, signal) => {
    signal?.throwIfAborted();
    calls.push({ text, voice, speed });
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const samples = new Float32Array(samplesFor(text, speed));
    // A quiet tone (220 Hz Heart, 330 Hz Daniel) with 10 ms fades: audible, never clicks.
    const hz = fakeToneHz(voice);
    const fade = Math.round(0.01 * FAKE_SAMPLE_RATE);
    for (let i = 0; i < samples.length; i++) {
      const edge = Math.min(1, i / fade, (samples.length - 1 - i) / fade);
      samples[i] = 0.08 * edge * Math.sin((2 * Math.PI * hz * i) / FAKE_SAMPLE_RATE);
    }
    const clip: AudioClip = { sampleRate: FAKE_SAMPLE_RATE, samples };
    return { clip, seconds: samples.length / FAKE_SAMPLE_RATE / 20 };
  };
  return { render, calls, samplesFor };
}
