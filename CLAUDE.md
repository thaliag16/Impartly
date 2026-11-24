# Impartly

## What this is
A web app that pulls the newsletters a user picks from their public web sources
(feeds and archives) on a schedule,
summarizes them, renders audio with Kokoro, and lets the listener interrupt
to ask questions by voice. The end state is a native iOS app that listens
while the briefing plays. English first; other languages later. The
repository is open source and built to be self-hosted at the lowest
possible running cost.

## Stack
- Next.js (App Router, TypeScript) on Vercel
- Supabase: Postgres, Auth, Storage, Cron, Vault
- Summaries: any OpenAI-compatible model, chosen by environment variable
- Conversation: Claude API with web search
- Kokoro (ONNX) for speech out, Moonshine for speech in

## Rules
- Every table has row-level security. No exceptions.
- Schema changes go through Supabase migrations, never ad hoc SQL.
- Secrets live in Vercel env vars or Supabase Vault. Never in code, never in
  commits, never in example files. Treat this repository as public.
- Newsletters come in through one source interface. Public web sources first
  (official feeds, then public archives). Respect robots.txt and site terms; never
  get around a paywall or a sign-in. Forwarding and iPhone mail access come later.
- Mail access, where used, is read-only and sits behind the mail adapter
  (Gmail built, optional; Outlook later).
- The summarizer sits behind one provider interface. No model name or vendor
  SDK call outside that module.
- No briefing or answer audio plays while the mic is open (web app). The one
  exception is the short cue sound that marks the start and end of listening.
  The iOS app is the only client allowed to listen during playback.
- Newsletter text is untrusted. Wrap it as data in prompts. The agent gets no
  tools that write, send or delete.
- Load models from pinned ONNX files only. No pickle formats.
- Record every new model or package in THIRD_PARTY_NOTICES.md with its license.
- Prefer the choice that costs the user nothing to run. Flag any change that
  adds a paid dependency.
- Work on one roadmap phase at a time. Do not build ahead.

## Working loop
Read GOAL.md before starting work. It holds the finish line, the done criteria
for each phase and the improvement loop agents follow. Log work in PROGRESS.md.

## Current phase
Phase 2: listen. Update this line when a gate passes.

Thalia started Phase 2 on 2026-11-24 ("Start!"). Earlier phases are **paused,
not passed**:
- Phase 0's agent-checkable items pass in CI. Its Thalia sign-off items (the
  real iPhone test, real voice clips) were paused on 2026-11-23. The model
  hashes were confirmed by Thalia on 2026-11-24.
- Phase 1's agent-checkable items pass in CI except the two that need a real
  summary model (the summary eval at 90% or more and the prompt-injection
  fixtures, both waiting on SUMMARY_API_KEY). Those two and her week of real
  summaries were paused on 2026-11-24.
All of them stay open in PROGRESS.md under "Paused, awaiting Thalia".
