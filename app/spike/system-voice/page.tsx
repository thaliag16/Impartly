"use client";

// Phase 0 test: the phone's built-in voices (the browser's speech synthesis).
// They are free and need no model download. This page checks how they sound and
// whether they keep speaking with the phone locked or respond to AirPods.

import { useCallback, useEffect, useRef, useState } from "react";

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

const SENTENCES = SAMPLE.match(/[^.!?]+[.!?]+/g)?.map((sentence) => sentence.trim()) ?? [SAMPLE];

export default function SystemVoiceTest() {
  const startedAt = useRef(0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState("");
  const [rate, setRate] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const log = useCallback((message: string) => {
    if (!startedAt.current) startedAt.current = performance.now();
    const elapsed = ((performance.now() - startedAt.current) / 1000).toFixed(1);
    setLines((previous) => [...previous, `${elapsed.padStart(6)}s  ${message}`]);
  }, []);

  useEffect(() => {
    if (!("speechSynthesis" in window)) {
      log("This browser has no built-in speech.");
      return;
    }
    const load = () => {
      const english = window.speechSynthesis
        .getVoices()
        .filter((voice) => voice.lang.toLowerCase().startsWith("en"))
        .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
      if (!english.length) return;
      setVoices(english);
      setVoiceName((current) => current || english.find((voice) => voice.default)?.name || english[0].name);
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    const onVisibility = () => log(`page: ${document.visibilityState}`);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      document.removeEventListener("visibilitychange", onVisibility);
      window.speechSynthesis.cancel();
    };
  }, [log]);

  const speak = () => {
    const synth = window.speechSynthesis;
    synth.cancel();
    const voice = voices.find((item) => item.name === voiceName);
    log(`SPEAKING ${SENTENCES.length} sentences, voice = ${voice?.name ?? "default"} (${voice?.lang ?? "?"}), speed = ${rate}`);
    setSpeaking(true);
    setPaused(false);
    SENTENCES.forEach((sentence, index) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.onstart = () => log(`  ${index + 1} started`);
      utterance.onerror = (event) => log(`  ${index + 1} ERROR: ${event.error}`);
      utterance.onend = () => {
        log(`  ${index + 1} ended`);
        if (index === SENTENCES.length - 1) {
          log("DONE");
          setSpeaking(false);
        }
      };
      synth.speak(utterance);
    });
  };

  const togglePause = () => {
    const synth = window.speechSynthesis;
    if (paused) {
      synth.resume();
      log("SCREEN: resume");
    } else {
      synth.pause();
      log("SCREEN: pause");
    }
    setPaused(!paused);
  };

  const stop = () => {
    window.speechSynthesis.cancel();
    log("SCREEN: stop");
    setSpeaking(false);
    setPaused(false);
  };

  const copyLog = async () => {
    const list = voices.map((voice) => `${voice.name} (${voice.lang})`).join(", ");
    const text = ["Impartly built-in voice test", navigator.userAgent, `Voices offered: ${list}`, "", ...lines].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      log("Copy failed: select the log text and copy it by hand");
    }
  };

  const light = { background: "#faf9f5", color: "#1f1e1d" } as const;
  const dark = { background: "#1f1e1d", color: "#faf9f5" } as const;
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
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Impartly built-in voice test</h1>
      <p style={{ margin: "0 0 16px", color: "#5c5a55" }}>
        Phase 0. Uses the voices already on this phone. Nothing to download.
      </p>

      <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }} htmlFor="voice">
        Voice ({voices.length} English voices offered)
      </label>
      <select
        id="voice"
        value={voiceName}
        onChange={(event) => setVoiceName(event.target.value)}
        style={{ width: "100%", padding: 12, fontSize: 16, borderRadius: 10, marginBottom: 16 }}
      >
        {voices.map((voice) => (
          <option key={`${voice.name}-${voice.lang}`} value={voice.name}>
            {voice.name} ({voice.lang})
          </option>
        ))}
      </select>

      <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }} htmlFor="rate">
        Speed: {rate.toFixed(1)}
      </label>
      <input
        id="rate"
        type="range"
        min={0.7}
        max={1.6}
        step={0.1}
        value={rate}
        onChange={(event) => setRate(Number(event.target.value))}
        style={{ width: "100%", marginBottom: 16 }}
      />

      {speaking ? (
        <>
          <button onClick={togglePause} style={{ ...bigButton, ...dark }}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button onClick={stop} style={{ ...bigButton, ...light }}>
            Stop
          </button>
        </>
      ) : (
        <button onClick={speak} style={{ ...bigButton, ...dark }}>
          Speak the sample briefing
        </button>
      )}

      <h2 style={{ fontSize: 18, margin: "20px 0 8px" }}>What to test</h2>
      <ol style={{ margin: 0, paddingLeft: 22, lineHeight: 1.5 }}>
        <li>Speak the sample with a few different voices. Is any of them one you would listen to daily?</li>
        <li>Is it coming through your AirPods, or the phone speaker?</li>
        <li>While it is speaking, lock the phone. Does it keep going, or stop?</li>
        <li>While it is speaking, press your AirPods. Does anything happen?</li>
        <li>Copy the log and send it over.</li>
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
        <a href="/spike/voice">Back to the Kokoro voice test</a>
      </p>
    </main>
  );
}
