import { describe, expect, it } from "vitest";
import { addNoise, rms, seededRandom } from "./noise";

describe("addNoise", () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => 0.3 * Math.sin(i / 7));

  it("adds noise at the requested signal-to-noise ratio", () => {
    for (const snrDb of [10, 20, 30]) {
      const noisy = addNoise(tone, snrDb, 7);
      const noise = noisy.map((value, i) => value - tone[i]);
      const measured = 20 * Math.log10(rms(tone) / rms(noise));
      expect(measured).toBeCloseTo(snrDb, 0);
    }
  });

  it("is the same for the same seed and different for another", () => {
    expect(addNoise(tone, 20, 3)).toEqual(addNoise(tone, 20, 3));
    expect(addNoise(tone, 20, 3)).not.toEqual(addNoise(tone, 20, 4));
  });

  it("returns numbers in [0, 1)", () => {
    const random = seededRandom(9);
    for (let i = 0; i < 1000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
