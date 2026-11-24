"use client";

// The picker's interactive part. Server actions arrive as props from page.tsx (this file
// imports no server module). Every control is a real <button>, <input> or <label>;
// results and errors are announced through a polite live region. Watermelon is used for
// exactly one control at a time: "Add" while a new feed is previewed, otherwise "Find".

import { useId, useRef, useState, useTransition } from "react";
import { matchPicks } from "../../lib/feeds/search";
import {
  ERROR_MESSAGES,
  type AddOutcome,
  type CatalogPick,
  type ChangeOutcome,
  type FeedPreview,
  type FeedRow,
  type PickerError,
  type PreviewOutcome,
} from "../../lib/feeds/types";
import { CheckIcon, CrossIcon, PlusIcon, SearchIcon } from "../ui/icons";

export interface PickerActions {
  preview(query: string): Promise<PreviewOutcome>;
  add(query: string): Promise<AddOutcome>;
  setIncluded(feedId: string, included: boolean): Promise<ChangeOutcome>;
  remove(feedId: string): Promise<ChangeOutcome>;
}

type Message = { kind: "error" | "done"; text: string };

const SUGGESTED = 6;

function formatDate(iso: string | null): string {
  if (!iso) return "No dated issues";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No dated issues";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function Picker({
  feeds,
  catalog,
  actions,
  listUnavailable,
}: {
  feeds: FeedRow[];
  catalog: CatalogPick[];
  actions: PickerActions;
  listUnavailable: boolean;
}) {
  const inputId = useId();
  const hintId = useId();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = matchPicks(catalog, query);
  const added = preview ? feeds.find((f) => f.feed_url === preview.feedUrl) : undefined;
  const addIsMain = !!preview && !added;

  const fail = (error: PickerError | "not_yours") => setMessage({ kind: "error", text: ERROR_MESSAGES[error] });

  const run = (key: string, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    startTransition(async () => {
      try {
        await task();
      } catch {
        fail("failed");
      } finally {
        setBusy(null);
      }
    });
  };

  const find = (q: string) =>
    run("find", async () => {
      setMessage(null);
      setPreview(null);
      setConfirmRemove(null);
      const out = await actions.preview(q);
      if ("error" in out) fail(out.error);
      else setPreview(out.preview);
    });

  const add = (p: FeedPreview) =>
    run("add", async () => {
      const out = await actions.add(p.query);
      if ("error" in out) return fail(out.error);
      setPreview(null);
      setQuery("");
      setMessage({
        kind: "done",
        text: out.inserted ? `Added ${out.title}.` : `${out.title} was already in your list. It is switched on.`,
      });
      inputRef.current?.focus();
    });

  const toggle = (f: FeedRow) =>
    run(`toggle:${f.id}`, async () => {
      const out = await actions.setIncluded(f.id, !f.included);
      if ("error" in out) return fail(out.error);
      setMessage({ kind: "done", text: `${f.title} is ${f.included ? "off" : "on"}.` });
    });

  const remove = (f: FeedRow) =>
    run(`remove:${f.id}`, async () => {
      const out = await actions.remove(f.id);
      setConfirmRemove(null);
      if ("error" in out) return fail(out.error);
      setMessage({ kind: "done", text: `Removed ${f.title}.` });
      inputRef.current?.focus();
    });

  return (
    <>
      <section className="px-card" aria-labelledby={`${inputId}-h`}>
        <h2 id={`${inputId}-h`} className="px-h2">
          Find a newsletter
        </h2>
        <form
          role="search"
          className="px-field"
          onSubmit={(e) => {
            e.preventDefault();
            find(query);
          }}
        >
          <label htmlFor={inputId} className="px-label">
            Name or website
          </label>
          <div className="px-row">
            <input
              id={inputId}
              ref={inputRef}
              className="px-input px-grow"
              name="q"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={300}
              required
              placeholder="TechCrunch, or example.com"
              aria-describedby={hintId}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPreview(null);
              }}
            />
            <button
              type="submit"
              className={addIsMain ? "px-btn" : "px-btn px-btn-primary"}
              disabled={!!busy}
              data-testid="find"
            >
              <SearchIcon />
              {busy === "find" ? "Looking…" : "Find"}
            </button>
          </div>
          <span id={hintId} className="px-label px-muted">
            Catalog names, a domain, or a feed address
          </span>
        </form>

        {matches.length > 0 && !preview ? (
          <div className="px-field">
            <h3 className="px-label">In the catalog</h3>
            <ul className="px-list" aria-label="Catalog matches">
              {matches.map((m) => (
                <li key={m.id}>
                  <span className="px-grow">
                    <strong>{m.name}</strong>
                    <span className="px-label px-muted">{m.site}</span>
                  </span>
                  <button type="button" className="px-btn" disabled={!!busy} aria-label={`Check ${m.name}`} onClick={() => {
                    setQuery(m.name);
                    find(m.id);
                  }}>
                    Check
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <div aria-live="polite" className="px-field" data-testid="picker-status">
        {message ? (
          <p className={message.kind === "error" ? "px-alert" : "px-alert px-done"} role={message.kind === "error" ? "alert" : "status"} data-testid={message.kind === "error" ? "picker-error" : "picker-done"}>
            {message.text}
          </p>
        ) : null}
        {preview ? (
          <section className="px-card-green" aria-label={`Found: ${preview.title}`} data-testid="preview">
            <span className="px-label">Found a public feed</span>
            <h3 className="px-h2">{preview.title}</h3>
            <dl className="px-row" style={{ margin: 0, gap: "4px 16px" }}>
              <dt className="px-label">Site</dt>
              <dd style={{ margin: 0 }}>{preview.site || hostOf(preview.feedUrl)}</dd>
              <dt className="px-label">Last issue</dt>
              <dd style={{ margin: 0 }} data-testid="preview-last-issue">
                {formatDate(preview.lastIssueAt)}
              </dd>
              <dt className="px-label">Issues in feed</dt>
              <dd style={{ margin: 0 }}>{preview.itemCount}</dd>
            </dl>
            {added ? (
              <p className="px-body">Already in your list.</p>
            ) : (
              <div className="px-row">
                <button type="button" className="px-btn px-btn-primary" disabled={!!busy} onClick={() => add(preview)} data-testid="add">
                  <PlusIcon />
                  {busy === "add" ? "Adding…" : `Add ${preview.title}`}
                </button>
                <button type="button" className="px-btn" disabled={!!busy} onClick={() => setPreview(null)}>
                  Not this one
                </button>
              </div>
            )}
          </section>
        ) : null}
      </div>

      <section className="px-field" aria-labelledby={`${inputId}-mine`}>
        <h2 id={`${inputId}-mine`} className="px-h2">
          Your newsletters
        </h2>
        {listUnavailable ? (
          <p className="px-alert" role="alert">
            Your list could not be loaded right now. Please reload the page.
          </p>
        ) : feeds.length === 0 ? (
          <div className="px-card" data-testid="empty-state">
            <p className="px-body">
              <strong>Nothing here yet.</strong> Start with a pick from the catalog:
            </p>
            <ul className="px-list" aria-label="Suggested newsletters">
              {catalog.slice(0, SUGGESTED).map((m) => (
                <li key={m.id}>
                  <span className="px-grow">
                    <strong>{m.name}</strong>
                    <span className="px-label px-muted">{m.site}</span>
                  </span>
                  <button type="button" className="px-btn" disabled={!!busy} aria-label={`Check ${m.name}`} onClick={() => {
                    setQuery(m.name);
                    find(m.id);
                  }}>
                    Check
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="px-list" aria-label="Your newsletters" data-testid="feed-list">
            {feeds.map((f) => (
              <li key={f.id} data-testid="feed-row">
                <span className={f.included ? "px-dot px-dot-on" : "px-dot"} aria-hidden="true" />
                <span className="px-grow">
                  <strong>{f.title}</strong>
                  <span className="px-label px-muted">
                    {hostOf(f.homepage_url) || hostOf(f.feed_url)}
                    {f.last_error ? " · last check failed" : f.last_fetched_at ? ` · checked ${formatDate(f.last_fetched_at)}` : " · not checked yet"}
                  </span>
                </span>
                {confirmRemove === f.id ? (
                  <span className="px-row" role="group" aria-label={`Remove ${f.title}?`}>
                    <span className="px-body">Remove it and its saved issues?</span>
                    <button type="button" className="px-btn" disabled={!!busy} onClick={() => remove(f)}>
                      <CheckIcon />
                      Yes, remove
                    </button>
                    <button type="button" className="px-btn" disabled={!!busy} onClick={() => setConfirmRemove(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="px-row">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={f.included}
                      className="px-switch"
                      disabled={!!busy}
                      onClick={() => toggle(f)}
                    >
                      <span className="px-visually-hidden">Include {f.title} in briefings</span>
                      <span aria-hidden="true">{f.included ? "On" : "Off"}</span>
                    </button>
                    <button
                      type="button"
                      className="px-btn"
                      disabled={!!busy}
                      aria-label={`Remove ${f.title}`}
                      onClick={() => setConfirmRemove(f.id)}
                    >
                      <CrossIcon />
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
