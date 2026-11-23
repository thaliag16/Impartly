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
