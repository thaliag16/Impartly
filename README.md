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

1. **Pull.** At the time you choose, Impartly fetches new newsletters from Gmail or Outlook.
   Access is read-only: it cannot send, delete or change your mail.
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

## Credits

Built on [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) and
[Moonshine](https://github.com/moonshine-ai/moonshine). [Handy](https://github.com/cjpais/handy)
and [OpenWhispr](https://github.com/OpenWhispr/openwhispr) are good places to hear the same
family of speech models at work. Every model and package is listed with its license in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
