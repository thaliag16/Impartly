"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildCue, buildTestTrack, CUE_LABELS, type CueSound } from "./tone";

type Status = "idle" | "playing" | "paused" | "listening";

const RECORD_SECONDS = 5;
const REWIND_SECONDS = 3;
const CUE_SOUNDS: CueSound[] = ["pop", "bell", "knock"];

const TESTS = [
  "Press Start. In AirPods, notes should hop between your left and right ear and sound clear.",
  "Press Pause, then Play. Playback should stop and pick up where it left off.",
  "Try the three cue sounds with their Preview buttons and keep the one you like.",
  "Press Tap to ask, wait for the cue, then speak for 5 seconds. Did you hear the cue in your AirPods?",
  "After it resumes, is the sound as clear and as left/right as in test 1?",
  "Tick the AirPods option, then pause from your AirPods. Did you hear the cue before speaking?",
  "Lock the phone and pause from your AirPods. Wait 10 seconds, unlock, and check the log: did MIC OPEN appear before or after 'page: visible'?",
];

export default function Spike() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startCueRef = useRef<HTMLAudioElement | null>(null);
  const endCueRef = useRef<HTMLAudioElement | null>(null);
  const cueUrls = useRef<string[]>([]);
  const savedPosition = useRef(0);
  const busy = useRef(false);
  const airpodsOpensMic = useRef(false);
  const startedAt = useRef<number>(0);

  const [status, setStatus] = useState<Status>("idle");
  const [countdown, setCountdown] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [airpodsOption, setAirpodsOption] = useState(false);
  const [cueSound, setCueSound] = useState<CueSound>("bell");
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const log = useCallback((message: string) => {
    if (!startedAt.current) startedAt.current = performance.now();
    const elapsed = ((performance.now() - startedAt.current) / 1000).toFixed(2);
    setLines((previous) => [...previous, `${elapsed.padStart(7)}s  ${message}`]);
  }, []);

  // Load the chosen cue into its two audio elements.
  useEffect(() => {
    const startCue = startCueRef.current;
    const endCue = endCueRef.current;
    if (!startCue || !endCue) return;
    cueUrls.current.forEach((url) => URL.revokeObjectURL(url));
    const startUrl = URL.createObjectURL(buildCue(cueSound, true));
    const endUrl = URL.createObjectURL(buildCue(cueSound, false));
    cueUrls.current = [startUrl, endUrl];
    startCue.src = startUrl;
    endCue.src = endUrl;
  }, [cueSound]);

  // Plays a cue and waits for it to finish, so recording never contains the cue.
  const playCue = useCallback(
    (element: HTMLAudioElement | null, name: string) =>
      new Promise<void>((resolve) => {
        if (!element) {
          resolve();
          return;
        }
        let settled = false;
        const finish = (outcome: string) => {
          if (settled) return;
          settled = true;
          element.removeEventListener("ended", onEnded);
          log(`CUE ${name}: ${outcome}`);
          resolve();
        };
        const onEnded = () => finish("played to the end");
        element.addEventListener("ended", onEnded);
        element.currentTime = 0;
        element
          .play()
          .catch((error: Error) => finish(`BLOCKED (${error.name})`));
        window.setTimeout(() => finish("timed out, no 'ended' event"), 1500);
      }),
    [log],
  );

  const ask = useCallback(
    async (trigger: string) => {
      const audio = audioRef.current;
      if (!audio || busy.current) return;
      busy.current = true;

      // Rule: no briefing audio plays while the mic is open.
      audio.pause();
      savedPosition.current = audio.currentTime;
      log(`ASK (${trigger}): paused at ${audio.currentTime.toFixed(1)}s, opening mic`);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        log(`MIC FAILED: ${(error as Error).name}: ${(error as Error).message}`);
        busy.current = false;
        setStatus("paused");
        return;
      }

      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      log(
        `MIC OPEN: "${track.label}" ${settings.sampleRate ?? "?"} Hz, ` +
          `${settings.channelCount ?? "?"} ch, echo cancel ${settings.echoCancellation ?? "?"}`,
      );
      track.addEventListener("ended", () => log("MIC TRACK ENDED by the system"));

      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((item) => item.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType });
        log(`MIC CLOSED: recorded ${(blob.size / 1024).toFixed(0)} KB as ${recorder.mimeType}`);
        setRecordingUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(blob);
        });

        void playCue(endCueRef.current, "end").then(() => {
          audio.currentTime = Math.max(0, savedPosition.current - REWIND_SECONDS);
          audio
            .play()
            .then(() => log(`RESUMED at ${audio.currentTime.toFixed(1)}s without a tap`))
            .catch((error: Error) => {
              log(`RESUME BLOCKED: ${error.name}. Press Play to continue.`);
              setStatus("paused");
            })
            .finally(() => {
              busy.current = false;
            });
        });
      });

      // Cue first, then record: the speaker knows the mic is live and the cue
      // stays out of the recording.
      await playCue(startCueRef.current, "start");
      setStatus("listening");
      recorder.start();
      let remaining = RECORD_SECONDS;
      setCountdown(remaining);
      const timer = window.setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);
        if (remaining <= 0) {
          window.clearInterval(timer);
          if (recorder.state !== "inactive") recorder.stop();
        }
      }, 1000);
    },
    [log, playCue],
  );

  // iPhones only let a page start sound after a tap. Playing each cue silently
  // during the Start tap lets them sound later without one.
  const unlockCues = useCallback(() => {
    [startCueRef.current, endCueRef.current].forEach((element) => {
      if (!element) return;
      element.muted = true;
      element
        .play()
        .then(() => {
          element.pause();
          element.currentTime = 0;
        })
        .catch(() => undefined)
        .finally(() => {
          element.muted = false;
        });
    });
  }, []);

  const start = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.src) {
      audio.src = URL.createObjectURL(buildTestTrack());
      audio.loop = true;
      unlockCues();
      log("Test track built in the browser (stereo, 44.1 kHz)");
    }
    try {
      await audio.play();
    } catch (error) {
      log(`PLAY FAILED: ${(error as Error).name}: ${(error as Error).message}`);
      return;
    }

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Audio test",
        artist: "Impartly",
        album: "Phase 0",
      });
      navigator.mediaSession.setActionHandler("play", () => {
        log("HEADPHONE or LOCK SCREEN: play");
        void audio.play();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        log(`HEADPHONE or LOCK SCREEN: pause (page ${document.visibilityState})`);
        if (airpodsOpensMic.current) {
          void ask("headphone press");
        } else {
          audio.pause();
        }
      });
      navigator.mediaSession.setActionHandler("nexttrack", () =>
        log("HEADPHONE or LOCK SCREEN: next track"),
      );
      navigator.mediaSession.setActionHandler("previoustrack", () =>
        log("HEADPHONE or LOCK SCREEN: previous track"),
      );
    } else {
      log("This browser has no lock-screen media controls");
    }
  }, [ask, log, unlockCues]);

  const pause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    log("SCREEN: pause button");
    audio.pause();
  }, [log]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlaying = () => {
      setStatus("playing");
      log("audio: playing");
    };
    const onPause = () => {
      setStatus((current) => (current === "listening" ? current : "paused"));
      log("audio: paused");
    };
    const onWaiting = () => log("audio: waiting (buffer stall)");
    const onStalled = () => log("audio: stalled");
    const onError = () => log(`audio: ERROR code ${audio.error?.code ?? "?"}`);
    const onVisibility = () => log(`page: ${document.visibilityState}`);
    const onDevices = () => log("devices: audio route changed");

    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("stalled", onStalled);
    audio.addEventListener("error", onError);
    document.addEventListener("visibilitychange", onVisibility);
    navigator.mediaDevices?.addEventListener("devicechange", onDevices);

    return () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("stalled", onStalled);
      audio.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.mediaDevices?.removeEventListener("devicechange", onDevices);
    };
  }, [log]);

  const copyLog = async () => {
    const text = [
      "Impartly audio test",
      navigator.userAgent,
      `Cue sound: ${CUE_LABELS[cueSound]}`,
      "",
      ...lines,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      log("Copy failed: select the log text and copy it by hand");
    }
  };

  const statusText: Record<Status, string> = {
    idle: "Not started",
    playing: "Playing",
    paused: "Paused",
    listening: `Listening: ${countdown}s left. Speak now.`,
  };

  const button = {
    width: "100%",
    padding: "18px 16px",
    fontSize: 18,
    fontWeight: 600,
    borderRadius: 14,
    border: "1px solid #1f1e1d",
    marginBottom: 12,
  } as const;
  const light = { background: "#faf9f5", color: "#1f1e1d" } as const;
  const dark = { background: "#1f1e1d", color: "#faf9f5" } as const;

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px 48px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Impartly audio test</h1>
      <p style={{ margin: "0 0 16px", color: "#5c5a55" }}>
        Phase 0. Put your AirPods in, then work down the list.
      </p>

      <div
        role="status"
        style={{
          padding: "12px 14px",
          borderRadius: 12,
          marginBottom: 16,
          fontWeight: 600,
          background: status === "listening" ? "#fde8e4" : "#eceae3",
        }}
      >
        {statusText[status]}
      </div>

      {status === "playing" ? (
        <button onClick={pause} style={{ ...button, ...dark }}>
          Pause
        </button>
      ) : (
        <button
          onClick={() => void start()}
          disabled={status === "listening"}
          style={{ ...button, ...dark }}
        >
          {status === "idle" ? "Start" : "Play"}
        </button>
      )}
      <button
        onClick={() => void ask("screen tap")}
        disabled={status !== "playing"}
        style={{ ...button, ...light }}
      >
        Tap to ask (records {RECORD_SECONDS} seconds)
      </button>

      <fieldset style={{ border: "1px solid #c9c6bc", borderRadius: 12, padding: 12, margin: "4px 0 12px" }}>
        <legend style={{ fontWeight: 600, padding: "0 6px" }}>Cue sound</legend>
        {CUE_SOUNDS.map((sound) => (
          <div key={sound} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
              <input
                type="radio"
                name="cue"
                checked={cueSound === sound}
                onChange={() => {
                  setCueSound(sound);
                  log(`Option: cue sound = ${CUE_LABELS[sound]}`);
                }}
                style={{ width: 20, height: 20 }}
              />
              <span>{CUE_LABELS[sound]}</span>
            </label>
            <button
              onClick={() => {
                const preview = new Audio(URL.createObjectURL(buildCue(sound, true)));
                void preview.play();
              }}
              style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #1f1e1d", ...light }}
            >
              Preview
            </button>
          </div>
        ))}
      </fieldset>

      <label style={{ display: "flex", gap: 10, alignItems: "center", margin: "4px 0 16px" }}>
        <input
          type="checkbox"
          checked={airpodsOption}
          onChange={(event) => {
            setAirpodsOption(event.target.checked);
            airpodsOpensMic.current = event.target.checked;
            log(`Option: AirPods pause opens the mic = ${event.target.checked}`);
          }}
          style={{ width: 22, height: 22 }}
        />
        <span>Pausing from AirPods opens the mic</span>
      </label>

      <audio ref={audioRef} playsInline preload="auto" />
      <audio ref={startCueRef} playsInline preload="auto" />
      <audio ref={endCueRef} playsInline preload="auto" />

      {recordingUrl && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Play my recording</div>
          <audio src={recordingUrl} controls playsInline style={{ width: "100%" }} />
        </div>
      )}

      <h2 style={{ fontSize: 18, margin: "20px 0 8px" }}>What to test</h2>
      <ol style={{ margin: 0, paddingLeft: 22, lineHeight: 1.5 }}>
        {TESTS.map((test) => (
          <li key={test} style={{ marginBottom: 6 }}>
            {test}
          </li>
        ))}
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
        {lines.length ? lines.join("\n") : "Nothing yet. Press Start."}
      </pre>

      <p style={{ marginTop: 20 }}>
        <a href="/spike/voice">Next: the voice test</a>
      </p>
    </main>
  );
}
