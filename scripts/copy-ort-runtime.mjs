#!/usr/bin/env node
// Copies ONNX Runtime Web's WASM runtime files from the pinned npm package into
// public/onnxruntime/<version>/, so the app serves them itself and the browser never
// downloads runtime code from a CDN (Transformers.js defaults to jsDelivr).
//
//   node scripts/copy-ort-runtime.mjs            verify the package files, copy them,
//                                                verify the copies; exit 1 on any mismatch
//   node scripts/copy-ort-runtime.mjs --verify   verify node_modules and public/ only
//
// Runs before `next build` and `next dev` (package.json prebuild/predev). The version and
// every file's SHA-256 are pinned in scripts/ort-runtime-pins.json; the installed package
// must have exactly that version (package-lock.json pins it by integrity hash) and every
// file must hash to its pin, or the build fails. The output folder is gitignored.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PINS_FILE = join(ROOT, "scripts", "ort-runtime-pins.json");
export const PACKAGE_DIR = join(ROOT, "node_modules", "onnxruntime-web");
export const PUBLIC_ROOT = join(ROOT, "public", "onnxruntime");

export async function readRuntimePins(file = PINS_FILE) {
  const pins = JSON.parse(await readFile(file, "utf8"));
  if (pins.package !== "onnxruntime-web") throw new Error(`${file}: package must be onnxruntime-web`);
  if (typeof pins.version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(pins.version)) {
    throw new Error(`${file}: bad version`);
  }
  if (!Array.isArray(pins.files) || pins.files.length === 0) throw new Error(`${file}: no files`);
  for (const entry of pins.files) {
    if (typeof entry.name !== "string" || !/^ort-wasm[0-9A-Za-z.-]*\.(wasm|mjs)$/.test(entry.name)) {
      throw new Error(`${file}: bad file name ${JSON.stringify(entry.name)}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`${file}: bad SHA-256 for ${entry.name}`);
    }
  }
  return pins;
}

export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Problems with the files in `dir` against the pins; empty when every file matches. */
export async function verifyDir(pins, dir) {
  const problems = [];
  for (const { name, sha256 } of pins.files) {
    let bytes;
    try {
      bytes = await readFile(join(dir, name));
    } catch {
      problems.push(`${name}: missing in ${dir}`);
      continue;
    }
    const actual = sha256Bytes(bytes);
    if (actual !== sha256) problems.push(`${name}: SHA-256 mismatch (got ${actual}, pinned ${sha256})`);
  }
  return problems;
}

/** Problems with the installed package: wrong version or files that do not match. */
export async function verifyPackage(pins, packageDir = PACKAGE_DIR) {
  let installed;
  try {
    installed = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
  } catch {
    return [`onnxruntime-web is not installed at ${packageDir} (run npm ci)`];
  }
  if (installed !== pins.version) {
    return [`onnxruntime-web ${installed} is installed, but ${pins.version} is pinned in scripts/ort-runtime-pins.json`];
  }
  return verifyDir(pins, join(packageDir, "dist"));
}

/** Copies the pinned files into `<publicRoot>/<version>/` and removes any other version. */
export async function copyRuntime(pins, { packageDir = PACKAGE_DIR, publicRoot = PUBLIC_ROOT } = {}) {
  const before = await verifyPackage(pins, packageDir);
  if (before.length) throw new Error(`ONNX Runtime files not verified:\n  ${before.join("\n  ")}`);
  const target = join(publicRoot, pins.version);
  await mkdir(publicRoot, { recursive: true });
  for (const entry of await readdir(publicRoot)) {
    if (entry !== pins.version) await rm(join(publicRoot, entry), { recursive: true, force: true });
  }
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(target)) {
    if (!pins.files.some((file) => file.name === entry)) await rm(join(target, entry), { recursive: true, force: true });
  }
  for (const { name } of pins.files) await copyFile(join(packageDir, "dist", name), join(target, name));
  const after = await verifyDir(pins, target);
  if (after.length) throw new Error(`Copied ONNX Runtime files not verified:\n  ${after.join("\n  ")}`);
  return target;
}

async function main() {
  const pins = await readRuntimePins();
  if (process.argv.includes("--verify")) {
    const problems = [
      ...(await verifyPackage(pins)),
      ...(await verifyDir(pins, join(PUBLIC_ROOT, pins.version))),
    ];
    if (problems.length) {
      console.error(`ONNX Runtime files not verified:\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`ONNX Runtime ${pins.version}: ${pins.files.length} files verified`);
    return;
  }
  const target = await copyRuntime(pins);
  console.log(`ONNX Runtime ${pins.version}: ${pins.files.length} files verified and copied to ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
