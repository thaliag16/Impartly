"use client";

// The player screen (Player mockup, GOAL.md 1a). It renders any sentence audio not yet
// stored (render-ahead: Kokoro in a worker, Cache Storage), lays the clips out as one file
// for one <audio> element (lib/briefing/queue.ts says why), and drives it through the
// player controller (lib/briefing/player.ts): pause and resume in place, next and previous
// newsletter, 15-second skips, the current sentence in blush, and the lock screen.
//
// The mic rule (CLAUDE.md): Ask pauses the briefing, plays the Bell start cue, opens the
// mic, then closes it, plays the Bell end cue and resumes. While the mic is open nothing
// else plays: the controller refuses every play, and the transport is disabled. Answers
// are Phase 3; for now Ask only opens and closes the mic and records nothing.
//
// The voice and speed chips link to the listening settings (/settings/listening). Stored
// clips are keyed by text, voice and speed, so a new voice or speed renders the briefing
// again, and clips this briefing no longer needs are removed after each render.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createFakeRenderer } from "../../lib/briefing/fake-renderer";
import { BRIEFING_TITLE, createPlayer, type Player, type PlayerState } from "../../lib/briefing/player";
import { buildQueue, loadClips, waveformLevels, type Timeline } from "../../lib/briefing/queue";
import {
  cacheApiClipStore,
  memoryClipStore,
  pruneClips,
  renderAhead,
  scriptClipKeys,
  type RenderSentence,
} from "../../lib/briefing/render-ahead";
import type { BriefingScript } from "../../lib/briefing/script";
import { VOICE_LABELS } from "../../lib/briefing/settings";
import { createWorkerRenderer } from "../../lib/briefing/worker-renderer";
import type { BriefingVoice } from "../../lib/speech/pins";
import { buildCue } from "../spike/tone";

const LISTEN_SECONDS = 4;
const BARS = 40;
const CLIP_CACHE = "impartly-briefing-audio-v1";

type Phase =
  | { kind: "preparing"; done: number; total: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };


function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Pixel icons (GOAL.md 1a): whole-unit rects, crisp edges, text colour.
const Icon = ({ w, h, cells }: { w: number; h: number; cells: [number, number, number, number][] }) => (
  <svg className="px-icon" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
    {cells.map(([x, y, cw, ch], i) => (
      <rect key={i} x={x} y={y} width={cw} height={ch} />
    ))}
  </svg>
);
const BackIcon = () => <Icon w={8} h={8} cells={[[3, 0, 2, 2], [1, 2, 2, 2], [0, 3, 8, 2], [1, 4, 2, 2], [3, 6, 2, 2]]} />;
const PlayIcon = () => <Icon w={7} h={8} cells={[[0, 0, 2, 8], [2, 1, 2, 6], [4, 2, 2, 4], [6, 3, 1, 2]]} />;
const PauseIcon = () => <Icon w={6} h={7} cells={[[0, 0, 2, 7], [4, 0, 2, 7]]} />;
const PrevIcon = () => <Icon w={8} h={7} cells={[[0, 0, 1, 7], [5, 0, 1, 7], [4, 1, 1, 5], [3, 2, 1, 3], [2, 3, 1, 1], [7, 0, 1, 7], [6, 1, 1, 5]]} />;
const NextIcon = () => <Icon w={8} h={7} cells={[[7, 0, 1, 7], [2, 0, 1, 7], [3, 1, 1, 5], [4, 2, 1, 3], [5, 3, 1, 1], [0, 0, 1, 7], [1, 1, 1, 5]]} />;
const MicIcon = () => <Icon w={5} h={7} cells={[[1, 0, 3, 4], [0, 3, 1, 1], [4, 3, 1, 1], [1, 4, 3, 1], [2, 5, 1, 1], [1, 6, 3, 1]]} />;

export function PlayerView({
  script,
  voice,
  speed,
  fakeRenderer,
}: {
  script: BriefingScript;
  voice: BriefingVoice;
  speed: number;
  fakeRenderer: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startCueRef = useRef<HTMLAudioElement | null>(null);
  const endCueRef = useRef<HTMLAudioElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const unlocked = useRef(false);
  const asking = useRef(false);

  const [phase, setPhase] = useState<Phase>({ kind: "preparing", done: 0, total: script.sentences.length });
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [state, setState] = useState<PlayerState | null>(null);
  const [listening, setListening] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Render what is missing, build the queue, and attach the player.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const abort = new AbortController();
    let url: string | null = null;
    let disposeRenderer: () => void = () => undefined;

    (async () => {
      let render: RenderSentence;
      if (fakeRenderer) {
        render = createFakeRenderer({ delayMs: 5 }).render;
      } else {
        const renderer = createWorkerRenderer({});
        disposeRenderer = () => renderer.dispose();
        render = renderer.render;
      }
      const store = typeof caches !== "undefined" ? cacheApiClipStore(caches, CLIP_CACHE) : memoryClipStore();
      const subtle = crypto.subtle;
      await renderAhead(script, {
        voice,
        speed,
        store,
        render,
        subtle,
        signal: abort.signal,
        onProgress: (done, total) => setPhase({ kind: "preparing", done, total }),
      });
      disposeRenderer();
      // Clips of another voice or speed (or an older briefing) have other keys, so they are
      // never played; remove them so they do not fill the device's storage.
      await pruneClips(store, await scriptClipKeys(script, { voice, speed, subtle })).catch(() => 0);
      const clips = await loadClips(script, { store, subtle, voice, speed });
      const queue = buildQueue(script, clips);
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(new Blob([queue.wav], { type: "audio/wav" }));
      audio.src = url;
      setLevels(waveformLevels(queue, BARS));
      setTimeline(queue.timeline);
      const session = "mediaSession" in navigator ? navigator.mediaSession : null;
      const player = createPlayer({
        media: audio,
        timeline: queue.timeline,
        session,
        makeMetadata: typeof MediaMetadata !== "undefined" ? (init) => new MediaMetadata(init) : undefined,
        onChange: setState,
      });
      playerRef.current = player;
      setState(player.state());
      setPhase({ kind: "ready" });
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const stage = (error as { stage?: string }).stage;
      setPhase({
        kind: "error",
        message: `Could not prepare the audio${stage ? ` (${stage})` : ""}. Reload the page to try again.`,
      });
    });

    return () => {
      abort.abort();
      disposeRenderer();
      playerRef.current?.dispose();
      playerRef.current = null;
      audio.pause();
      audio.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
    };
  }, [script, voice, speed, fakeRenderer]);

  // The Bell cues, built in the browser.
  useEffect(() => {
    const urls = [URL.createObjectURL(buildCue("bell", true)), URL.createObjectURL(buildCue("bell", false))];
    if (startCueRef.current) startCueRef.current.src = urls[0];
    if (endCueRef.current) endCueRef.current.src = urls[1];
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  // Follow the clock every frame while playing, so the highlight keeps up.
  const playing = state?.status === "playing";
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      playerRef.current?.refresh();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Position for the time labels and the waveform (refreshed by the frames above).
  const [position, setPosition] = useState(0);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const update = () => setPosition(audio.currentTime);
    const events = ["timeupdate", "seeked", "pause", "play"];
    events.forEach((e) => audio.addEventListener(e, update));
    return () => events.forEach((e) => audio.removeEventListener(e, update));
  }, []);

  // iPhones only let a page start sound after a tap: play each cue silently once, during
  // the first Play tap, so they can sound later without one.
  const unlockCues = useCallback(() => {
    if (unlocked.current) return;
    unlocked.current = true;
    for (const element of [startCueRef.current, endCueRef.current]) {
      if (!element) continue;
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
    }
  }, []);

  const playCue = useCallback(
    (element: HTMLAudioElement | null) =>
      new Promise<void>((resolve) => {
        if (!element) return resolve();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          element.removeEventListener("ended", finish);
          resolve();
        };
        element.addEventListener("ended", finish);
        element.currentTime = 0;
        element.play().catch(finish);
        window.setTimeout(finish, 1500);
      }),
    [],
  );

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player || asking.current) return;
    unlockCues();
    void player.toggle().then((result) => {
      if (result === "failed") setNote("The browser blocked playback. Tap Play again.");
      else setNote(null);
    });
  }, [unlockCues]);

  const ask = useCallback(async () => {
    const player = playerRef.current;
    if (!player || asking.current) return;
    asking.current = true;
    setListening(LISTEN_SECONDS);
    setNote(null);
    player.micOpened();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setNote("The microphone is not available. Check the browser's permission for this site.");
      setListening(null);
      asking.current = false;
      await player.micClosed();
      return;
    }
    await playCue(startCueRef.current);
    for (let left = LISTEN_SECONDS; left > 0; left--) {
      setListening(left);
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    stream.getTracks().forEach((track) => track.stop());
    setListening(null);
    await playCue(endCueRef.current);
    asking.current = false;
    const result = await player.micClosed();
    if (result === "failed") setNote("The browser blocked playback. Tap Play again.");
  }, [playCue]);

  const ready = phase.kind === "ready" && timeline !== null && state !== null;
  const isListening = listening !== null;
  const sentence = ready ? state.sentence : 0;
  const section = ready ? state.section : null;
  const title = section === null || !timeline ? BRIEFING_TITLE : timeline.sections[section].title;
  const duration = timeline?.duration ?? 0;
  const played = duration > 0 ? Math.min(1, position / duration) : 0;
  const sentences = timeline?.sentences ?? [];
  const where =
    !timeline || timeline.sections.length === 0
      ? ""
      : section === null
        ? position < (timeline.sections[0]?.start ?? 0)
          ? "Intro"
          : "Outro"
        : `${section + 1} of ${timeline.sections.length}`;
  const controlsOff = !ready || isListening;

  return (
    <main className="px-page px-player">
      <header className="px-header">
        <Link href="/" className="px-btn px-btn-quiet px-square" aria-label="Back to home">
          <BackIcon />
        </Link>
        <span className="px-label" data-testid="where">
          {ready ? `${where}${where ? " · " : ""}${clock(duration - position)} left` : ""}
        </span>
      </header>

      <div className="px-field">
        <span className="px-label px-muted">Now playing</span>
        <h1 className="px-h1" data-testid="now-playing">
          {title}
        </h1>
      </div>

      <div className="px-card px-lines" aria-live="off">
        {ready ? (
          [sentence - 1, sentence, sentence + 1]
            .filter((i) => i >= 0 && i < sentences.length)
            .map((i) =>
              i === sentence ? (
                <p
                  key={i}
                  className="px-line px-line-current"
                  data-testid="current-sentence"
                  data-index={i}
                  data-start={sentences[i].start}
                  data-end={sentences[i].end}
                  aria-current="true"
                >
                  {sentences[i].text}
                </p>
              ) : (
                <p key={i} className="px-line px-muted">
                  {sentences[i].text}
                </p>
              ),
            )
        ) : (
          <p className="px-line px-muted">Your briefing will show here, a sentence at a time.</p>
        )}
      </div>

      <div className="px-field">
        <div
          className="px-wave"
          role="progressbar"
          aria-label="Briefing progress"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${clock(position)} of ${clock(duration)}`}
        >
          {(levels.length ? levels : Array.from({ length: BARS }, () => 0.15)).map((level, i) => (
            <span
              key={i}
              className={(i + 0.5) / BARS <= played ? "px-bar px-bar-played" : "px-bar"}
              style={{ height: `${Math.round(8 + level * 40)}px` }}
            />
          ))}
        </div>
        <div className="px-header px-label">
          <span data-testid="position">{clock(position)}</span>
          <span>{clock(duration)}</span>
        </div>
      </div>

      <Link href="/settings/listening" className="px-row px-chip-link" data-testid="voice-speed-link">
        <span className="px-chips">
          {(Object.keys(VOICE_LABELS) as BriefingVoice[]).map((v) => (
            <span key={v} className={v === voice ? "px-chip px-chip-on" : "px-chip"} data-testid={v === voice ? "voice" : undefined}>
              {VOICE_LABELS[v]}
              {v === voice ? <span className="px-visually-hidden"> (voice in use)</span> : null}
            </span>
          ))}
        </span>
        <span className="px-chip px-chips" data-testid="speed">
          {speed.toFixed(2)}x
        </span>
        <span className="px-visually-hidden">Change voice and speed in settings</span>
      </Link>

      <div className="px-transport">
        <button type="button" className="px-btn" onClick={() => playerRef.current?.previousNewsletter()} disabled={controlsOff}>
          <PrevIcon />
          <span className="px-visually-hidden">Previous newsletter</span>
        </button>
        <button type="button" className="px-btn" onClick={() => playerRef.current?.seekBy(-15)} disabled={controlsOff}>
          -15s<span className="px-visually-hidden"> back</span>
        </button>
        <button type="button" className="px-btn" onClick={() => playerRef.current?.seekBy(15)} disabled={controlsOff}>
          +15s<span className="px-visually-hidden"> forward</span>
        </button>
        <button type="button" className="px-btn" onClick={() => playerRef.current?.nextNewsletter()} disabled={controlsOff}>
          <NextIcon />
          <span className="px-visually-hidden">Next newsletter</span>
        </button>
      </div>

      <div className="px-player-main">
        <button type="button" className="px-play" onClick={toggle} disabled={controlsOff}>
          {playing ? <PauseIcon /> : <PlayIcon />}
          <span className="px-visually-hidden">{playing ? "Pause" : "Play"}</span>
        </button>
        <button type="button" className="px-btn px-btn-primary px-ask" onClick={() => void ask()} disabled={controlsOff}>
          <MicIcon />
          Ask
        </button>
      </div>

      <p className="px-body px-muted" role="status" data-testid="player-status">
        {phase.kind === "preparing"
          ? `Preparing audio: ${phase.done} of ${phase.total} sentences.`
          : phase.kind === "error"
            ? ""
            : isListening
              ? `Listening: ${listening} s. Answers come in a later update; nothing is recorded.`
              : (note ?? (playing ? "Playing" : state?.status === "ended" ? "Finished" : "Paused"))}
      </p>
      {phase.kind === "error" ? (
        <p className="px-alert" role="alert">
          {phase.message}
        </p>
      ) : null}

      <audio ref={audioRef} data-testid="briefing-audio" playsInline preload="auto" />
      <audio ref={startCueRef} data-testid="cue-start" playsInline preload="auto" />
      <audio ref={endCueRef} data-testid="cue-end" playsInline preload="auto" />
    </main>
  );
}
