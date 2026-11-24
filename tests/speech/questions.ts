// Invented spoken questions, the kind a listener asks mid-briefing. No real newsletter
// or inbox content (SECURITY.md); the company names are made up for these tests.
//
// SYNTHETIC STAND-IN: these clips are rendered by Kokoro at test time, not recorded by a
// person. Real recordings go in tests/speech/fixtures/clips/ (see moonshine.models.ts) and
// are tested the same way when present.

export type QuestionClip = {
  id: string;
  text: string;
  voice: "af_heart" | "bm_daniel";
  speed: number;
  /** Adds seeded white noise at this signal-to-noise ratio (dB), if set. */
  noiseSnrDb?: number;
};

export const QUESTION_CLIPS: QuestionClip[] = [
  {
    id: "funding-round",
    text: "Wait, go back. Did Larkspur Robotics really raise 40 million dollars in that round, and who led it?",
    voice: "af_heart",
    speed: 1,
  },
  {
    id: "job-cuts-noisy",
    text: "How many people work at Pinecrest Energy now, after the company cut twelve hundred jobs last spring?",
    voice: "bm_daniel",
    speed: 1,
    noiseSnrDb: 20,
  },
  {
    id: "share-drop-fast",
    text: "Why did shares of Bluefin Health fall 12 percent this morning, and is that bigger than the drop last year?",
    voice: "af_heart",
    speed: 1.2,
  },
];

/** Every clip must transcribe below this word error rate (GOAL.md Phase 0). */
export const MAX_WORD_ERROR_RATE = 0.15;
