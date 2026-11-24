import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_DIR, copyRuntime, readRuntimePins, sha256Bytes, verifyDir, verifyPackage } from "./copy-ort-runtime.mjs";

const temps: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "ort-runtime-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A copy of the installed package's package.json and pinned files. */
async function fakePackage(pins: Awaited<ReturnType<typeof readRuntimePins>>) {
  const dir = await temp();
  await mkdir(join(dir, "dist"), { recursive: true });
  await cp(join(PACKAGE_DIR, "package.json"), join(dir, "package.json"));
  for (const { name } of pins.files) await cp(join(PACKAGE_DIR, "dist", name), join(dir, "dist", name));
  return dir;
}

describe("ONNX Runtime WASM pins", () => {
  it("the installed onnxruntime-web is the pinned version, and every file matches its SHA-256", async () => {
    const pins = await readRuntimePins();
    expect(await verifyPackage(pins)).toEqual([]);
    for (const { name, sha256 } of pins.files) {
      expect(sha256Bytes(await readFile(join(PACKAGE_DIR, "dist", name))), name).toBe(sha256);
    }
  });

  it("is the version Transformers.js depends on, a direct dependency pinned exactly, locked by integrity", async () => {
    const pins = await readRuntimePins();
    const app = JSON.parse(await readFile("package.json", "utf8"));
    expect(app.dependencies["onnxruntime-web"]).toBe(pins.version);
    const transformers = JSON.parse(await readFile("node_modules/@huggingface/transformers/package.json", "utf8"));
    expect(transformers.dependencies["onnxruntime-web"]).toBe(pins.version);
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    const locked = lock.packages["node_modules/onnxruntime-web"];
    expect(locked.version).toBe(pins.version);
    expect(locked.integrity).toMatch(/^sha512-/);
  });

  it("copies verified files into a versioned folder and removes other versions", async () => {
    const pins = await readRuntimePins();
    const publicRoot = await temp();
    await mkdir(join(publicRoot, "0.0.1-old"), { recursive: true });
    await writeFile(join(publicRoot, "0.0.1-old", "ort-wasm.wasm"), "old");
    const target = await copyRuntime(pins, { publicRoot });
    expect(target).toBe(join(publicRoot, pins.version));
    expect(await readdir(publicRoot)).toEqual([pins.version]);
    expect((await readdir(target)).sort()).toEqual(pins.files.map((f) => f.name).sort());
    expect(await verifyDir(pins, target)).toEqual([]);
  });

  it("refuses a tampered package file and copies nothing", async () => {
    const pins = await readRuntimePins();
    const packageDir = await fakePackage(pins);
    await writeFile(join(packageDir, "dist", pins.files[0].name), "export const tampered = true;\n");
    const publicRoot = await temp();
    await expect(copyRuntime(pins, { packageDir, publicRoot })).rejects.toThrow(/SHA-256 mismatch/);
    expect(await readdir(publicRoot)).toEqual([]);
  });

  it("refuses another installed version", async () => {
    const pins = await readRuntimePins();
    const packageDir = await fakePackage(pins);
    const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
    expect((await verifyPackage(pins, packageDir))[0]).toMatch(/9\.9\.9 is installed/);
  });

  it("rejects malformed pins", async () => {
    const dir = await temp();
    const write = async (value: unknown) => {
      const file = join(dir, "pins.json");
      await writeFile(file, JSON.stringify(value));
      return file;
    };
    const good = await readRuntimePins();
    await expect(readRuntimePins(await write({ ...good, package: "left-pad" }))).rejects.toThrow(/package/);
    await expect(readRuntimePins(await write({ ...good, files: [{ name: "../x.wasm", sha256: good.files[0].sha256 }] }))).rejects.toThrow(/bad file name/);
    await expect(readRuntimePins(await write({ ...good, files: [{ name: good.files[0].name, sha256: "abc" }] }))).rejects.toThrow(/bad SHA-256/);
  });
});
