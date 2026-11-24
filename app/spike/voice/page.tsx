"use client";

// Phase 0 test: can Kokoro render the briefing's voice on the phone itself?
// Rendering on Vercel's free plan was about 3x slower than real time and too
// CPU-hungry, so this measures the free alternative: the listener's own device.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { renderAhead, type AudioClip, type ClipStore } from "../../../lib/briefing/render-ahead";
import type { BriefingScript } from "../../../lib/briefing/script";
import { createWorkerRenderer, type RendererEvent, type WorkerRenderer } from "../../../lib/briefing/worker-renderer";
import { splitSentences } from "../../../lib/speech/sentences";
import { encodeWav } from "../../../lib/speech/wav";

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
const SENTENCES = splitSentences(SAMPLE);
// The sample as a briefing script, so this page renders through the briefing's own path:
// render-ahead and the shared Kokoro worker renderer (lib/briefing/).
const SCRIPT: BriefingScript = {
  sentences: SENTENCES.map((text, index) => ({ index, kind: "summary", text, section: null, itemId: null })),
  sections: [],
  storyCount: 0,
};

function toWav(parts: Float32Array[], sampleRate: number): Blob {
  return new Blob([encodeWav(parts, sampleRate)], { type: "audio/wav" });
}

export default function VoiceTest() {
  const renderer = useRef<WorkerRenderer | null>(null);
  const loadedEngine = useRef<EngineId | null>(null);
  const run$ = useRef<AbortController | null>(null);
  const startedAt = useRef(0);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<string[]>([]);
  const playing = useRef(false);
  const waitingSince = useRef(0);
  const parts = useRef<Float32Array[]>([]);

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

  const onEvent = useCallback(
    (event: RendererEvent) => {
      waitingSince.current = performance.now();
      if (event.type === "log") log(event.message);
      if (event.type === "progress") setProgress(event.message);
      if (event.type === "ready") log(`MODEL READY in ${event.seconds.toFixed(1)}s`);
    },
    [log],
  );
  // The renderer outlives re-renders, so route its events through a ref that always
  // points at the latest handler.
  const latestOnEvent = useRef(onEvent);
  useEffect(() => {
    latestOnEvent.current = onEvent;
  }, [onEvent]);

  useEffect(() => () => renderer.current?.dispose(), []);

  const run = useCallback(async () => {
    setBusy(true);
    setWaited(0);
    waitingSince.current = performance.now();
    queue.current = [];
    parts.current = [];

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
    if (!renderer.current || loadedEngine.current !== engine) {
      renderer.current?.dispose();
      const threads = self.crossOriginIsolated ? choice.threads : 1;
      renderer.current = createWorkerRenderer({
        device: choice.device,
        threads,
        onEvent: (event) => latestOnEvent.current(event),
      });
      loadedEngine.current = engine;
      log(`LOADING model: ${choice.label}`);
    }
    const controller = new AbortController();
    run$.current = controller;

    // Each sentence plays as soon as render-ahead stores it.
    let sampleRate = 24000;
    let index = 0;
    const store: ClipStore = {
      get: async () => undefined, // always render, so the timings are measured
      put: async (_key: string, clip: AudioClip) => {
        sampleRate = clip.sampleRate;
        parts.current.push(clip.samples);
        queue.current.push(URL.createObjectURL(toWav([clip.samples], clip.sampleRate)));
        if (!playing.current) playNext();
      },
    };
    const current = renderer.current;
    try {
      await current.load();
      log(`RENDERING ${SENTENCES.length} sentences, voice = ${voice}`);
      const report = await renderAhead(SCRIPT, {
        voice,
        speed: 1,
        store,
        render: async (text, chosen, speed, signal) => {
          const result = await current.render(text, chosen, speed, signal);
          const audioSeconds = result.clip.samples.length / result.clip.sampleRate;
          if (index === 0) log(`FIRST SENTENCE ready after ${result.seconds.toFixed(1)}s`);
          log(`  ${index + 1}: ${audioSeconds.toFixed(1)}s of audio in ${result.seconds.toFixed(1)}s`);
          index++;
          return result;
        },
        subtle: crypto.subtle,
        signal: controller.signal,
        onProgress: (done, total) => {
          waitingSince.current = performance.now();
          if (done < total) setProgress(`Rendering sentence ${done + 1} of ${total}`);
        },
      });
      log(
        `DONE: ${report.audioSeconds.toFixed(1)}s of audio in ${report.renderSeconds.toFixed(1)}s ` +
          `= ${(report.audioSeconds / report.renderSeconds).toFixed(2)}x real time (above 1 is faster than listening)`,
      );
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(toWav(parts.current, sampleRate));
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const stage = (error as { stage?: string }).stage;
      log(`FAILED${stage ? ` (${stage})` : ""}: ${(error as Error).message}`);
      if (stage === "worker" || stage === "runtime" || stage === "model") {
        renderer.current?.dispose();
        renderer.current = null;
        loadedEngine.current = null;
      }
    } finally {
      if (run$.current === controller) {
        run$.current = null;
        setProgress("");
        setBusy(false);
      }
    }
  }, [engine, log, playNext, voice]);

  const stop = () => {
    run$.current?.abort();
    run$.current = null;
    renderer.current?.dispose();
    renderer.current = null;
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
        <button onClick={() => void run()} style={{ ...bigButton, background: "#1f1e1d", color: "#faf9f5" }}>
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
