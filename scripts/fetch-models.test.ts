import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitBlobSha1,
  isAllowedHost,
  isAllowedModelFile,
  isPinned,
  readPins,
  sha256Bytes,
  verifyModel,
} from "./fetch-models.mjs";

const REV = "a".repeat(40);

describe("model pin rules", () => {
  it("accepts only ONNX, safetensors and JSON files, never pickle formats or path tricks", () => {
    for (const ok of ["onnx/model_quantized.onnx", "model.safetensors", "config.json"]) {
      expect(isAllowedModelFile(ok)).toBe(true);
    }
    for (const bad of ["model.pt", "model.pth", "model.bin", "weights.pkl", "x.ckpt", "../x.onnx", "/etc/x.json"]) {
      expect(isAllowedModelFile(bad)).toBe(false);
    }
  });

  it("downloads only from Hugging Face's own hosts over HTTPS", () => {
    expect(isAllowedHost("https://huggingface.co/x/y/resolve/abc/config.json")).toBe(true);
    expect(isAllowedHost("https://cas-bridge.xethub.hf.co/abc")).toBe(true);
    expect(isAllowedHost("http://huggingface.co/x")).toBe(false);
    expect(isAllowedHost("https://hf-mirror.com/x")).toBe(false);
    expect(isAllowedHost("https://huggingface.co.evil.example/x")).toBe(false);
  });

  it("treats a branch name or a missing hash as unpinned", () => {
    const file = { path: "config.json", sha256: "b".repeat(64) };
    expect(isPinned({ repo: "o/r", revision: REV, files: [file] })).toBe(true);
    expect(isPinned({ repo: "o/r", revision: "main", files: [file] })).toBe(false);
    expect(isPinned({ repo: "o/r", revision: REV, files: [{ path: "config.json", sha256: null }] })).toBe(false);
    expect(isPinned({ repo: "o/r", revision: REV, files: [] })).toBe(false);
  });

  it("computes git blob ids the way git does", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha1(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("lists every Kokoro file the app loads, all of allowed types", async () => {
    const { kokoro } = await readPins();
    expect(kokoro.repo).toBe("onnx-community/Kokoro-82M-v1.0-ONNX");
    expect(kokoro.files.map((file: { path: string }) => file.path).sort()).toEqual(
      ["config.json", "onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json"],
    );
    for (const file of kokoro.files) expect(isAllowedModelFile(file.path)).toBe(true);
  });
});

describe("verifyModel", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(content: string) {
    dir = await mkdtemp(join(tmpdir(), "impartly-models-"));
    await mkdir(join(dir, "o/r"), { recursive: true });
    await writeFile(join(dir, "o/r/config.json"), content);
  }

  it("passes when every pinned file is present with the right SHA-256", async () => {
    await setup("{}");
    const model = { repo: "o/r", revision: REV, files: [{ path: "config.json", sha256: sha256Bytes(Buffer.from("{}")) }] };
    expect(await verifyModel(model, dir)).toEqual({ ok: true, problems: [] });
  });

  it("fails on a changed file, a missing file, or an unpinned model", async () => {
    await setup('{"tampered":true}');
    const good = sha256Bytes(Buffer.from("{}"));
    const changed = await verifyModel({ repo: "o/r", revision: REV, files: [{ path: "config.json", sha256: good }] }, dir);
    expect(changed.ok).toBe(false);
    expect(changed.problems[0]).toMatch(/SHA-256 mismatch/);

    const missing = await verifyModel({ repo: "o/r", revision: REV, files: [{ path: "tokenizer.json", sha256: good }] }, dir);
    expect(missing.problems).toEqual(["tokenizer.json: missing"]);

    const unpinned = await verifyModel({ repo: "o/r", revision: null, files: [{ path: "config.json", sha256: null }] }, dir);
    expect(unpinned.ok).toBe(false);
  });
});
