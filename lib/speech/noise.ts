// Seeded noise for speech tests, so a "noisy" fixture is the same on every run.

/** Mulberry32: small, fast, deterministic pseudo-random numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Returns a copy with Gaussian white noise at the given signal-to-noise ratio (dB),
 * measured against the RMS level of the whole input. */
export function addNoise(samples: Float32Array, snrDb: number, seed = 1): Float32Array {
  const random = seededRandom(seed);
  const noiseRms = rms(samples) / 10 ** (snrDb / 20);
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Box-Muller transform.
    const gaussian = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    output[i] = Math.max(-1, Math.min(1, samples[i] + gaussian * noiseRms));
  }
  return output;
}
