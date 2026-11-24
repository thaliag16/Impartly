// The exact Kokoro files the app may load at runtime, each with its SHA-256.
//
// Model files: the revision and hashes in scripts/model-pins.json (the same pins the CI
// model tests verify), pinned from the first CI fetch and confirmed by Thalia against
// Hugging Face on 2026-11-24.
//
// Voice files: the two voices Impartly offers. Their SHA-256 values are those of the
// files shipped in the kokoro-js 1.2.1 npm package (pinned by integrity hash in
// package-lock.json); pins.test.ts checks them against node_modules on every run, and
// the CI model job checks that Hugging Face serves the same bytes at the pinned revision
// (tests/speech/voice-pins.models.ts).

import modelPins from "../../scripts/model-pins.json";
import type { PinnedFile } from "./pinned-files";

export const BRIEFING_VOICES = ["af_heart", "bm_daniel"] as const;
export type BriefingVoice = (typeof BRIEFING_VOICES)[number];

export function isBriefingVoice(value: unknown): value is BriefingVoice {
  return typeof value === "string" && (BRIEFING_VOICES as readonly string[]).includes(value);
}

const KOKORO = modelPins.kokoro;

export const KOKORO_VOICE_SHA256: Readonly<Record<BriefingVoice, string>> = Object.freeze({
  af_heart: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
  bm_daniel: "6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8",
});

/** Every Kokoro file the browser worker may fetch: model, tokenizer, config, two voices. */
export const KOKORO_PINNED_FILES: readonly PinnedFile[] = Object.freeze([
  ...KOKORO.files.map((file) => ({ repo: KOKORO.repo, revision: KOKORO.revision, path: file.path, sha256: file.sha256 })),
  ...BRIEFING_VOICES.map((voice) => ({
    repo: KOKORO.repo,
    revision: KOKORO.revision,
    path: `voices/${voice}.bin`,
    sha256: KOKORO_VOICE_SHA256[voice],
  })),
]);
