// The player's queue: the stored sentence clips (from render-ahead) laid end to end as ONE
// audio file with a timeline of where each sentence and each newsletter starts.
//
// Why one file for one <audio> element (not Web Audio, not one element per clip): on iOS
// Safari an <audio> element keeps playing with the screen locked and drives the lock
// screen's Now Playing controls through the Media Session API, while a Web Audio context
// is suspended in the background and does not own the lock screen. One file also means
// no source switch between sentences, which iOS may refuse while locked and which leaves
// an audible gap: sentence transitions are sample-exact, with a short pause (SENTENCE_GAP)
// written in on purpose, and a longer one before each newsletter. Skipping is a seek.
//
// Memory: 16-bit mono at Kokoro's 24 kHz is about 2.9 MB per minute of briefing.
//
// Pure apart from loadClips (which reads the clip store): tested in queue.test.ts.

import type { BriefingVoice } from "../speech/pins";
import { clipKey, type AudioClip, type ClipStore } from "./render-ahead";
import type { BriefingScript, SentenceKind } from "./script";

/** Pause between two sentences, seconds. */
export const SENTENCE_GAP = 0.15;
/** Pause before a spoken transition (a newsletter's lead-in, the outro), seconds. */
export const SECTION_GAP = 0.5;
/** "Previous newsletter" restarts the current one when more than this far in, seconds. */
export const RESTART_WINDOW = 3;
const EPSILON = 0.05;

export interface TimelineSentence {
  index: number;
  kind: SentenceKind;
  text: string;
  section: number | null;
  /** Seconds from the start of the briefing. */
  start: number;
  end: number;
}

export interface TimelineSection {
  index: number;
  title: string;
  start: number;
  end: number;
}

export interface Timeline {
  sampleRate: number;
  duration: number;
  sentences: TimelineSentence[];
  sections: TimelineSection[];
  /** Where the closing line starts, or null when there is none. */
  outroStart: number | null;
}

export interface Queue {
  timeline: Timeline;
  /** The whole briefing as a 16-bit mono PCM WAV file. */
  wav: Uint8Array<ArrayBuffer>;
}

export class MissingClipsError extends Error {
  override name = "MissingClipsError";
  constructor(
    readonly missing: number,
    readonly total: number,
  ) {
    super(`${missing} of ${total} sentences have no stored audio yet; render the briefing first`);
  }
}

/** Every sentence's stored clip for this voice and speed, in play order. */
export async function loadClips(
  script: BriefingScript,
  options: { store: ClipStore; subtle: SubtleCrypto; voice: BriefingVoice; speed: number },
): Promise<AudioClip[]> {
  const clips: AudioClip[] = [];
  let missing = 0;
  for (const sentence of script.sentences) {
    const clip = await options.store.get(await clipKey(options.subtle, sentence.text, options.voice, options.speed));
    if (clip) clips.push(clip);
    else missing++;
  }
  if (missing > 0) throw new MissingClipsError(missing, script.sentences.length);
  return clips;
}

/** Lays the clips out in play order and writes the WAV file. */
export function buildQueue(script: BriefingScript, clips: readonly AudioClip[]): Queue {
  if (clips.length !== script.sentences.length) {
    throw new Error(`Expected one clip per sentence (${script.sentences.length}), got ${clips.length}`);
  }
  const sampleRate = clips[0]?.sampleRate ?? 24_000;
  if (clips.some((c) => c.sampleRate !== sampleRate)) throw new Error("Every clip must have the same sample rate");

  const offsets: number[] = [];
  const sentences: TimelineSentence[] = [];
  let frame = 0;
  script.sentences.forEach((sentence, i) => {
    if (i > 0) frame += Math.round((sentence.kind === "transition" ? SECTION_GAP : SENTENCE_GAP) * sampleRate);
    offsets.push(frame);
    const length = clips[i].samples.length;
    sentences.push({
      index: i,
      kind: sentence.kind,
      text: sentence.text,
      section: sentence.section,
      start: frame / sampleRate,
      end: (frame + length) / sampleRate,
    });
    frame += length;
  });

  const sections: TimelineSection[] = script.sections.map((section, index) => {
    const own = sentences.filter((s) => s.section === index);
    return {
      index,
      title: section.title,
      start: sentences[section.firstSentence].start,
      end: own.length ? own[own.length - 1].end : sentences[section.firstSentence].end,
    };
  });
  const lastSectionSentence = sentences.findLastIndex((s) => s.section !== null);
  const outro = lastSectionSentence >= 0 ? sentences[lastSectionSentence + 1] : undefined;

  return {
    timeline: { sampleRate, duration: frame / sampleRate, sentences, sections, outroStart: outro ? outro.start : null },
    wav: encodeWav(clips, offsets, frame, sampleRate),
  };
}

/** 16-bit mono PCM WAV: `clips[i]` written at frame `offsets[i]`, silence elsewhere. */
export function encodeWav(
  clips: readonly AudioClip[],
  offsets: readonly number[],
  frames: number,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  clips.forEach((clip, i) => {
    let at = 44 + offsets[i] * 2;
    for (const sample of clip.samples) {
      const s = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
      view.setInt16(at, Math.round(s * 32767), true);
      at += 2;
    }
  });
  return bytes;
}

/** The sentence playing at `time`; it stays current through the pause after it. */
export function sentenceAt(timeline: Timeline, time: number): number {
  const list = timeline.sentences;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].start <= time) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The newsletter playing at `time`, or null in the intro and the outro. */
export function sectionAt(timeline: Timeline, time: number): number | null {
  const sentence = timeline.sentences[sentenceAt(timeline, time)];
  return sentence ? sentence.section : null;
}

function boundaries(timeline: Timeline): number[] {
  const starts = timeline.sections.map((s) => s.start);
  if (timeline.outroStart !== null) starts.push(timeline.outroStart);
  return starts;
}

/** Where "next newsletter" goes: the next one's start, then the outro; null at the end. */
export function nextNewsletterStart(timeline: Timeline, time: number): number | null {
  return boundaries(timeline).find((b) => b > time + EPSILON) ?? null;
}

/** Where "previous newsletter" goes: this one's start, or the one before when just started. */
export function previousNewsletterStart(timeline: Timeline, time: number): number {
  const marks = [0, ...boundaries(timeline).filter((b) => b > 0)];
  let current = 0;
  for (let i = 0; i < marks.length; i++) if (marks[i] <= time + EPSILON) current = i;
  if (time - marks[current] > RESTART_WINDOW) return marks[current];
  return marks[Math.max(0, current - 1)];
}

/** Loudness per bar (0 to 1) for the progress waveform, from the WAV's samples. */
export function waveformLevels(queue: Queue, bars: number): number[] {
  const frames = (queue.wav.length - 44) / 2;
  const view = new DataView(queue.wav.buffer, queue.wav.byteOffset, queue.wav.byteLength);
  const raw: number[] = [];
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * frames) / bars);
    const to = Math.max(from + 1, Math.floor(((b + 1) * frames) / bars));
    const step = Math.max(1, Math.floor((to - from) / 400)); // sample at most ~400 points per bar
    let sum = 0;
    let n = 0;
    for (let f = from; f < to && f < frames; f += step) {
      const v = view.getInt16(44 + f * 2, true) / 32767;
      sum += v * v;
      n++;
    }
    raw.push(n ? Math.sqrt(sum / n) : 0);
  }
  const peak = Math.max(...raw);
  if (peak <= 0) return raw.map(() => 0.15);
  return raw.map((r) => Math.max(0.15, r / peak));
}
