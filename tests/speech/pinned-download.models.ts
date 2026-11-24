// The app's runtime download path, against the real Hugging Face (CI model job only;
// huggingface.co is not reachable from every machine). Checks that:
//   * Hugging Face serves, at the pinned commit, voice files byte-identical to the ones in
//     the kokoro-js npm package (the hashes in lib/speech/pins.ts);
//   * kokoro-js loads and speaks with every file coming through lib/speech/pinned-files.ts
//     (the same code the browser worker and the speech-test route use), with no request
//     for a file that is not pinned.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { describe, expect, it } from "vitest";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID } from "../../lib/speech/kokoro";
import { createPinnedFiles, memoryStore, pinnedUrl, restrictToPinnedModels } from "../../lib/speech/pinned-files";
import { KOKORO_PINNED_FILES } from "../../lib/speech/pins";

const required = process.env.CI === "true" || process.env.REQUIRE_MODELS === "1";

describe.skipIf(!required)("runtime model downloads are pinned and verified (real Hugging Face)", () => {
  const requests: string[] = [];
  const pinned = createPinnedFiles({
    files: KOKORO_PINNED_FILES,
    fetch: (input, init) => {
      requests.push(String(input));
      return fetch(input, init);
    },
    subtle: globalThis.crypto.subtle,
    store: memoryStore(),
  });

  it("both voices at the pinned commit match the kokoro-js package's hashes", async () => {
    for (const file of KOKORO_PINNED_FILES.filter((f) => f.path.startsWith("voices/"))) {
      const bytes = await pinned.load(file);
      expect(bytes.length).toBe(522_240);
    }
    expect(pinned.failures).toEqual([]);
  });

  it("kokoro-js loads and renders with every model file coming through the pinned loader", async () => {
    restrictToPinnedModels(env as unknown as Record<string, unknown>, pinned);
    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: KOKORO_CPU_DTYPE, device: "cpu" });
    const audio = await tts.generate("Pinned and verified.", { voice: "af_heart" });
    expect(audio.audio.length / audio.sampling_rate).toBeGreaterThan(0.5);
    expect(pinned.failures).toEqual([]);
    const pinnedUrls = new Set(KOKORO_PINNED_FILES.map(pinnedUrl));
    for (const url of requests) expect(pinnedUrls.has(url)).toBe(true);
    expect(requests).toContain(pinnedUrl(KOKORO_PINNED_FILES.find((f) => f.path === "onnx/model_quantized.onnx")!));
  });
});
