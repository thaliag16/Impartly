// Measurements used to tell whether rendered speech is complete: how long it is, where
// the speech starts and stops inside a chunk, and how long it should be for its text.

/** Kokoro at speed 1.0 speaks at roughly this rate (words per minute). */
export const NOMINAL_WORDS_PER_MINUTE = 165;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Expected spoken length of the text, in seconds, at the given speaking rate. */
export function expectedSeconds(text: string, wordsPerMinute = NOMINAL_WORDS_PER_MINUTE): number {
  return (countWords(text) / wordsPerMinute) * 60;
}

export type SpeechSpan = {
  /** Whole chunk length, seconds. */
  total: number;
  /** First and last moment with speech, seconds from the start of the chunk. */
  start: number;
  end: number;
  leadingSilence: number;
  trailingSilence: number;
  /** Share of the chunk's last quarter that is speech (0 to 1). */
  speechInLastQuarter: number;
};

const WINDOW_SECONDS = 0.02;

function windowRms(samples: Float32Array, sampleRate: number): number[] {
  const size = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  const levels: number[] = [];
  for (let offset = 0; offset < samples.length; offset += size) {
    const end = Math.min(samples.length, offset + size);
    let sum = 0;
    for (let i = offset; i < end; i++) sum += samples[i] * samples[i];
    levels.push(Math.sqrt(sum / (end - offset)));
  }
  return levels;
}

/**
 * Finds where speech starts and ends in a chunk. A 20 ms window counts as speech when
 * its RMS level is above 5% of the loudest window (and above an absolute floor, so a
 * chunk of near-silence is not mistaken for speech).
 */
export function speechSpan(samples: Float32Array, sampleRate: number): SpeechSpan {
  const total = samples.length / sampleRate;
  const levels = windowRms(samples, sampleRate);
  const loudest = levels.reduce((max, level) => Math.max(max, level), 0);
  const threshold = Math.max(0.003, loudest * 0.05);
  const voiced = levels.map((level) => level > threshold);
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first < 0) {
    return { total, start: 0, end: 0, leadingSilence: total, trailingSilence: total, speechInLastQuarter: 0 };
  }
  const start = first * WINDOW_SECONDS;
  const end = Math.min(total, (last + 1) * WINDOW_SECONDS);
  const quarter = voiced.slice(Math.floor(voiced.length * 0.75));
  return {
    total,
    start,
    end,
    leadingSilence: start,
    trailingSilence: Math.max(0, total - end),
    speechInLastQuarter: quarter.length ? quarter.filter(Boolean).length / quarter.length : 0,
  };
}
