import { describe, expect, it } from "vitest";
import { resample } from "./resample";

const tone = (hz: number, sampleRate: number, seconds: number, amplitude = 0.5) =>
  Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate));

const rms = (samples: Float32Array, skip = 0) => {
  let sum = 0;
  for (let i = skip; i < samples.length - skip; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length - 2 * skip));
};

/** Zero crossings per second, a simple frequency estimate for a pure tone. */
const frequency = (samples: Float32Array, sampleRate: number) => {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return crossings / 2 / (samples.length / sampleRate);
};

describe("resample", () => {
  it("returns the input unchanged when the rates match", () => {
    const input = tone(440, 16000, 0.1);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  for (const [from, to] of [[24000, 16000], [48000, 16000], [44100, 16000], [8000, 16000]]) {
    it(`${from} Hz -> ${to} Hz keeps length, pitch and level of a 1 kHz tone`, () => {
      const output = resample(tone(1000, from, 1), from, to);
      expect(output.length).toBe(to);
      expect(frequency(output, to)).toBeGreaterThan(990);
      expect(frequency(output, to)).toBeLessThan(1010);
      expect(rms(output, 100)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    });
  }

  it("filters out content above the new Nyquist frequency instead of aliasing it", () => {
    // 11 kHz at 24 kHz would fold to 5 kHz at 16 kHz without a low-pass filter.
    const output = resample(tone(11000, 24000, 1), 24000, 16000);
    expect(rms(output, 100)).toBeLessThan(0.01);
  });

  it("rejects bad rates", () => {
    expect(() => resample(new Float32Array(10), 0, 16000)).toThrow();
  });
});
