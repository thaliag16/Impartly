import { describe, expect, it } from "vitest";
import { buildCue, buildTestTrack } from "./tone";

const SAMPLE_RATE = 44100;

type Wav = {
  view: DataView;
  text: (offset: number, length: number) => string;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataBytes: number;
  totalBytes: number;
};

async function readWav(blob: Blob): Promise<Wav> {
  const view = new DataView(await blob.arrayBuffer());
  const text = (offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
  return {
    view,
    text,
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
    totalBytes: view.byteLength,
  };
}

function expectValidPcmHeader(wav: Wav, channels: number) {
  expect(wav.text(0, 4)).toBe("RIFF");
  expect(wav.view.getUint32(4, true)).toBe(wav.totalBytes - 8);
  expect(wav.text(8, 4)).toBe("WAVE");
  expect(wav.text(12, 4)).toBe("fmt ");
  expect(wav.view.getUint32(16, true)).toBe(16);
  expect(wav.view.getUint16(20, true)).toBe(1); // PCM
  expect(wav.channels).toBe(channels);
  expect(wav.sampleRate).toBe(SAMPLE_RATE);
  expect(wav.bitsPerSample).toBe(16);
  expect(wav.blockAlign).toBe(channels * 2);
  expect(wav.byteRate).toBe(SAMPLE_RATE * channels * 2);
  expect(wav.text(36, 4)).toBe("data");
  expect(wav.dataBytes).toBe(wav.totalBytes - 44);
}

function monoSamples(wav: Wav): Float32Array {
  const count = wav.dataBytes / 2;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = wav.view.getInt16(44 + i * 2, true) / 32767;
  return out;
}

// Signal power at one frequency (Goertzel), normalised by length.
function powerAt(samples: Float32Array, frequency: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * frequency) / SAMPLE_RATE);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}

describe("buildTestTrack", () => {
  it("writes a valid 16-bit stereo PCM header", async () => {
    const wav = await readWav(buildTestTrack(2));
    expectValidPcmHeader(wav, 2);
    expect(buildTestTrack(1).type).toBe("audio/wav");
  });

  it("has exactly the requested duration", async () => {
    for (const seconds of [1, 2.5, 30]) {
      const wav = await readWav(buildTestTrack(seconds));
      const frames = wav.dataBytes / wav.blockAlign;
      expect(frames).toBe(Math.floor(seconds * SAMPLE_RATE));
      expect(frames / SAMPLE_RATE).toBeCloseTo(seconds, 3);
    }
  });

  it("defaults to 30 seconds", async () => {
    const wav = await readWav(buildTestTrack());
    expect(wav.dataBytes / wav.blockAlign).toBe(30 * SAMPLE_RATE);
  });

  it("puts the first note in the left ear and the second in the right", async () => {
    const wav = await readWav(buildTestTrack(2));
    const energy = (startSec: number, endSec: number, channel: 0 | 1) => {
      let sum = 0;
      for (let f = startSec * SAMPLE_RATE; f < endSec * SAMPLE_RATE; f++) {
        const v = wav.view.getInt16(44 + f * 4 + channel * 2, true);
        sum += v * v;
      }
      return sum;
    };
    expect(energy(0.1, 0.6, 0)).toBeGreaterThan(10 * energy(0.1, 0.6, 1));
    expect(energy(0.85, 1.35, 1)).toBeGreaterThan(10 * energy(0.85, 1.35, 0));
  });
});

describe("buildCue", () => {
  const sounds = ["pop", "bell", "knock"] as const;

  it.each(sounds)("%s cues are valid 16-bit mono PCM", async (sound) => {
    for (const starting of [true, false]) {
      const blob = buildCue(sound, starting);
      expect(blob.type).toBe("audio/wav");
      expectValidPcmHeader(await readWav(blob), 1);
    }
  });

  it("cue lengths match their design (bell 0.6 s, knock 0.42 s, pop 0.34 s)", async () => {
    const expected = { bell: 0.6, knock: 0.42, pop: 0.34 };
    for (const sound of sounds) {
      const wav = await readWav(buildCue(sound, true));
      expect(wav.dataBytes / 2).toBe(Math.floor(expected[sound] * SAMPLE_RATE));
    }
  });

  it("starts with near-silence so a Bluetooth route can wake up", async () => {
    for (const sound of sounds) {
      const samples = monoSamples(await readWav(buildCue(sound, true)));
      const lead = samples.subarray(0, Math.floor(0.075 * SAMPLE_RATE));
      expect(Math.max(...lead.map(Math.abs))).toBe(0);
    }
  });

  it("never clips", async () => {
    for (const sound of sounds) {
      for (const starting of [true, false]) {
        const samples = monoSamples(await readWav(buildCue(sound, starting)));
        expect(Math.max(...samples.map(Math.abs))).toBeLessThan(1);
      }
    }
  });

  it("bell start cue rings at 880 Hz with an 1760 Hz overtone", async () => {
    const samples = monoSamples(await readWav(buildCue("bell", true)));
    const at880 = powerAt(samples, 880);
    expect(at880).toBeGreaterThan(50 * powerAt(samples, 660));
    expect(powerAt(samples, 1760)).toBeGreaterThan(5 * powerAt(samples, 1320));
  });

  it("bell end cue rings at 660 Hz with an 1320 Hz overtone", async () => {
    const samples = monoSamples(await readWav(buildCue("bell", false)));
    expect(powerAt(samples, 660)).toBeGreaterThan(50 * powerAt(samples, 880));
    expect(powerAt(samples, 1320)).toBeGreaterThan(5 * powerAt(samples, 1760));
  });

  it("start and end bells sound different, so the listener can tell them apart", async () => {
    const start = monoSamples(await readWav(buildCue("bell", true)));
    const end = monoSamples(await readWav(buildCue("bell", false)));
    expect(start).not.toEqual(end);
  });

  it("knock start cue is a double knock and the end cue a single knock", async () => {
    const onsets = (samples: Float32Array) => {
      const windowFrames = Math.floor(0.01 * SAMPLE_RATE);
      let count = 0;
      let loud = false;
      for (let i = 0; i + windowFrames <= samples.length; i += windowFrames) {
        const peak = Math.max(...samples.subarray(i, i + windowFrames).map(Math.abs));
        if (!loud && peak > 0.3) count++;
        loud = peak > 0.05;
      }
      return count;
    };
    expect(onsets(monoSamples(await readWav(buildCue("knock", true))))).toBe(2);
    expect(onsets(monoSamples(await readWav(buildCue("knock", false))))).toBe(1);
  });
});
