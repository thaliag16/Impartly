// 16-bit mono PCM WAV from one or more float sample buffers (moved from the voice spike
// so the page and the speech-test route share it).
export function encodeWav(parts: Float32Array[], sampleRate: number): ArrayBuffer {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const clipped = Math.max(-1, Math.min(1, part[i]));
      view.setInt16(offset, Math.round(clipped * 32767), true);
      offset += 2;
    }
  }
  return buffer;
}

export type DecodedWav = { samples: Float32Array; sampleRate: number };

/** Reads a 16-bit PCM WAV file (any channel count, mixed down to mono). */
export function decodeWav(bytes: ArrayBuffer): DecodedWav {
  const view = new DataView(bytes);
  const text = (offset: number) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (bytes.byteLength < 12 || text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error("not a WAV file");
  let format: { channels: number; sampleRate: number; bits: number; audioFormat: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = text(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data chunk before fmt chunk");
      // 1 is PCM; 0xfffe (extensible) is accepted when the samples are 16-bit.
      if ((format.audioFormat !== 1 && format.audioFormat !== 0xfffe) || format.bits !== 16) {
        throw new Error(`only 16-bit PCM WAV is supported (format ${format.audioFormat}, ${format.bits}-bit)`);
      }
      const frames = Math.floor(Math.min(size, bytes.byteLength - body) / (2 * format.channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < format.channels; channel++) {
          sum += view.getInt16(body + (frame * format.channels + channel) * 2, true) / 32768;
        }
        samples[frame] = sum / format.channels;
      }
      return { samples, sampleRate: format.sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}
