import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import modelPins from "../../scripts/model-pins.json";
import { KOKORO_MODEL_ID } from "./kokoro";
import { BRIEFING_VOICES, KOKORO_PINNED_FILES, KOKORO_VOICE_SHA256, isBriefingVoice } from "./pins";

const require = createRequire(import.meta.url);

describe("Kokoro runtime pins", () => {
  it("are the revision and hashes in scripts/model-pins.json, for the model kokoro-js loads", () => {
    expect(modelPins.kokoro.repo).toBe(KOKORO_MODEL_ID);
    for (const file of modelPins.kokoro.files) {
      expect(KOKORO_PINNED_FILES).toContainEqual({
        repo: KOKORO_MODEL_ID,
        revision: modelPins.kokoro.revision,
        path: file.path,
        sha256: file.sha256,
      });
    }
    for (const file of KOKORO_PINNED_FILES) {
      expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("include exactly the two offered voices", () => {
    expect([...BRIEFING_VOICES]).toEqual(["af_heart", "bm_daniel"]);
    const voices = KOKORO_PINNED_FILES.filter((f) => f.path.startsWith("voices/")).map((f) => f.path);
    expect(voices).toEqual(["voices/af_heart.bin", "voices/bm_daniel.bin"]);
    expect(isBriefingVoice("af_heart")).toBe(true);
    expect(isBriefingVoice("af_bella")).toBe(false);
    expect(isBriefingVoice(undefined)).toBe(false);
  });

  it("voice hashes match the files in the kokoro-js package that package-lock.json pins", () => {
    const voicesDir = join(dirname(dirname(require.resolve("kokoro-js"))), "voices");
    for (const voice of BRIEFING_VOICES) {
      const bytes = readFileSync(join(voicesDir, `${voice}.bin`));
      expect(bytes.length).toBe(522_240);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(KOKORO_VOICE_SHA256[voice]);
    }
  });
});
