import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "./wav";

describe("decodeWav", () => {
  it("reads back what encodeWav writes (16-bit mono)", () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8);
    const decoded = decodeWav(encodeWav([samples], 24000));
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.samples.length).toBe(1000);
    decoded.samples.forEach((value, i) => expect(value).toBeCloseTo(samples[i], 3));
  });

  it("mixes stereo to mono and skips extra chunks", () => {
    const header = new ArrayBuffer(44 + 12 + 8);
    const view = new DataView(header);
    const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, header.byteLength - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true); // stereo
    view.setUint32(24, 16000, true);
    view.setUint32(28, 16000 * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, "LIST"); // an extra chunk before the data, as many recorders write
    view.setUint32(40, 4, true);
    text(48, "data");
    view.setUint32(52, 8, true);
    view.setInt16(56, 16384, true); // frame 1: L 0.5, R 0
    view.setInt16(58, 0, true);
    view.setInt16(60, -32768, true); // frame 2: L -1, R -1
    view.setInt16(62, -32768, true);
    const decoded = decodeWav(header);
    expect(decoded.sampleRate).toBe(16000);
    expect([...decoded.samples]).toEqual([0.25, -1]);
  });

  it("rejects files that are not 16-bit PCM WAV", () => {
    expect(() => decodeWav(new ArrayBuffer(10))).toThrow();
    const bytes = new Uint8Array(encodeWav([new Float32Array(4)], 16000));
    new DataView(bytes.buffer).setUint16(34, 24, true); // 24-bit
    expect(() => decodeWav(bytes.buffer)).toThrow(/16-bit/);
  });
});
