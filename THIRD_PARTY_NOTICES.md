# Third-party notices

Impartly's own code is MIT-licensed. The models and packages it uses keep
their own licenses. Add a row here whenever one is added.

| Component | Used for | License | Source |
| --- | --- | --- | --- |
| Kokoro-82M | Text to speech | Apache 2.0 (weights) | https://huggingface.co/hexgrad/Kokoro-82M |
| Moonshine (English) | Speech to text in the browser | MIT | https://github.com/moonshine-ai/moonshine |
| Next.js | App framework | MIT | https://github.com/vercel/next.js |
| React | User interface library | MIT | https://github.com/facebook/react |
| TypeScript | Build-time language tooling | Apache 2.0 | https://github.com/microsoft/TypeScript |
| @typescript/typescript6 | TypeScript 6 API for lint tooling (TS 7 has no JS API yet); installed as the `typescript` alias, `tsc` stays on 7 | Apache 2.0 | https://github.com/microsoft/TypeScript |
| Vitest | Unit tests (dev only) | MIT | https://github.com/vitest-dev/vitest |
| ESLint | Linting (dev only) | MIT | https://github.com/eslint/eslint |
| eslint-config-next | Next.js lint rules (dev only) | MIT | https://github.com/vercel/next.js |
| typescript-eslint | TypeScript lint rules, via eslint-config-next (dev only) | MIT | https://github.com/typescript-eslint/typescript-eslint |
| kokoro-js | Runs Kokoro in Node and the browser | Apache 2.0 | https://www.npmjs.com/package/kokoro-js |
| Transformers.js | Model loading for kokoro-js | Apache 2.0 | https://github.com/huggingface/transformers.js |
| ONNX Runtime | Runs ONNX models on CPU | MIT | https://github.com/microsoft/onnxruntime |
| phonemizer | Text to phonemes for Kokoro; built on espeak-ng | Apache 2.0 (package); espeak-ng is GPL-3.0, to be confirmed before any release | https://www.npmjs.com/package/phonemizer |

Not yet adopted, under evaluation: WhisperKit, FluidAudio, Parakeet TDT 0.6B v3 (CC-BY-4.0, attribution required).
