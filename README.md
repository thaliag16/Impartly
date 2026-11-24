# Impartly

*Imparting knowledge, with an "ly" for fun.*

**Your newsletters, summarized and read to you. Interrupt whenever you have a question.**

You subscribe to more newsletters than you will ever read. Impartly pulls them out of your
inbox on a schedule you set, boils each one down, and reads you the briefing while you walk,
commute or make coffee. When something catches your ear, you ask about it. Impartly answers
from the newsletters and the web, then picks the briefing back up where it left off.

> **Status: early days.** This is Phase 0, the audio spike. Nothing here runs yet. This page
> describes where the project is going, and the roadmap below shows how it gets there.

## What it does

1. **Pull.** You pick the newsletters you like (for example TechCrunch, StrictlyVC or Morning
   Brew), and at the time you choose Impartly fetches new issues from their public sources:
   the official RSS or Atom feed, else the public web archive. It respects robots.txt and
   never gets around a paywall or a sign-in. Reading Gmail is an optional extra for
   self-hosters, read-only. The **Newsletters** page (`/newsletters`) is where you search the
   catalog by name or paste a website or feed address, see what Impartly found (title, site,
   last issue) before adding it, and switch each newsletter on or off or remove it. For a
   newsletter with no feed, Impartly offers its public archive page instead and shows the
   issues it found there; it then reads at most 5 new issue pages per site per run, at most
   one request a second (slower if the site's robots.txt asks), with no cookies, no
   sign-ins and no headless browser, and marks paywalled issues as previews.
2. **Summarize.** Each issue becomes a short spoken-style summary. You choose the length
   (headline, brief or deep) and the topics to emphasize or skip.
3. **Render.** Summaries become audio ahead of time, so listening works like a podcast,
   lock screen included.
4. **Listen.** Pick the voice, the speed and the order.
5. **Ask.** Interrupt, ask out loud, hear the answer, carry on.

Later: tell Impartly which companies you own or follow, and it will flag the news about them first.

## Where it is headed

Version one is tap-to-interrupt in a web app. The end state is a native iPhone app that
listens while the briefing plays, so you can interrupt by saying its name, hands-free, on a
walk or behind the wheel.

## How it is built

| Layer | Choice | Why |
| --- | --- | --- |
| App and API | Next.js on Vercel | One codebase for screens and server routes |
| Data, sign-in, files, scheduling | Supabase | Per-user security rules; audio stored next to the data |
| Summaries | Any OpenAI-compatible model | Use an open-weight model or a hosted one; swap with one setting |
| Conversation | Claude API with web search | Answers that cite their sources |
| Speech out | Kokoro-82M (Apache 2.0) | Open source and small enough to run without a GPU |
| Speech in | Moonshine (MIT) in the browser | Your voice is transcribed on your device |

## Roadmap

| Phase | Outcome | You know it works when |
| --- | --- | --- |
| 0 Spike | Audio and mic proven on a real iPhone | Tap-to-ask plays and records cleanly |
| 1 Pipeline | Inbox to written summaries, on a schedule | A week of summaries you trust |
| 2 Listen | The briefing plays in your headphones | You listen every day for a week |
| 3 Converse | Tap to interrupt, ask, resume | Answers start within 5 seconds |
| 4 Hands-free | Native iOS app that listens while it plays | A full commute without touching the phone |
| 5 Portfolio and release | Watchlist, imports, self-hosting guide | Someone else runs their own copy |

## Run your own copy

Impartly is built to be self-hosted, and to cost one person as close to nothing as possible.
You bring your own:

- Supabase project and Vercel project (the free plans are the target for personal use)
- Google or Microsoft OAuth client, for read-only mail access
- A key for the model that writes summaries
- A Claude API key, for conversation

Copy `.env.example` to `.env.local` and fill it in. Your `.env.local` stays on your machine;
it is listed in `.gitignore` and must never be committed. A step-by-step setup guide arrives
with Phase 5.

### The scheduled pull

Supabase Cron calls `POST /api/cron/pull` on your deployment every 5 minutes (migration
`supabase/migrations/20261123180000_scheduled_pull.sql`). Each call pulls and summarizes for
the users whose briefing is coming due, starting 30 minutes before their delivery time
(`PULL_LEAD_MINUTES`, 0 to 360) so it is ready on time. A call stops before Vercel's
60-second limit and the next one carries on where it stopped. Until both Vault secrets
below exist, the job runs but calls nothing.

The route accepts only `Authorization: Bearer <CRON_SECRET>`, so the same secret goes in two
places. Never commit it or paste it into an issue.

1. Make a random secret of at least 32 characters, for example with `openssl rand -base64 48`.
2. Vercel: Project > Settings > Environment Variables, add `CRON_SECRET` for Production, then
   redeploy.
3. Supabase: apply every migration in `supabase/migrations/`. Then add two Vault secrets
   (Dashboard > Integrations > Vault, or `vault.create_secret` in the SQL editor):
   `impartly_cron_secret` with the same value as `CRON_SECRET`, and `impartly_pull_url`
   with `https://<your production domain>/api/cron/pull`. Use the production domain:
   preview deployments are usually behind Vercel's deployment protection.
4. To rotate, change both places (in Supabase, `vault.update_secret`).

To check it works: Supabase > Integrations > Cron shows the job's runs, and the route
answers each call with counts only (users claimed, completed, partial, failed).

## Principles

- **Read-only inbox.** Impartly never gets permission to send, delete or change mail.
- **Your voice stays on your device** wherever the hardware allows.
- **Newsletters are untrusted text.** The assistant can search the web, and nothing else.
- **No secrets in this repository.** See [SECURITY.md](SECURITY.md).
- **Information, not advice.** Impartly tells you what happened to the companies you follow.
  It does not tell you what to buy or sell.

## Contributing

It is early, so the most useful contribution right now is an issue: an idea, a newsletter
format that breaks things, or a correction. Pull requests are welcome once Phase 1 lands.

Database changes go in `supabase/migrations/`. Their row-level security tests
(`tests/db/rls.test.ts`, part of `npm test`) need a throwaway local PostgreSQL (15 or newer):
set `DATABASE_URL` to a superuser URL on `localhost`, for example
`DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test`. Each run creates
and drops its own database. Without `DATABASE_URL` they are skipped locally; CI always runs them.

The newsletter catalog (`data/newsletter-catalog.json`) is editable. `npm run verify:catalog`
checks every entry against the live sites (it needs internet access; CI runs it on pull
requests that touch the catalog and writes a report to the job summary). Mark an entry
`verified: true` only after that report shows a valid feed (or a readable public archive)
for it, and record the run in `verifiedAt` (its UTC date) and `verifiedRunId` (its GitHub
Actions run id); the catalog test checks the list of verified entries and that each run id
is logged in PROGRESS.md. Before adding a feed URL that discovery found, check the report's
"Feed identity" table (the feed's title, site link and first 3 items) to make sure it is
the newsletter's own feed and not the site's article feed. For entries with no feed, the
report also tries the public archive fallback (`archiveUrl` in the catalog, else the
homepage) and gives counts and codes only, never issue text. An entry whose site refuses
automated readers can be kept with `unavailable: "refuses_automated_access"`; the picker
then explains that instead of fetching. `pickerNote` is a short line shown with an entry's
preview.

The look (GOAL.md section 1a) lives in one file, `app/theme.css`: colour tokens, borders,
shadows and the shared classes. No colour value may appear anywhere else in the UI
(`lib/ui/theme.test.ts` checks this and the contrast of every text and background pair).
Fonts are self-hosted from the `@fontsource` packages, so nothing is fetched from Google.

The UI tests (`npm run test:e2e`) run the production build against a fake Supabase
(`e2e/fake-auth-server.mjs`: Auth plus an in-memory REST stand-in) and, for the newsletter
picker, a fake internet under the real fetcher, switched on by `IMPARTLY_E2E_FAKE_WEB=1`
(`lib/feeds/e2e-fake-web.ts`; ignored on Vercel). Nothing leaves the machine. They include
axe-core accessibility checks (WCAG 2.1 A/AA) on each picker screen.

## Credits

Built on [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) and
[Moonshine](https://github.com/moonshine-ai/moonshine). [Handy](https://github.com/cjpais/handy)
and [OpenWhispr](https://github.com/OpenWhispr/openwhispr) are good places to hear the same
family of speech models at work. Every model and package is listed with its license in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
