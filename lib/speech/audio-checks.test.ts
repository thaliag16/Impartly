import { describe, expect, it } from "vitest";
import { countWords, expectedSeconds, speechSpan } from "./audio-checks";

const RATE = 24000;

// Builds a test signal: [seconds, amplitude] segments of a 220 Hz tone (0 = silence).
function signal(...segments: [number, number][]): Float32Array {
  const parts = segments.map(([seconds, amplitude]) =>
    Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) =>
      amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE),
    ),
  );
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("expectedSeconds", () => {
  it("counts words, not punctuation or extra spaces", () => {
    expect(countWords("  Rates rose 4.5% - again!  ")).toBe(4);
  });

  it("converts words to seconds at the given rate", () => {
    expect(expectedSeconds("one two three", 180)).toBeCloseTo(1, 5);
    expect(expectedSeconds("word ".repeat(165))).toBeCloseTo(60, 5);
  });
});

describe("speechSpan", () => {
  it("finds the leading and trailing silence around speech", () => {
    const span = speechSpan(signal([0.3, 0], [1.4, 0.4], [0.3, 0]), RATE);
    expect(span.total).toBeCloseTo(2, 3);
    expect(span.leadingSilence).toBeCloseTo(0.3, 1);
    expect(span.trailingSilence).toBeCloseTo(0.3, 1);
    expect(span.end - span.start).toBeCloseTo(1.4, 1);
  });

  it("sees speech in the last quarter of a complete chunk", () => {
    expect(speechSpan(signal([0.1, 0], [1.8, 0.3], [0.1, 0]), RATE).speechInLastQuarter).toBeGreaterThan(0.5);
  });

  it("flags a chunk whose speech stops early and is padded with silence", () => {
    const span = speechSpan(signal([0.1, 0], [0.8, 0.3], [1.1, 0]), RATE);
    expect(span.speechInLastQuarter).toBe(0);
    expect(span.trailingSilence).toBeGreaterThan(1);
  });

  it("ignores quiet noise relative to speech, and reports pure silence as no speech", () => {
    const span = speechSpan(signal([0.5, 0.005], [1, 0.5], [0.5, 0.005]), RATE);
    expect(span.leadingSilence).toBeCloseTo(0.5, 1);
    const silent = speechSpan(signal([1, 0.001]), RATE);
    expect(silent.end).toBe(0);
    expect(silent.speechInLastQuarter).toBe(0);
  });
});
