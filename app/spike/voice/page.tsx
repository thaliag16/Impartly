"use client";

// Phase 0 test: can Kokoro render the briefing's voice on the phone itself?
// Rendering on Vercel's free plan was about 3x slower than real time and too
// CPU-hungry, so this measures the free alternative: the listener's own device.

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const VOICES = [
  { id: "af_heart", label: "Heart (American, female)" },
  { id: "bm_daniel", label: "Daniel (British, male)" },
] as const;
type VoiceId = (typeof VOICES)[number]["id"];

const ENGINES = [
  { id: "wasm", label: "Standard (smaller download)" },
  { id: "webgpu", label: "Graphics chip (bigger download, may be faster)" },
] as const;
type EngineId = (typeof ENGINES)[number]["id"];

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

// Kokoro cuts off long input, so it is always fed one sentence at a time.
const SENTENCES = SAMPLE.match(/[^.!?]+[.!?]+/g)?.map((sentence) => sentence.trim()) ?? [SAMPLE];

type Speaker = {
  generate: (
    text: string,
    options: { voice: VoiceId },
  ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
};

function toWav(parts: Float32Array[], sampleRate: number): Blob {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const clipped = Math.max(-1, Math.min(1, part[i]));
      view.setInt16(offset, Math.round(clipped * 32767), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export default function VoiceTest() {
  const speaker = useRef<Speaker | null>(null);
  const loadedEngine = useRef<EngineId | null>(null);
  const startedAt = useRef(0);

  const [engine, setEngine] = useState<EngineId>("wasm");
  const [voice, setVoice] = useState<VoiceId>("af_heart");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const log = useCallback((message: string) => {
    if (!startedAt.current) startedAt.current = performance.now();
    const elapsed = ((performance.now() - startedAt.current) / 1000).toFixed(1);
    setLines((previous) => [...previous, `${elapsed.padStart(6)}s  ${message}`]);
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      if (!speaker.current || loadedEngine.current !== engine) {
        log(`LOADING model, engine = ${engine}`);
        const began = performance.now();
        const { KokoroTTS } = await import("kokoro-js");
        speaker.current = (await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: engine === "webgpu" ? "fp32" : "q8",
          device: engine,
          progress_callback: (info) => {
            if (info.status === "progress" && info.file.endsWith(".onnx")) {
              setProgress(`Downloading voice model: ${Math.round(info.progress)}%`);
            }
          },
        })) as unknown as Speaker;
        loadedEngine.current = engine;
        setProgress("");
        log(`MODEL READY in ${((performance.now() - began) / 1000).toFixed(1)}s`);
      }

      log(`RENDERING ${SENTENCES.length} sentences, voice = ${voice}`);
      const parts: Float32Array[] = [];
      let sampleRate = 24000;
      let renderSeconds = 0;
      let audioSeconds = 0;

      for (let i = 0; i < SENTENCES.length; i++) {
        setProgress(`Rendering sentence ${i + 1} of ${SENTENCES.length}`);
        // Let the screen update between sentences.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const began = performance.now();
        const result = await speaker.current.generate(SENTENCES[i], { voice });
        const took = (performance.now() - began) / 1000;
        const seconds = result.audio.length / result.sampling_rate;
        sampleRate = result.sampling_rate;
        parts.push(result.audio);
        renderSeconds += took;
        audioSeconds += seconds;
        if (i === 0) log(`FIRST SENTENCE ready after ${took.toFixed(1)}s`);
        log(`  ${i + 1}: ${seconds.toFixed(1)}s of audio in ${took.toFixed(1)}s`);
      }

      const speed = audioSeconds / renderSeconds;
      log(
        `DONE: ${audioSeconds.toFixed(1)}s of audio in ${renderSeconds.toFixed(1)}s ` +
          `= ${speed.toFixed(2)}x real time (above 1 is faster than listening)`,
      );
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(toWav(parts, sampleRate));
      });
    } catch (error) {
      log(`FAILED: ${(error as Error).name}: ${(error as Error).message}`);
    } finally {
      setProgress("");
      setBusy(false);
    }
  }, [engine, log, voice]);

  const copyLog = async () => {
    const text = ["Impartly voice test", navigator.userAgent, "", ...lines].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      log("Copy failed: select the log text and copy it by hand");
    }
  };

  const light = { background: "#faf9f5", color: "#1f1e1d" } as const;
  const choice = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" } as const;
  const box = { border: "1px solid #c9c6bc", borderRadius: 12, padding: 12, margin: "0 0 12px" } as const;

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px 48px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Impartly voice test</h1>
      <p style={{ margin: "0 0 16px", color: "#5c5a55" }}>
        Phase 0. Renders a sample briefing on this phone, with no server involved. Use Wi-Fi:
        the first run downloads the voice model. Keep the screen on while it works.
      </p>

      <fieldset style={box}>
        <legend style={{ fontWeight: 600, padding: "0 6px" }}>Voice</legend>
        {VOICES.map((option) => (
          <label key={option.id} style={choice}>
            <input
              type="radio"
              name="voice"
              checked={voice === option.id}
              onChange={() => setVoice(option.id)}
              style={{ width: 20, height: 20 }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <fieldset style={box}>
        <legend style={{ fontWeight: 600, padding: "0 6px" }}>Engine</legend>
        {ENGINES.map((option) => (
          <label key={option.id} style={choice}>
            <input
              type="radio"
              name="engine"
              checked={engine === option.id}
              onChange={() => setEngine(option.id)}
              style={{ width: 20, height: 20 }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <button
        onClick={() => void run()}
        disabled={busy}
        style={{
          width: "100%",
          padding: "18px 16px",
          fontSize: 18,
          fontWeight: 600,
          borderRadius: 14,
          border: "1px solid #1f1e1d",
          marginBottom: 12,
          background: "#1f1e1d",
          color: "#faf9f5",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Working..." : "Render the sample briefing"}
      </button>

      {progress && (
        <div role="status" style={{ padding: "12px 14px", borderRadius: 12, marginBottom: 12, background: "#eceae3", fontWeight: 600 }}>
          {progress}
        </div>
      )}

      {audioUrl && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Listen to the result</div>
          <audio src={audioUrl} controls playsInline style={{ width: "100%" }} />
        </div>
      )}

      <h2 style={{ fontSize: 18, margin: "20px 0 8px" }}>What to test</h2>
      <ol style={{ margin: 0, paddingLeft: 22, lineHeight: 1.5 }}>
        <li>Render with Heart on the Standard engine, then listen. Is the whole briefing there, start to finish?</li>
        <li>Switch to Daniel and render again. The model is already loaded, so this run shows the true speed.</li>
        <li>Optional: switch the engine to Graphics chip and render once more.</li>
        <li>Copy the log and send it over, with a word on how each voice sounds.</li>
      </ol>

      <div style={{ display: "flex", alignItems: "center", margin: "24px 0 8px" }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>Log</h2>
        <button
          onClick={() => void copyLog()}
          style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #1f1e1d", ...light }}
        >
          {copied ? "Copied" : "Copy log"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          minHeight: 120,
          maxHeight: 360,
          overflow: "auto",
          borderRadius: 12,
          background: "#1f1e1d",
          color: "#e8e6dc",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {lines.length ? lines.join("\n") : "Nothing yet."}
      </pre>

      <p style={{ marginTop: 20 }}>
        <Link href="/spike">Back to the audio test</Link>
      </p>
    </main>
  );
}
