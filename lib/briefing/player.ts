// The briefing player: one <audio> element playing the queue's single file
// (lib/briefing/queue.ts explains why one element and one file), plus everything around
// it: pause and resume in place, next and previous newsletter, 15-second skips, the
// sentence to highlight, and the Media Session (lock screen, AirPods and car controls:
// metadata, play, pause, next and previous track, seek back, forward and to, and position).
//
// The mic rule (CLAUDE.md): no briefing audio plays while the mic is open. micOpened()
// pauses and blocks every way to play (screen, lock screen, headphones) until micClosed();
// if anything starts the element anyway, it is paused at once. The start and end cue
// sounds are separate elements, owned by the page.
//
// No DOM types needed: the element and the session are injected (fakes in player.test.ts).

import { nextNewsletterStart, previousNewsletterStart, sectionAt, sentenceAt, type Timeline } from "./queue";

export interface MediaLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export const SESSION_ACTIONS = ["play", "pause", "nexttrack", "previoustrack", "seekbackward", "seekforward", "seekto"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];
export interface SessionDetails {
  action: string;
  seekOffset?: number;
  seekTime?: number;
}

export interface MediaSessionLike {
  metadata: unknown;
  playbackState: MediaSessionPlaybackState;
  setActionHandler(action: SessionAction, handler: ((details: SessionDetails) => void) | null): void;
  setPositionState?(state: { duration: number; playbackRate: number; position: number }): void;
}

export type PlayerStatus = "paused" | "playing" | "listening" | "ended";

export interface PlayerState {
  status: PlayerStatus;
  position: number;
  duration: number;
  /** Index of the sentence to highlight. */
  sentence: number;
  /** Index of the newsletter playing, or null in the intro and outro. */
  section: number | null;
}

export type PlayResult = "playing" | "paused" | "blocked" | "failed";

export interface Player {
  state(): PlayerState;
  play(): Promise<PlayResult>;
  pause(): void;
  toggle(): Promise<PlayResult>;
  seekTo(seconds: number): void;
  seekBy(seconds: number): void;
  nextNewsletter(): void;
  previousNewsletter(): void;
  /** The mic is opening: pause and refuse to play until micClosed(). */
  micOpened(): void;
  /** The mic has closed: resume at the start of the sentence it was in, if it was playing. */
  micClosed(): Promise<PlayResult>;
  /** Re-reads the clock (call every animation frame while playing). */
  refresh(): void;
  dispose(): void;
}

export const SKIP_SECONDS = 15;
export const BRIEFING_TITLE = "Your briefing";

export interface MetadataInit {
  title: string;
  artist: string;
  album: string;
}

export function createPlayer(options: {
  media: MediaLike;
  timeline: Timeline;
  session?: MediaSessionLike | null;
  /** Builds the session's metadata object (the browser passes `new MediaMetadata(init)`). */
  makeMetadata?: (init: MetadataInit) => unknown;
  onChange?: (state: PlayerState) => void;
}): Player {
  const { media, timeline, session } = options;
  const duration = timeline.duration;
  let status: PlayerStatus = "paused";
  let micOpen = false;
  let wasPlaying = false;
  let resumeAt = 0;
  let last: PlayerState | null = null;
  let metadataFor: string | null = null;

  const clamp = (t: number) => Math.min(duration, Math.max(0, Number.isFinite(t) ? t : 0));

  function current(): PlayerState {
    const position = clamp(media.currentTime);
    return { status, position, duration, sentence: sentenceAt(timeline, position), section: sectionAt(timeline, position) };
  }

  function updateMetadata(section: number | null) {
    if (!session) return;
    const title = section === null ? BRIEFING_TITLE : timeline.sections[section].title;
    if (title === metadataFor) return;
    metadataFor = title;
    const init = { title, artist: "Impartly", album: BRIEFING_TITLE };
    session.metadata = options.makeMetadata ? options.makeMetadata(init) : init;
  }

  function pushPosition() {
    if (!session?.setPositionState || !(duration > 0)) return;
    try {
      session.setPositionState({ duration, playbackRate: 1, position: clamp(media.currentTime) });
    } catch {
      // Some browsers reject a position state during a source change; the next one lands.
    }
  }

  function refresh() {
    const next = current();
    updateMetadata(next.section);
    if (!last || last.status !== next.status || last.sentence !== next.sentence || last.section !== next.section) {
      last = next;
      options.onChange?.(next);
    } else {
      last = next;
    }
  }

  function setStatus(next: PlayerStatus) {
    status = next;
    if (session) session.playbackState = next === "playing" ? "playing" : "paused";
    pushPosition();
    refresh();
  }

  // Element events.
  const onPlay = () => {
    if (micOpen) {
      media.pause(); // never audible with the mic open
      return;
    }
    setStatus("playing");
  };
  const onPause = () => {
    if (!micOpen && status !== "ended") setStatus("paused");
  };
  const onEnded = () => {
    if (!micOpen) setStatus("ended");
  };
  const onTime = () => refresh();
  const events: [string, () => void][] = [
    ["play", onPlay],
    ["playing", onPlay],
    ["pause", onPause],
    ["ended", onEnded],
    ["timeupdate", onTime],
    ["seeked", onTime],
  ];
  for (const [type, listener] of events) media.addEventListener(type, listener);

  async function play(): Promise<PlayResult> {
    if (micOpen) return "blocked";
    if (status === "ended" || media.currentTime >= duration) media.currentTime = 0;
    try {
      await media.play();
    } catch {
      if (!micOpen) setStatus("paused");
      return "failed";
    }
    if (micOpen) {
      media.pause();
      return "blocked";
    }
    setStatus("playing");
    return "playing";
  }

  function pause() {
    media.pause();
    if (!micOpen && status !== "ended") setStatus("paused");
  }

  function seekTo(seconds: number) {
    const t = clamp(seconds);
    media.currentTime = t;
    if (micOpen) resumeAt = t;
    else if (status === "ended" && t < duration) status = "paused";
    pushPosition();
    refresh();
  }

  const player: Player = {
    state: current,
    play,
    pause,
    async toggle() {
      if (micOpen) return "blocked";
      if (!media.paused) {
        pause();
        return "paused";
      }
      return play();
    },
    seekTo,
    seekBy: (seconds) => seekTo(media.currentTime + seconds),
    nextNewsletter() {
      const target = nextNewsletterStart(timeline, media.currentTime);
      if (target !== null) seekTo(target);
    },
    previousNewsletter: () => seekTo(previousNewsletterStart(timeline, media.currentTime)),
    micOpened() {
      if (micOpen) return;
      wasPlaying = !media.paused;
      resumeAt = timeline.sentences[sentenceAt(timeline, media.currentTime)]?.start ?? 0;
      micOpen = true;
      media.pause();
      setStatus("listening");
    },
    async micClosed() {
      if (!micOpen) return media.paused ? "paused" : "playing";
      micOpen = false;
      media.currentTime = resumeAt;
      if (wasPlaying) return play();
      setStatus("paused");
      return "paused";
    },
    refresh,
    dispose() {
      for (const [type, listener] of events) media.removeEventListener(type, listener);
      if (session) for (const action of SESSION_ACTIONS) session.setActionHandler(action, null);
    },
  };

  if (session) {
    const handlers: Record<SessionAction, (details: SessionDetails) => void> = {
      play: () => void play(),
      pause: () => pause(),
      nexttrack: () => player.nextNewsletter(),
      previoustrack: () => player.previousNewsletter(),
      seekbackward: (d) => player.seekBy(-(d.seekOffset ?? SKIP_SECONDS)),
      seekforward: (d) => player.seekBy(d.seekOffset ?? SKIP_SECONDS),
      seekto: (d) => {
        if (typeof d.seekTime === "number") seekTo(d.seekTime);
      },
    };
    for (const action of SESSION_ACTIONS) {
      try {
        session.setActionHandler(action, handlers[action]);
      } catch {
        // An action this browser does not support; the others still work.
      }
    }
    session.playbackState = "paused";
  }
  refresh();
  return player;
}
