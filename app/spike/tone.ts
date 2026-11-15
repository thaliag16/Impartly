// Builds a short stereo test track in the browser, so the repository holds no audio files.
// Notes alternate between the left and right ear. If playback collapses to mono or drops
// to phone-call quality, the left/right movement disappears and the tone turns thin.

const SAMPLE_RATE = 44100;
const NOTES = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63]; // C major arpeggio
const NOTE_SECONDS = 0.75;

export function buildTestTrack(seconds = 30): Blob {
  const frames = Math.floor(seconds * SAMPLE_RATE);
  const bytesPerFrame = 4; // 2 channels, 16-bit
  const buffer = new ArrayBuffer(44 + frames * bytesPerFrame);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + frames * bytesPerFrame, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, frames * bytesPerFrame, true);

  const noteFrames = Math.floor(NOTE_SECONDS * SAMPLE_RATE);
  for (let i = 0; i < frames; i++) {
    const noteIndex = Math.floor(i / noteFrames);
    const within = (i % noteFrames) / noteFrames;
    const frequency = NOTES[noteIndex % NOTES.length];
    const t = i / SAMPLE_RATE;

    // Soft attack and release so notes do not click.
    const envelope = Math.min(1, within * 12) * Math.min(1, (1 - within) * 4);
    // Fundamental plus a quiet high overtone: the overtone is what call-quality audio loses.
    const sample =
      envelope *
      (0.32 * Math.sin(2 * Math.PI * frequency * t) +
        0.08 * Math.sin(2 * Math.PI * frequency * 6 * t));

    const leftEar = noteIndex % 2 === 0;
    const left = sample * (leftEar ? 1 : 0.12);
    const right = sample * (leftEar ? 0.12 : 1);

    view.setInt16(44 + i * bytesPerFrame, Math.round(left * 32767), true);
    view.setInt16(44 + i * bytesPerFrame + 2, Math.round(right * 32767), true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// Short cue sounds that mark the start and end of listening. They are built as
// ordinary audio files and played through an <audio> element, because that path
// follows the phone's current audio route (including Bluetooth with the mic on).

export type CueSound = "pop" | "bell" | "knock";

export const CUE_LABELS: Record<CueSound, string> = {
  pop: "Soft pop",
  bell: "Bell",
  knock: "Double knock",
};

function monoWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clipped * 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// Adds one decaying tone to the buffer, starting at `at` seconds.
function addTone(
  samples: Float32Array,
  at: number,
  frequency: number,
  decay: number,
  level: number,
) {
  const begin = Math.floor(at * SAMPLE_RATE);
  for (let i = begin; i < samples.length; i++) {
    const t = (i - begin) / SAMPLE_RATE;
    const attack = Math.min(1, t / 0.004);
    samples[i] += level * attack * Math.exp(-t / decay) * Math.sin(2 * Math.PI * frequency * t);
  }
}

// `starting` is true for the "speak now" cue and false for the "done listening" cue.
export function buildCue(sound: CueSound, starting: boolean): Blob {
  // A little silence up front gives a Bluetooth route time to wake before the sound.
  const lead = 0.08;
  if (sound === "bell") {
    const samples = new Float32Array(Math.floor(0.6 * SAMPLE_RATE));
    const note = starting ? 880 : 660;
    addTone(samples, lead, note, 0.14, 0.4);
    addTone(samples, lead, note * 2, 0.07, 0.12);
    return monoWav(samples);
  }
  if (sound === "knock") {
    const samples = new Float32Array(Math.floor(0.42 * SAMPLE_RATE));
    addTone(samples, lead, 240, 0.025, 0.7);
    if (starting) addTone(samples, lead + 0.13, 240, 0.025, 0.7);
    return monoWav(samples);
  }
  const samples = new Float32Array(Math.floor(0.34 * SAMPLE_RATE));
  addTone(samples, lead, starting ? 587 : 440, 0.05, 0.55);
  return monoWav(samples);
}
