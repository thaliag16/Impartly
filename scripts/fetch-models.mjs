#!/usr/bin/env node
// Fetches the model files pinned in scripts/model-pins.json into models/ (gitignored)
// and verifies every file by SHA-256 before anything may load it (SECURITY.md).
//
//   node scripts/fetch-models.mjs            fetch missing files, verify all; exit 1 on
//                                            any download or hash failure
//   node scripts/fetch-models.mjs --verify   verify only, never download
//
// Files come only from huggingface.co (and the CDN hosts it redirects to, *.hf.co), from
// the publisher's repository at a full 40-character commit hash, never a branch name.
// Only ONNX, safetensors and JSON config/tokenizer files are accepted.
//
// Trust on first use: while a model has no revision or hashes pinned, this script
// resolves `main` to a commit, downloads each file at that commit, cross-checks the
// bytes against the hashes the Hugging Face API publishes for them (LFS SHA-256, or git
// blob SHA-1 for small files), prints the values to paste into model-pins.json, and
// EXITS 1. An unpinned model can never pass. See PROGRESS.md (run 5).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PINS_FILE = join(ROOT, "scripts", "model-pins.json");
export const MODELS_DIR = join(ROOT, "models");

const HUB = "https://huggingface.co";
const ALLOWED_EXTENSIONS = [".onnx", ".safetensors", ".json"];

/** True for file types SECURITY.md allows: ONNX or safetensors weights, JSON config. */
export function isAllowedModelFile(path) {
  if (path.includes("..") || path.startsWith("/")) return false;
  return ALLOWED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}

export function isCommitHash(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

export function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Downloads may only end up on Hugging Face's own hosts. */
export function isAllowedHost(url) {
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" && (hostname === "huggingface.co" || hostname.endsWith(".hf.co"));
}

/** A model entry is pinned when it has a commit hash and a SHA-256 for every file. */
export function isPinned(model) {
  return isCommitHash(model.revision) && model.files.length > 0 && model.files.every((file) => isSha256(file.sha256));
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Git's blob id (what the Hub reports for small, non-LFS files). */
export function gitBlobSha1(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function localPath(model, file, modelsDir = MODELS_DIR) {
  return join(modelsDir, model.repo, file.path);
}

/**
 * Checks the local copy of a model against its pins.
 * @returns {Promise<{ ok: boolean, problems: string[] }>}
 */
export async function verifyModel(model, modelsDir = MODELS_DIR) {
  const problems = [];
  if (!isPinned(model)) problems.push(`${model.repo}: not pinned (no commit hash or missing SHA-256)`);
  for (const file of model.files) {
    if (!isAllowedModelFile(file.path)) {
      problems.push(`${file.path}: file type not allowed (ONNX, safetensors or JSON only)`);
      continue;
    }
    const path = localPath(model, file, modelsDir);
    try {
      await stat(path);
    } catch {
      problems.push(`${file.path}: missing`);
      continue;
    }
    if (isSha256(file.sha256)) {
      const actual = await sha256File(path);
      if (actual !== file.sha256) problems.push(`${file.path}: SHA-256 mismatch (got ${actual})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export async function readPins(path = PINS_FILE) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function download(url) {
  if (!isAllowedHost(url)) throw new Error(`refusing to download from ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!isAllowedHost(response.url)) throw new Error(`redirected off Hugging Face to ${new URL(response.url).hostname}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function resolveUrl(model, revision, file) {
  return `${HUB}/${model.repo}/resolve/${revision}/${file.path}`;
}

async function writeVerified(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
}

async function fetchPinned(model) {
  const before = await verifyModel(model);
  if (before.ok) {
    console.log(`${model.repo}@${model.revision.slice(0, 12)}: all ${model.files.length} files present and verified`);
    return true;
  }
  let ok = true;
  for (const file of model.files) {
    if (!isAllowedModelFile(file.path)) {
      console.error(`  ${file.path}: file type not allowed`);
      ok = false;
      continue;
    }
    const path = localPath(model, file);
    const present = await stat(path).then(() => true, () => false);
    if (present && (await sha256File(path)) === file.sha256) continue;
    if (present) await rm(path);
    try {
      const bytes = await download(resolveUrl(model, model.revision, file));
      const actual = sha256Bytes(bytes);
      if (actual !== file.sha256) {
        console.error(`  ${file.path}: SHA-256 mismatch, expected ${file.sha256}, got ${actual}; not saved`);
        ok = false;
        continue;
      }
      await writeVerified(path, bytes);
      console.log(`  ${file.path}: downloaded, ${bytes.length} bytes, SHA-256 verified`);
    } catch (error) {
      console.error(`  ${file.path}: ${error.message}`);
      ok = false;
    }
  }
  const after = await verifyModel(model);
  for (const problem of after.problems) console.error(`  ${problem}`);
  return ok && after.ok;
}

// Trust on first use. Never returns success.
async function discover(model) {
  console.log(`${model.repo}: NOT PINNED. Resolving main and computing hashes (trust on first use).`);
  const infoUrl = `${HUB}/api/models/${model.repo}/revision/main?blobs=true`;
  const info = JSON.parse((await download(infoUrl)).toString("utf8"));
  const revision = info.sha;
  if (!isCommitHash(revision)) throw new Error(`Hub returned no commit hash for main: ${revision}`);
  console.log(`  main is commit ${revision}`);
  console.log(`  repo files: ${info.siblings.map((sibling) => sibling.rfilename).join(", ")}`);
  const siblings = new Map(info.siblings.map((sibling) => [sibling.rfilename, sibling]));

  const pinned = [];
  for (const file of model.files) {
    if (!isAllowedModelFile(file.path)) throw new Error(`${file.path}: file type not allowed`);
    const sibling = siblings.get(file.path);
    if (!sibling) throw new Error(`${file.path}: not in the repository at ${revision}`);
    const bytes = await download(resolveUrl(model, revision, { path: file.path }));
    const sha256 = sha256Bytes(bytes);
    let crossCheck;
    if (sibling.lfs?.sha256) {
      if (sibling.lfs.sha256 !== sha256) throw new Error(`${file.path}: bytes do not match the Hub's LFS SHA-256`);
      crossCheck = "matches Hub LFS SHA-256";
    } else if (sibling.blobId) {
      if (sibling.blobId !== gitBlobSha1(bytes)) throw new Error(`${file.path}: bytes do not match the Hub's git blob id`);
      crossCheck = "matches Hub git blob SHA-1";
    } else {
      throw new Error(`${file.path}: the Hub published no hash to cross-check against`);
    }
    if (file.path === "config.json") {
      const config = JSON.parse(bytes.toString("utf8"));
      if (JSON.stringify(config).includes("use_external_data_format")) {
        console.log("  WARNING: config.json mentions use_external_data_format; an .onnx_data file may be needed");
      }
    }
    console.log(`  ${file.path}: ${bytes.length} bytes, sha256 ${sha256} (${crossCheck})`);
    pinned.push({ path: file.path, sha256 });
  }
  const suggestion = { ...model, revision, pinnedFrom: "first CI fetch (trust on first use), Thalia to confirm", files: pinned };
  console.log("\nPaste into scripts/model-pins.json after review:\n");
  console.log(JSON.stringify(suggestion, null, 2));
  return false;
}

async function main() {
  const verifyOnly = process.argv.includes("--verify");
  const pins = await readPins();
  let ok = true;
  for (const [name, model] of Object.entries(pins)) {
    try {
      if (verifyOnly) {
        const result = await verifyModel(model);
        console.log(`${name}: ${result.ok ? "verified" : "NOT verified"}`);
        for (const problem of result.problems) console.error(`  ${problem}`);
        ok &&= result.ok;
      } else if (isPinned(model)) {
        ok = (await fetchPinned(model)) && ok;
      } else {
        ok = (await discover(model)) && ok;
      }
    } catch (error) {
      console.error(`${name}: ${error.message}`);
      ok = false;
    }
  }
  if (!ok) {
    console.error("\nfetch-models: FAILED (see above). Unverified files must not be loaded.");
    process.exit(1);
  }
  console.log("fetch-models: all pinned model files verified");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
