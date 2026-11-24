import { describe, expect, it } from "vitest";
import { isAllowedModelFile, readPins } from "../../scripts/fetch-models.mjs";
import { MOONSHINE_DTYPE, MOONSHINE_MODEL_ID, maxNewTokens } from "./moonshine";

// Transformers.js file-name suffix per dtype (DEFAULT_DTYPE_SUFFIX_MAPPING in 3.8.1).
const SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4" };

describe("Moonshine pins", () => {
  it("pin exactly the files the app loads for its model and dtype, all ONNX or JSON", async () => {
    const { moonshine } = await readPins();
    expect(moonshine.repo).toBe(MOONSHINE_MODEL_ID);
    const onnx = Object.entries(MOONSHINE_DTYPE).map(([name, dtype]) => `onnx/${name}${SUFFIX[dtype]}.onnx`);
    expect(moonshine.files.map((file: { path: string }) => file.path).sort()).toEqual(
      [
        "config.json",
        "generation_config.json",
        "preprocessor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        ...onnx,
      ].sort(),
    );
    for (const file of moonshine.files) expect(isAllowedModelFile(file.path)).toBe(true);
  });
});

describe("maxNewTokens", () => {
  it("allows at least the library's 6 tokens per second, plus headroom for short clips", () => {
    for (const seconds of [0.5, 1, 3.7, 6, 20]) {
      expect(maxNewTokens(seconds)).toBeGreaterThanOrEqual(Math.floor(seconds) * 6 + 4);
    }
    expect(maxNewTokens(5)).toBeLessThanOrEqual(50); // still bounded, to stop runaway output
  });
});
