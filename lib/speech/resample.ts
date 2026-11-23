// Sample-rate conversion for speech audio: Kokoro renders at 24 kHz, microphones record
// at 44.1 or 48 kHz, and Moonshine expects 16 kHz. Windowed-sinc interpolation with a
// low-pass at 90% of the lower Nyquist frequency, so high frequencies are removed rather
// than folded back into the speech band.

/** Zero crossings of the sinc on each side of the kernel centre, at the cutoff. */
const ZERO_CROSSINGS = 16;
const CUTOFF = 0.9;

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
// Blackman window over [-1, 1].
const blackman = (x: number) => 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);

export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error(`bad sample rates ${fromRate} -> ${toRate}`);
  if (fromRate === toRate) return input;
  const step = fromRate / toRate; // input samples per output sample
  // Cutoff in cycles per input sample (0.5 is the input Nyquist frequency).
  const cutoff = (CUTOFF * Math.min(1, toRate / fromRate)) / 2;
  const half = Math.ceil(ZERO_CROSSINGS / (2 * cutoff));
  const output = new Float32Array(Math.round(input.length / step));
  for (let n = 0; n < output.length; n++) {
    const t = n * step;
    const centre = Math.floor(t);
    let sum = 0;
    let weight = 0;
    for (let k = centre - half + 1; k <= centre + half; k++) {
      const distance = t - k;
      if (Math.abs(distance) >= half) continue;
      const h = 2 * cutoff * sinc(2 * cutoff * distance) * blackman(distance / half);
      weight += h;
      if (k >= 0 && k < input.length) sum += input[k] * h;
    }
    output[n] = weight > 0 ? sum / weight : 0;
  }
  return output;
}
