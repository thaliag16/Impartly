// Speech in sits behind this one interface (CLAUDE.md). The app and the tests ask for a
// transcriber here and never call a speech-recognition model or library directly.

export interface SpeechToText {
  /** Transcribes mono audio at any sample rate (it is resampled as the model needs). */
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>;
  /** Frees the model's memory. */
  dispose(): Promise<void>;
}
