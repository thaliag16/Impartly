// The player controller over a fake <audio> element (its clock moves only when the test
// says so) and a fake Media Session.

import { describe, expect, it } from "vitest";
import { createPlayer, type MediaLike, type MediaSessionLike, type SessionAction } from "./player";
import { buildQueue, sentenceAt } from "./queue";
import { assembleBriefing, type BriefingItem } from "./script";

const RATE = 24_000;
const item = (n: number, feed: string, source: string): BriefingItem => ({
  id: `n${n}`,
  feedId: feed,
  source,
  subject: `Invented story ${n}`,
  summary: `Story ${n} happened. It mattered a little.`,
  partial: false,
  receivedAt: `2026-11-24T0${n}:00:00Z`,
});
const FEED_A = "11111111-1111-4111-8111-111111111111";
const FEED_B = "22222222-2222-4222-8222-222222222222";
const script = assembleBriefing([item(1, FEED_A, "The Invented Ledger"), item(2, FEED_B, "Harbor Notes")], {
  feedOrder: [FEED_A, FEED_B],
});
// Two seconds per sentence.
const { timeline } = buildQueue(
  script,
  script.sentences.map(() => ({ sampleRate: RATE, samples: new Float32Array(2 * RATE) })),
);

class FakeMedia implements MediaLike {
  currentTime = 0;
  paused = true;
  duration = timeline.duration;
  playCalls = 0;
  failNextPlay = false;
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  async play() {
    this.playCalls++;
    if (this.failNextPlay) {
      this.failNextPlay = false;
      throw new DOMException("not allowed", "NotAllowedError");
    }
    this.paused = false;
    this.emit("play");
    this.emit("playing");
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  /** The audio clock moves on while playing. */
  advance(seconds: number) {
    if (this.paused) return;
    this.currentTime = Math.min(this.duration, this.currentTime + seconds);
    this.emit("timeupdate");
    if (this.currentTime >= this.duration) {
      this.paused = true;
      this.emit("ended");
    }
  }
}

class FakeSession implements MediaSessionLike {
  metadata: unknown = null;
  playbackState: MediaSessionPlaybackState = "none";
  handlers = new Map<string, ((details: { action: SessionAction; seekOffset?: number; seekTime?: number }) => void) | null>();
  positions: { duration: number; playbackRate: number; position: number }[] = [];
  setActionHandler(action: SessionAction, handler: ((details: { action: SessionAction; seekOffset?: number; seekTime?: number }) => void) | null) {
    this.handlers.set(action, handler);
  }
  setPositionState(state: { duration: number; playbackRate: number; position: number }) {
    if (state.position > state.duration) throw new TypeError("position past duration");
    this.positions.push(state);
  }
  press(action: SessionAction, extra: { seekOffset?: number; seekTime?: number } = {}) {
    const h = this.handlers.get(action);
    if (!h) throw new Error(`no handler for ${action}`);
    h({ action, ...extra });
  }
}

function setup() {
  const media = new FakeMedia();
  const session = new FakeSession();
  const changes: number[] = [];
  const player = createPlayer({
    media,
    timeline,
    session,
    makeMetadata: (init) => ({ ...init }),
    onChange: (s) => changes.push(s.sentence),
  });
  return { media, session, player, changes };
}

const [A, B] = timeline.sections;

describe("play, pause and resume in place", () => {
  it("plays, pauses where it is, and resumes from the same place", async () => {
    const { media, player } = setup();
    expect(player.state().status).toBe("paused");
    expect(await player.play()).toBe("playing");
    media.advance(3.3);
    player.pause();
    expect(player.state()).toMatchObject({ status: "paused", position: 3.3 });
    media.advance(5); // paused: the clock does not move
    expect(await player.play()).toBe("playing");
    expect(media.currentTime).toBe(3.3);
    expect(player.state().status).toBe("playing");
  });

  it("toggle switches between the two", async () => {
    const { player } = setup();
    await player.toggle();
    expect(player.state().status).toBe("playing");
    await player.toggle();
    expect(player.state().status).toBe("paused");
  });

  it("after the end, play starts again from the top", async () => {
    const { media, player } = setup();
    await player.play();
    media.advance(timeline.duration + 1);
    expect(player.state().status).toBe("ended");
    await player.play();
    expect(media.currentTime).toBe(0);
  });

  it("reports a refused play (no tap yet) as failed, and stays paused", async () => {
    const { media, player } = setup();
    media.failNextPlay = true;
    expect(await player.play()).toBe("failed");
    expect(player.state().status).toBe("paused");
  });
});

describe("the highlighted sentence follows the audio clock", () => {
  it("state().sentence is the sentence at the current time, and changes are reported", async () => {
    const { media, player, changes } = setup();
    await player.play();
    for (let t = 0; t < 12; t++) {
      media.advance(0.5);
      expect(player.state().sentence).toBe(sentenceAt(timeline, media.currentTime));
    }
    expect(player.state().sentence).toBeGreaterThan(1);
    // One report per new sentence (plus status changes), in order.
    const distinct = changes.filter((s, i) => i === 0 || s !== changes[i - 1]);
    expect(distinct).toEqual([...distinct].sort((a, b) => a - b));
  });

  it("refresh() picks up the clock between timeupdate events", async () => {
    const { media, player } = setup();
    await player.play();
    media.currentTime = timeline.sentences[3].start + 0.1; // no event
    player.refresh();
    expect(player.state().sentence).toBe(3);
  });
});

describe("skipping", () => {
  it("next and previous newsletter", async () => {
    const { media, player } = setup();
    await player.play();
    player.nextNewsletter();
    expect(media.currentTime).toBe(A.start);
    expect(player.state().section).toBe(0);
    player.nextNewsletter();
    expect(media.currentTime).toBe(B.start);
    media.advance(4);
    player.previousNewsletter(); // more than 3 s in: back to its start
    expect(media.currentTime).toBe(B.start);
    player.previousNewsletter(); // just started: the one before
    expect(media.currentTime).toBe(A.start);
    expect(player.state().status).toBe("playing");
  });

  it("next newsletter from the last one goes to the outro, then does nothing", async () => {
    const { media, player } = setup();
    media.currentTime = B.start + 1;
    player.nextNewsletter();
    expect(media.currentTime).toBe(timeline.outroStart);
    player.nextNewsletter();
    expect(media.currentTime).toBe(timeline.outroStart);
  });

  it("seekBy moves 15 s either way, clamped to the briefing", () => {
    const { media, player } = setup();
    player.seekBy(15);
    expect(media.currentTime).toBe(15);
    player.seekBy(-15);
    expect(media.currentTime).toBe(0);
    player.seekBy(-15);
    expect(media.currentTime).toBe(0);
    player.seekBy(10_000);
    expect(media.currentTime).toBe(timeline.duration);
  });
});

describe("Media Session (lock screen and headphone controls)", () => {
  it("registers play, pause, next/previous track, seek back/forward and seek to", () => {
    const { session } = setup();
    for (const action of ["play", "pause", "nexttrack", "previoustrack", "seekbackward", "seekforward", "seekto"] as const) {
      expect(session.handlers.get(action), action).toBeTypeOf("function");
    }
  });

  it("each handler drives the player", async () => {
    const { media, session, player } = setup();
    session.press("play");
    await Promise.resolve();
    expect(player.state().status).toBe("playing");
    session.press("pause");
    expect(player.state().status).toBe("paused");
    session.press("nexttrack");
    expect(media.currentTime).toBe(A.start);
    session.press("nexttrack");
    expect(media.currentTime).toBe(B.start);
    session.press("previoustrack");
    expect(media.currentTime).toBe(A.start);
    session.press("seekforward");
    expect(media.currentTime).toBeCloseTo(A.start + 15, 5);
    session.press("seekbackward", { seekOffset: 5 });
    expect(media.currentTime).toBeCloseTo(A.start + 10, 5);
    session.press("seekto", { seekTime: 2 });
    expect(media.currentTime).toBe(2);
  });

  it("metadata names the newsletter playing, and the playback state follows", async () => {
    const { media, session, player } = setup();
    expect(session.metadata).toMatchObject({ title: "Your briefing", artist: "Impartly" });
    await player.play();
    expect(session.playbackState).toBe("playing");
    player.nextNewsletter();
    media.advance(0.1);
    expect(session.metadata).toMatchObject({ title: "The Invented Ledger", artist: "Impartly" });
    player.nextNewsletter();
    media.advance(0.1);
    expect(session.metadata).toMatchObject({ title: "Harbor Notes" });
    player.pause();
    expect(session.playbackState).toBe("paused");
  });

  it("position state is set on play, pause and every seek, never past the end", async () => {
    const { media, session, player } = setup();
    await player.play();
    media.advance(1);
    player.pause();
    player.seekBy(15);
    player.seekBy(10_000);
    expect(session.positions.length).toBeGreaterThanOrEqual(4);
    const last = session.positions.at(-1)!;
    expect(last).toEqual({ duration: timeline.duration, playbackRate: 1, position: timeline.duration });
  });

  it("dispose clears every handler", () => {
    const { session, player } = setup();
    player.dispose();
    expect([...session.handlers.values()].every((h) => h === null)).toBe(true);
  });
});

describe("the mic rule: nothing plays while the mic is open", () => {
  it("opening the mic pauses; play from the screen or the lock screen is blocked until it closes", async () => {
    const { media, session, player } = setup();
    await player.play();
    media.advance(timeline.sentences[2].start + 0.7);
    player.micOpened();
    expect(media.paused).toBe(true);
    expect(player.state().status).toBe("listening");
    const calls = media.playCalls;
    expect(await player.play()).toBe("blocked");
    expect(await player.toggle()).toBe("blocked");
    session.press("play");
    await Promise.resolve();
    expect(media.playCalls).toBe(calls);
    expect(media.paused).toBe(true);
    // Skips while listening move the place but never start the audio.
    player.nextNewsletter();
    player.seekBy(15);
    expect(media.paused).toBe(true);
  });

  it("if something else starts the audio while the mic is open, it is paused at once", async () => {
    const { media, player } = setup();
    player.micOpened();
    media.paused = false;
    media.emit("play");
    expect(media.paused).toBe(true);
  });

  it("after the mic closes, it resumes at the start of the sentence it was in, if it was playing", async () => {
    const { media, player } = setup();
    await player.play();
    media.advance(timeline.sentences[2].start + 0.7);
    player.micOpened();
    expect(await player.micClosed()).toBe("playing");
    expect(media.currentTime).toBe(timeline.sentences[2].start);
    expect(player.state().status).toBe("playing");
  });

  it("stays paused after the mic closes when it was paused before", async () => {
    const { media, player } = setup();
    media.currentTime = 5;
    player.micOpened();
    expect(await player.micClosed()).toBe("paused");
    expect(media.paused).toBe(true);
    expect(player.state().status).toBe("paused");
  });
});
