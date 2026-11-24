"use client";

// The listening settings form: voice (with a preview), speed, and the newsletter order.
// The save action arrives as a prop from page.tsx (this file imports no server module).
//
//   * Voice and speed are native <select>s (VoiceOver reads them as pop-up buttons).
//   * Preview renders one sentence in the chosen voice and speed through the same renderer
//     /listen uses (the Kokoro worker; the stand-in tone renderer in the UI tests) and plays
//     it. This page never opens the microphone, so the mic rule (CLAUDE.md: nothing plays
//     while the mic is open) cannot be broken here; changing the voice or speed stops it.
//   * Order: Move up and Move down buttons on each newsletter, no dragging. Each move is
//     announced in a polite live region ("Harbor Notes moved to position 1 of 2."), and
//     focus stays on the moved newsletter's buttons.
//   * One watermelon Save. When the order was not touched, the saved order is sent back
//     as it was, so a user who never ordered keeps "newest issue first".

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { createFakeRenderer } from "../../../lib/briefing/fake-renderer";
import { encodeWav } from "../../../lib/briefing/queue";
import type { RenderSentence } from "../../../lib/briefing/render-ahead";
import {
  LISTEN_ERROR_MESSAGES,
  SPEED_OPTIONS,
  VOICE_LABELS,
  moveFeed,
  orderFeeds,
  positionAnnouncement,
  previewSentence,
  speedLabel,
  type ListenSettings,
  type ListenSettingsError,
  type OrderableFeed,
} from "../../../lib/briefing/settings";
import { createWorkerRenderer } from "../../../lib/briefing/worker-renderer";
import { BRIEFING_VOICES, type BriefingVoice } from "../../../lib/speech/pins";

type Outcome = { ok: true; value: ListenSettings } | { ok: false; error: ListenSettingsError | "save_failed" | "signed_out" };
type Message = { kind: "error" | "done"; text: string };
type Preview = { kind: "idle" } | { kind: "loading" } | { kind: "playing"; text: string } | { kind: "error"; text: string };

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

export function ListeningForm({
  initial,
  feeds,
  fakeRenderer,
  save,
}: {
  initial: ListenSettings;
  /** The user's feeds, in the order the screen lists them. */
  feeds: OrderableFeed[];
  fakeRenderer: boolean;
  save(input: ListenSettings): Promise<Outcome>;
}) {
  const voiceId = useId();
  const speedId = useId();
  const orderHeadingId = useId();
  const [saved, setSaved] = useState<ListenSettings>(initial);
  const [voice, setVoice] = useState<BriefingVoice>(initial.voice);
  const [speed, setSpeed] = useState<number>(initial.speed);
  const [order, setOrder] = useState<string[]>(() => feeds.map((f) => f.id));
  const [orderStatus, setOrderStatus] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<Preview>({ kind: "idle" });

  const byId = new Map(feeds.map((f) => [f.id, f]));
  const baseline = orderFeeds(feeds, saved.feedOrder).map((f) => f.id);
  const orderChanged = !sameOrder(order, baseline);
  const changed = voice !== saved.voice || speed !== saved.speed || orderChanged;

  // ---- Order: move up and down, keep focus, announce -------------------------------------
  const moveButtons = useRef(new Map<string, HTMLButtonElement | null>());
  // After a move, focus follows the moved newsletter: the same button if it is still
  // enabled, else the other one (a disabled button cannot keep focus).
  const focusAfterMove = useRef<{ id: string; dir: "up" | "down" } | null>(null);
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    const same = moveButtons.current.get(`${target.id}:${target.dir}`);
    const other = moveButtons.current.get(`${target.id}:${target.dir === "up" ? "down" : "up"}`);
    (same && !same.disabled ? same : other)?.focus();
  }, [order]);

  function move(index: number, dir: "up" | "down") {
    const next = moveFeed(order, index, dir === "up" ? -1 : 1);
    if (!next) return;
    const id = order[index];
    setOrder(next);
    setMessage(null);
    setOrderStatus(positionAnnouncement(byId.get(id)?.title ?? "Newsletter", next.indexOf(id), next.length));
    focusAfterMove.current = { id, dir };
  }

  // ---- Preview ---------------------------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const rendererRef = useRef<{ render: RenderSentence; dispose(): void } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function stopPreview() {
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    setPreview({ kind: "idle" });
  }

  useEffect(
    () => () => {
      abortRef.current?.abort();
      rendererRef.current?.dispose();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  async function playPreview() {
    const audio = audioRef.current;
    if (!audio) return;
    stopPreview();
    const abort = new AbortController();
    abortRef.current = abort;
    const v = voice;
    const s = speed;
    setPreview({ kind: "loading" });
    try {
      if (!rendererRef.current) {
        if (fakeRenderer) {
          rendererRef.current = { render: createFakeRenderer({ delayMs: 5 }).render, dispose: () => undefined };
        } else {
          const renderer = createWorkerRenderer({});
          rendererRef.current = { render: renderer.render, dispose: () => renderer.dispose() };
        }
      }
      const { clip } = await rendererRef.current.render(previewSentence(v), v, s, abort.signal);
      if (abort.signal.aborted) return;
      const wav = encodeWav([clip], [0], clip.samples.length, clip.sampleRate);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      audio.src = urlRef.current;
      await audio.play();
      if (abort.signal.aborted) {
        audio.pause();
        return;
      }
      setPreview({ kind: "playing", text: `Preview: ${VOICE_LABELS[v]} at ${speedLabel(s)}.` });
    } catch (error: unknown) {
      if (abort.signal.aborted) return;
      const stage = (error as { stage?: string }).stage;
      setPreview({ kind: "error", text: `Could not play the preview${stage ? ` (${stage})` : ""}. Try again.` });
    }
  }

  // ---- Save ------------------------------------------------------------------------------
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const input: ListenSettings = { voice, speed, feedOrder: orderChanged ? order : saved.feedOrder };
    startTransition(async () => {
      let out: Outcome;
      try {
        out = await save(input);
      } catch {
        out = { ok: false, error: "save_failed" };
      }
      if (out.ok === false) {
        setMessage({ kind: "error", text: LISTEN_ERROR_MESSAGES[out.error] });
        return;
      }
      setSaved(out.value);
      setMessage({ kind: "done", text: `Saved. Your next briefing uses ${VOICE_LABELS[out.value.voice]} at ${speedLabel(out.value.speed)}.` });
    });
  }

  return (
    <form className="px-card" onSubmit={onSubmit} aria-label="Listening settings" data-testid="listening-form">
      <div className="px-field">
        <label htmlFor={voiceId} className="px-label">
          Voice
        </label>
        <select
          id={voiceId}
          className="px-input"
          value={voice}
          onChange={(e) => {
            stopPreview();
            setVoice(e.target.value as BriefingVoice);
          }}
        >
          {BRIEFING_VOICES.map((v) => (
            <option key={v} value={v}>
              {VOICE_LABELS[v]}
            </option>
          ))}
        </select>
      </div>
      <div className="px-field">
        <label htmlFor={speedId} className="px-label">
          Speed
        </label>
        <select
          id={speedId}
          className="px-input"
          value={speed.toFixed(2)}
          onChange={(e) => {
            stopPreview();
            setSpeed(Number(e.target.value));
          }}
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s.toFixed(2)}>
              {speedLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="px-row">
        <button type="button" className="px-btn" onClick={() => void playPreview()} aria-describedby={`${voiceId}-preview`}>
          Preview
        </button>
        <p id={`${voiceId}-preview`} className="px-body px-muted" role="status" data-testid="preview-status">
          {preview.kind === "loading"
            ? fakeRenderer
              ? "Preparing the preview…"
              : "Preparing the preview. The first one loads the voice and can take a minute."
            : preview.kind === "playing" || preview.kind === "error"
              ? preview.text
              : "Hear one sentence in this voice and speed."}
        </p>
      </div>
      <audio ref={audioRef} data-testid="preview-audio" playsInline preload="auto" />

      <section className="px-field" aria-labelledby={orderHeadingId}>
        <h2 id={orderHeadingId} className="px-label">
          Newsletter order
        </h2>
        {feeds.length === 0 ? (
          <p className="px-body">
            No newsletters yet. <Link href="/newsletters">Pick some</Link> and they will show here.
          </p>
        ) : (
          <>
            <p className="px-body px-muted">Your briefing plays them top to bottom. Switched-off newsletters are skipped.</p>
            <ol className="px-list" data-testid="order-list">
              {order.map((id, i) => {
                const feed = byId.get(id);
                if (!feed) return null;
                return (
                  <li key={id}>
                    <span className="px-grow">
                      <span data-testid="order-title">{feed.title}</span>
                      {feed.included ? null : <span className="px-label px-muted">Switched off</span>}
                    </span>
                    <span className="px-row">
                      <button
                        type="button"
                        className="px-btn"
                        ref={(el) => void moveButtons.current.set(`${id}:up`, el)}
                        aria-label={`Move ${feed.title} up`}
                        disabled={i === 0}
                        onClick={() => move(i, "up")}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        className="px-btn"
                        ref={(el) => void moveButtons.current.set(`${id}:down`, el)}
                        aria-label={`Move ${feed.title} down`}
                        disabled={i === order.length - 1}
                        onClick={() => move(i, "down")}
                      >
                        Down
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        <p className="px-body px-muted" aria-live="polite" data-testid="order-status">
          {orderStatus}
        </p>
      </section>

      <div className="px-row">
        <button type="submit" className="px-btn px-btn-primary" disabled={pending || !changed} data-testid="save">
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <div aria-live="polite" role="status">
        {message ? (
          <p className={message.kind === "error" ? "px-alert" : "px-alert px-done"} data-testid={message.kind === "error" ? "settings-error" : "settings-done"}>
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
