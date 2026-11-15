"use client";

// Phase 0 test: can Kokoro render the briefing's voice on the phone itself?
// Rendering on Vercel's free plan was about 3x slower than real time and too
// CPU-hungry, so this measures the free alternative: the listener's own device.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerReply, WorkerRequest } from "./worker";

const VOICES = [
  { id: "af_heart", label: "Heart (American, female)" },
  { id: "bm_daniel", label: "Daniel (British, male)" },
] as const;
type VoiceId = (typeof VOICES)[number]["id"];

const ENGINES = [
  { id: "wasm-1", label: "Standard, 1 thread (slowest, most reliable)", device: "wasm", threads: 1 },
  { id: "wasm-4", label: "Standard, 4 threads", device: "wasm", threads: 4 },
  { id: "webgpu", label: "Graphics chip (bigger download)", device: "webgpu", threads: 1 },
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
  const worker = useRef<Worker | null>(null);
  const loadedEngine = useRef<EngineId | null>(null);
  const startedAt = useRef(0);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<string[]>([]);
  const playing = useRef(false);
  const waitingSince = useRef(0);
  const parts = useRef<Float32Array[]>([]);
  const totals = useRef({ render: 0, audio: 0, sampleRate: 24000 });

  const [engine, setEngine] = useState<EngineId>("wasm-1");
  const [voice, setVoice] = useState<VoiceId>("af_heart");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [waited, setWaited] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const log = useCallback((message: string) => {
    if (!startedAt.current) startedAt.current = performance.now();
    const elapsed = ((performance.now() - startedAt.current) / 1000).toFixed(1);
    setLines((previous) => [...previous, `${elapsed.padStart(6)}s  ${message}`]);
  }, []);

  // Plays finished sentences in order, starting as soon as the first is ready.
  const playNext = useCallback(() => {
    const player = playerRef.current;
    const next = queue.current.shift();
    if (!player || !next) {
      playing.current = false;
      return;
    }
    playing.current = true;
    player.src = next;
    player.play().catch((error: Error) => {
      playing.current = false;
      log(`PLAYBACK BLOCKED: ${error.name}. Use the player below instead.`);
    });
  }, [log]);

  // A visible clock, so a long silence is clearly "still working" and not a crash.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      setWaited(Math.round((performance.now() - waitingSince.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const send = (request: WorkerRequest) => worker.current?.postMessage(request);

  const startRender = useCallback(() => {
    parts.current = [];
    totals.current = { render: 0, audio: 0, sampleRate: 24000 };
    log(`RENDERING ${SENTENCES.length} sentences, voice = ${voice}`);
    send({ type: "render", sentences: SENTENCES, voice });
  }, [log, voice]);

  const handleReply = useCallback(
    (reply: WorkerReply) => {
      waitingSince.current = performance.now();
      if (reply.type === "log") log(reply.message);
      if (reply.type === "progress") setProgress(reply.message);
      if (reply.type === "ready") {
        log(`MODEL READY in ${reply.seconds.toFixed(1)}s`);
        startRender();
      }
      if (reply.type === "sentence") {
        const audioSeconds = reply.audio.length / reply.sampleRate;
        totals.current.render += reply.seconds;
        totals.current.audio += audioSeconds;
        totals.current.sampleRate = reply.sampleRate;
        parts.current.push(reply.audio);
        if (reply.index === 0) log(`FIRST SENTENCE ready after ${reply.seconds.toFixed(1)}s`);
        log(`  ${reply.index + 1}: ${audioSeconds.toFixed(1)}s of audio in ${reply.seconds.toFixed(1)}s`);
        queue.current.push(URL.createObjectURL(toWav([reply.audio], reply.sampleRate)));
        if (!playing.current) playNext();
      }
      if (reply.type === "done") {
        const { render, audio, sampleRate } = totals.current;
        log(
          `DONE: ${audio.toFixed(1)}s of audio in ${render.toFixed(1)}s ` +
            `= ${(audio / render).toFixed(2)}x real time (above 1 is faster than listening)`,
        );
        setAudioUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(toWav(parts.current, sampleRate));
        });
        setProgress("");
        setBusy(false);
      }
      if (reply.type === "error") {
        log(`FAILED: ${reply.message}`);
        setProgress("");
        setBusy(false);
      }
    },
    [log, playNext, startRender],
  );

  // The worker outlives re-renders, so route its messages through a ref that
  // always points at the latest handler.
  const latestHandler = useRef(handleReply);
  useEffect(() => {
    latestHandler.current = handleReply;
  }, [handleReply]);

  const run = useCallback(() => {
    setBusy(true);
    setWaited(0);
    waitingSince.current = performance.now();
    queue.current = [];

    // Unlock the player during this tap so sentences can start by themselves later.
    const player = playerRef.current;
    if (player) {
      player.muted = true;
      void player
        .play()
        .catch(() => undefined)
        .finally(() => {
          player.pause();
          player.muted = false;
        });
    }

    const choice = ENGINES.find((item) => item.id === engine) ?? ENGINES[0];
    if (!worker.current || loadedEngine.current !== engine) {
      worker.current?.terminate();
      const created = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      created.addEventListener("message", (event: MessageEvent<WorkerReply>) =>
        latestHandler.current(event.data),
      );
      created.addEventListener("error", (event) => {
        log(`WORKER CRASHED: ${event.message || "no details given"}`);
        setProgress("");
        setBusy(false);
      });
      worker.current = created;
      loadedEngine.current = engine;
      const threads = self.crossOriginIsolated ? choice.threads : 1;
      log(`LOADING model: ${choice.label}`);
      send({ type: "load", device: choice.device, threads });
    } else {
      startRender();
    }
  }, [engine, log, startRender]);

  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    loadedEngine.current = null;
    log(`STOPPED by you after waiting ${waited}s on the current step`);
    setProgress("");
    setBusy(false);
  };

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
  const choiceRow = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" } as const;
  const box = { border: "1px solid #c9c6bc", borderRadius: 12, padding: 12, margin: "0 0 12px" } as const;
  const bigButton = {
    width: "100%",
    padding: "18px 16px",
    fontSize: 18,
    fontWeight: 600,
    borderRadius: 14,
    border: "1px solid #1f1e1d",
    marginBottom: 12,
  } as const;

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px 48px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Impartly voice test</h1>
      <p style={{ margin: "0 0 16px", color: "#5c5a55" }}>
        Phase 0. Renders a sample briefing on this phone, with no server involved. Use Wi-Fi:
        the first run downloads the voice model. Keep the screen on while it works.
      </p>

      <fieldset style={box} disabled={busy}>
        <legend style={{ fontWeight: 600, padding: "0 6px" }}>Voice</legend>
        {VOICES.map((option) => (
          <label key={option.id} style={choiceRow}>
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

      <fieldset style={box} disabled={busy}>
        <legend style={{ fontWeight: 600, padding: "0 6px" }}>Engine</legend>
        {ENGINES.map((option) => (
          <label key={option.id} style={choiceRow}>
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

      {busy ? (
        <button onClick={stop} style={{ ...bigButton, ...light }}>
          Stop
        </button>
      ) : (
        <button onClick={run} style={{ ...bigButton, background: "#1f1e1d", color: "#faf9f5" }}>
          Render the sample briefing
        </button>
      )}

      {busy && (
        <div role="status" style={{ padding: "12px 14px", borderRadius: 12, marginBottom: 12, background: "#eceae3", fontWeight: 600 }}>
          {progress || "Starting"} ({waited}s on this step)
        </div>
      )}

      <audio ref={playerRef} playsInline onEnded={playNext} />

      {audioUrl && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Listen again, start to finish</div>
          <audio src={audioUrl} controls playsInline style={{ width: "100%" }} />
        </div>
      )}

      <h2 style={{ fontSize: 18, margin: "20px 0 8px" }}>What to test</h2>
      <ol style={{ margin: 0, paddingLeft: 22, lineHeight: 1.5 }}>
        <li>
          Render with Heart on &quot;Standard, 1 thread&quot;. Speech should start by itself once
          the first sentence is ready. Watch the seconds counter: if one step passes 60 seconds,
          press Stop.
        </li>
        <li>Then try &quot;Standard, 4 threads&quot;. Does it render, and is it faster?</li>
        <li>Switch to Daniel and render again to hear the second voice.</li>
        <li>Optional: try the graphics chip engine.</li>
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
