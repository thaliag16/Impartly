# Third-party notices

Impartly's own code is MIT-licensed. The models and packages it uses keep
their own licenses. Add a row here whenever one is added.

| Component | Used for | License | Source |
| --- | --- | --- | --- |
| Kokoro-82M | Text to speech; ONNX conversion `onnx-community/Kokoro-82M-v1.0-ONNX` at a pinned commit (8-bit model), hashes in `scripts/model-pins.json` confirmed by Thalia against Hugging Face on 2026-11-24 | Apache 2.0 (weights) | https://huggingface.co/hexgrad/Kokoro-82M |
| Moonshine Base (English) | Speech to text (`lib/speech/moonshine.ts`); ONNX conversion `onnx-community/moonshine-base-ONNX` at a pinned commit (fp32 encoder, q4 decoder), fetched in CI and never committed; hashes confirmed by Thalia against Hugging Face on 2026-11-24 | MIT (Moonshine); the conversion repo's license is to be confirmed on Hugging Face | https://github.com/moonshine-ai/moonshine, https://huggingface.co/onnx-community/moonshine-base-ONNX |
| Next.js | App framework | MIT | https://github.com/vercel/next.js |
| React | User interface library | MIT | https://github.com/facebook/react |
| TypeScript | Build-time language tooling | Apache 2.0 | https://github.com/microsoft/TypeScript |
| @typescript/typescript6 | TypeScript 6 API for lint tooling (TS 7 has no JS API yet); installed as the `typescript` alias, `tsc` stays on 7 | Apache 2.0 | https://github.com/microsoft/TypeScript |
| Vitest | Unit tests (dev only) | MIT | https://github.com/vitest-dev/vitest |
| Playwright (@playwright/test, playwright, playwright-core) | UI tests (dev only); browsers are not committed | Apache 2.0 | https://github.com/microsoft/playwright |
| ESLint | Linting (dev only) | MIT | https://github.com/eslint/eslint |
| eslint-config-next | Next.js lint rules (dev only) | MIT | https://github.com/vercel/next.js |
| typescript-eslint | TypeScript lint rules, via eslint-config-next (dev only) | MIT | https://github.com/typescript-eslint/typescript-eslint |
| actions/checkout, actions/setup-node, actions/upload-artifact, actions/cache | GitHub Actions CI steps (CI only, pinned to commit SHAs); actions/cache v6.1.0 keeps the verified model files between model-test runs | MIT | https://github.com/actions |
| node-postgres (pg 8.23.1, with pg-pool, pg-protocol, pg-types, pgpass, pg-connection-string, pg-cloudflare, and helpers pg-int8, postgres-array, postgres-bytea, postgres-date, postgres-interval, split2, xtend) and @types/pg 8.23.1 | Postgres client for the row-level security tests (dev only) | MIT (pg-int8 and split2: ISC) | https://github.com/brianc/node-postgres |
| parse5 8.1.1 (with entities 9.0.0) | Spec-compliant HTML parsing for newsletter HTML to text (`lib/text/html-to-text.ts`, shared by mail and web sources), so hidden text is judged on the same tree a mail client builds | MIT (entities: BSD-2-Clause) | https://github.com/inikulin/parse5, https://github.com/fb55/entities |
| saxes 6.0.0 (with xmlchars 2.2.0) | Strict XML parsing of RSS and Atom feeds (`lib/sources/web/feed-parser.ts`); never fetches external entities or expands DOCTYPE entities | ISC (xmlchars: MIT) | https://github.com/lddubeau/saxes, https://github.com/lddubeau/xmlchars |
| Supabase JS client (@supabase/supabase-js 2.119.2, with @supabase/auth-js, @supabase/functions-js, @supabase/postgrest-js, @supabase/realtime-js and @supabase/storage-js 2.119.2, @supabase/phoenix 0.4.5, iceberg-js 0.8.1 and tslib 2.8.1) | Server-side Supabase Auth sign-in and the service-role RPC calls (`lib/supabase/`) | MIT (tslib: 0BSD) | https://github.com/supabase/supabase-js |
| @supabase/ssr 0.12.7 (with cookie 1.1.1) | Supabase sessions in httpOnly cookies for Next.js (proxy, route handlers, server components) | MIT | https://github.com/supabase/ssr, https://github.com/jshttp/cookie |
| server-only 0.0.1 | Marks modules that must never be bundled for the browser (the service-role client and what imports it) | MIT | https://www.npmjs.com/package/server-only |
| PostgreSQL | Throwaway local database for the RLS tests (the server preinstalled on the CI runner, or your own); not bundled | PostgreSQL License | https://www.postgresql.org |
| pg_cron (Postgres extension, provided by Supabase as Supabase Cron) | Runs the scheduled pull's 5-minute tick (`supabase/migrations/20261123180000_scheduled_pull.sql`); not bundled, enabled by the migration | PostgreSQL License | https://github.com/citusdata/pg_cron |
| pg_net (Postgres extension, provided by Supabase) | The tick's HTTP POST to the pull route; not bundled, enabled by the migration | Apache 2.0 | https://github.com/supabase/pg_net |
| kokoro-js | Runs Kokoro in Node and the browser | Apache 2.0 | https://www.npmjs.com/package/kokoro-js |
| Transformers.js (@huggingface/transformers 3.8.1, a direct dependency since run 6) | Model loading for kokoro-js and Moonshine | Apache 2.0 | https://github.com/huggingface/transformers.js |
| ONNX Runtime | Runs ONNX models on CPU | MIT | https://github.com/microsoft/onnxruntime |
| phonemizer | Text to phonemes for Kokoro; built on espeak-ng | Apache 2.0 (package); espeak-ng is GPL-3.0, to be confirmed before any release | https://www.npmjs.com/package/phonemizer |

Not yet adopted, under evaluation: WhisperKit, FluidAudio, Parakeet TDT 0.6B v3 (CC-BY-4.0, attribution required).
| Pixelify Sans (@fontsource/pixelify-sans 5.3.0) | Headline font, self-hosted (Latin subset) | SIL Open Font License 1.1 (OFL-1.1, the npm packages too) | https://github.com/eifetx/Pixelify-Sans, https://github.com/fontsource/font-files |
| Silkscreen (@fontsource/silkscreen 5.3.0) | Label and time font, self-hosted (Latin subset) | SIL Open Font License 1.1 (OFL-1.1, the npm packages too) | https://github.com/googlefonts/silkscreen, https://github.com/fontsource/font-files |
| DM Sans (@fontsource/dm-sans 5.3.0) | Body font, self-hosted (Latin subset) | SIL Open Font License 1.1 (OFL-1.1, the npm packages too) | https://github.com/googlefonts/dm-fonts, https://github.com/fontsource/font-files |
| @axe-core/playwright 4.14.0 (with axe-core 4.14.1, already present through eslint-plugin-jsx-a11y) | Accessibility checks in the UI tests (dev only) | MPL-2.0 | https://github.com/dequelabs/axe-core-npm, https://github.com/dequelabs/axe-core |
