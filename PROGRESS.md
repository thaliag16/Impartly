## Status
Phase: 0 | Checks: 5/7 passing (build, typecheck, lint, test, scan:secrets; test:e2e and eval:summaries not set up) | Summary eval: n/a | Last run: 2026-11-23

## Questions for Thalia
- `test:e2e` is not set up yet. Playwright's browser downloads (cdn.playwright.dev, playwright.download.prss.microsoft.com) are blocked from the agent environment. A system Google Chrome is installed there, so the next pass can run Playwright against it (`channel: "chrome"`) locally, while CI on GitHub would download browsers normally. OK to go that way?
- `eval:summaries` is not set up. GOAL.md section 4 says the first Phase 0 run sets up every missing check, but the eval needs a summarizer and fixture newsletters, which are Phase 1 work, and CLAUDE.md says not to build ahead. CLAUDE.md wins, so I left it for Phase 1. Should the Phase 0 gate count 5 of 7 checks (excluding the summary eval), or do you want a placeholder eval now?
- There is no CI workflow yet (`.github/` does not exist), but GOAL.md says items pass "in CI". A GitHub Actions workflow is free for a public repo. OK to add one in a later pass?

## Log
### 2026-11-23 run 1
- Picked: set up the missing checks from GOAL.md section 4 (typecheck, lint, test, scan:secrets)
- Did: added `typecheck` (`tsc --noEmit`, TypeScript 7), `lint` (ESLint 9 + eslint-config-next, zero warnings allowed), `test` (Vitest) and `scan:secrets` (local Node script `scripts/scan-secrets.mjs`, specific key formats plus filled-in secrets in `.env*` files, no network, never prints matched values). 24 unit tests: WAV header fields, exact durations, stereo left/right placement, cue lengths, silent lead-in, no clipping, Bell cue at 880 Hz start / 660 Hz end with overtones (Goertzel), single vs double knock; plus scanner tests with fake keys built at run time. Confirmed the tone tests fail when the bell pitch, knock count or WAV data length is broken. Fixed the one lint warning in `lib/empty.ts`. All versions pinned; new packages in THIRD_PARTY_NOTICES.md.
- Note: typescript-eslint refuses to load with TypeScript 7 (no JS API yet). Following Microsoft's side-by-side setup, `typescript` is now an alias for `@typescript/typescript6@6.0.2` (used by lint and by `next build`'s type step) and TypeScript 7 is installed as `@typescript/native`, which still owns `tsc`, so `npm run typecheck` runs on 7. ESLint stays on 9 because eslint-plugin-react, -import and -jsx-a11y do not support ESLint 10 yet. Revisit both when upstream catches up.
- Checks before → after: 1/7 → 5/7
- PR: #10
- Next: GitHub Actions CI running all checks (if approved), then `test:e2e` with Playwright and the pause-button UI test
