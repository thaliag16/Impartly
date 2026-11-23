// Phase 0 timing test: how long does Kokoro take to render speech on a Vercel
// Function's CPU? Returns timings as JSON, or the audio itself with ?audio=1.
//
// Only runs on preview deployments, which sit behind Vercel sign-in, so the
// public site cannot be used to burn the monthly CPU allowance.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { KOKORO_CPU_DTYPE, KOKORO_MODEL_ID, renderBySentence } from "../../../lib/speech/kokoro";
import { splitSentences } from "../../../lib/speech/sentences";
import { encodeWav } from "../../../lib/speech/wav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// TODO before Phase 2: load the revision pinned in scripts/model-pins.json and verify
// the file hashes at runtime too (the model tests already do).

// Vercel Functions can only write to /tmp.
env.cacheDir = "/tmp/impartly-models";

// About 150 words, written the way a spoken summary would be.
const SAMPLE =
  "Here is your briefing. First, from the markets newsletter. Chip makers led a broad rally " +
  "on Friday after a major supplier raised its revenue forecast for the third time this year. " +
  "The company now expects sales to grow by about forty percent, driven by demand for data " +
  "center hardware. Analysts quoted in the piece were split. Some called the forecast " +
  "conservative, while others warned that customers are building more capacity than they " +
  "can use. Second, from the venture newsletter. Two large funds closed this week, together " +
  "raising just over three billion dollars. Both said they will write fewer, larger checks. " +
  "The author argues that this leaves a gap at the seed stage, and that smaller funds are " +
  "already moving to fill it. Finally, a short note on policy. Regulators delayed a decision " +
  "on new disclosure rules until next quarter. That is the end of your briefing.";

let loading: Promise<KokoroTTS> | null = null;
let loadMs = 0;

function loadModel() {
  if (!loading) {
    const began = performance.now();
    loading = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: KOKORO_CPU_DTYPE, device: "cpu" }).then((tts) => {
      loadMs = Math.round(performance.now() - began);
      return tts;
    });
  }
  return loading;
}

export async function GET(request: Request) {
  if (process.env.VERCEL_ENV === "production") {
    return Response.json({ error: "Not available on the public site." }, { status: 404 });
  }

  const url = new URL(request.url);
  const voice = url.searchParams.get("voice") ?? "af_heart";
  const wantAudio = url.searchParams.get("audio") === "1";
  const sentences = splitSentences(SAMPLE);
  const text = url.searchParams.get("short") === "1" ? sentences.slice(0, 3).join(" ") : SAMPLE;

  try {
    const wasCold = loading === null;
    const cpuBefore = process.cpuUsage();
    const tts = await loadModel();

    const began = performance.now();
    // One sentence at a time: a single generate() call on the whole sample cuts it off.
    const parts: Float32Array[] = [];
    let sampleRate = 24000;
    for await (const rendered of renderBySentence(tts, text, voice)) {
      parts.push(rendered.audio);
      sampleRate = rendered.sampleRate;
    }
    const generateMs = Math.round(performance.now() - began);
    const cpu = process.cpuUsage(cpuBefore);

    if (wantAudio) {
      return new Response(encodeWav(parts, sampleRate), {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
      });
    }

    const audioSeconds = parts.reduce((sum, part) => sum + part.length, 0) / sampleRate;
    const cpuSeconds = (cpu.user + cpu.system) / 1e6;
    return Response.json({
      voice,
      words: text.split(/\s+/).length,
      sentences: splitSentences(text).length,
      coldStart: wasCold,
      modelLoadMs: wasCold ? loadMs : 0,
      generateMs,
      audioSeconds: Number(audioSeconds.toFixed(1)),
      // Above 1 means faster than real time.
      speedVersusRealTime: Number((audioSeconds / (generateMs / 1000)).toFixed(2)),
      cpuSecondsThisRequest: Number(cpuSeconds.toFixed(1)),
      cpuSecondsPerMinuteOfAudio: Number(((cpuSeconds / audioSeconds) * 60).toFixed(1)),
      voices: Object.keys(tts.voices ?? {}),
    });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message, stack: (error as Error).stack?.split("\n").slice(0, 6) },
      { status: 500 },
    );
  }
}
