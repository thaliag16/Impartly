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
