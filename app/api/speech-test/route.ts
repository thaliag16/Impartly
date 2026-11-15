// Phase 0 timing test: how long does Kokoro take to render speech on a Vercel
// Function's CPU? Returns timings as JSON, or the audio itself with ?audio=1.
//
// Only runs on preview deployments, which sit behind Vercel sign-in, so the
// public site cannot be used to burn the monthly CPU allowance.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
// TODO before Phase 2: pin MODEL_ID to a specific revision and verify the file hash.

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
    loading = KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" }).then((tts) => {
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
  const text = url.searchParams.get("short") === "1" ? SAMPLE.split(". ").slice(0, 3).join(". ") + "." : SAMPLE;

  try {
    const wasCold = loading === null;
    const cpuBefore = process.cpuUsage();
    const tts = await loadModel();

    const began = performance.now();
    // The voice name is checked by the library; an unknown one throws.
    const audio = await tts.generate(text, { voice: voice as never });
    const generateMs = Math.round(performance.now() - began);
    const cpu = process.cpuUsage(cpuBefore);

    if (wantAudio) {
      return new Response(audio.toWav(), {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
      });
    }

    const audioSeconds = audio.audio.length / audio.sampling_rate;
    const cpuSeconds = (cpu.user + cpu.system) / 1e6;
    return Response.json({
      voice,
      words: text.split(/\s+/).length,
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
