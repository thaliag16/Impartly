// The render cost log (GOAL.md Phase 2: "Render cost per briefing logged and within
// budget"). After /listen renders a briefing on the device, it sends render-ahead's report
// here (through the server action in app/listen/actions.ts), and this writes one row to
// public.render_log with the signed-in user's own client, under RLS
// (supabase/migrations/20261124190000_render_log.sql). The database sets user_id and
// created_at itself. Then it reads that briefing's rows back and checks them against the
// budget (./render-budget.ts).
//
// Privacy: the row holds counts and timings only, plus a coarse device class ("mobile",
// "desktop" or "unknown") read from the browser's own mobile flag or the pointer type.
// No user agent string, no IP address, no screen size, no sentence text.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isBriefingVoice, type BriefingVoice } from "../speech/pins";
import { MAX_SPEED, MIN_SPEED, type RenderReport } from "./render-ahead";
import { checkBriefingBudget, summarySpend, type BriefingBudget, type BudgetFlag } from "./render-budget";

export const DEVICE_CLASSES = ["mobile", "desktop", "unknown"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

// Limits, the same as the table's checks.
export const MAX_LOG_CHARS = 2_000_000;
export const MAX_LOG_SENTENCES = 10_000;
export const MAX_LOG_SECONDS = 14_400; // four hours
const EARLIEST_DELIVERY = Date.parse("2026-01-01T00:00:00Z");
const MAX_DELIVERY_AHEAD_MS = 2 * 24 * 3600 * 1000;

/** What the browser sends: the render report, the briefing's delivery time and the hint. */
export interface RenderLogInput {
  deliveryAt: string;
  voice: BriefingVoice;
  speed: number;
  characters: number;
  sentences: number;
  rendered: number;
  cached: number;
  audioSeconds: number;
  renderedAudioSeconds: number;
  renderSeconds: number;
  deviceClass: DeviceClass;
}

/** One row of public.render_log as written (user_id, id and created_at come from the database). */
export interface RenderLogRow {
  delivery_at: string;
  voice: BriefingVoice;
  speed: number;
  chars: number;
  sentences: number;
  rendered: number;
  cached: number;
  audio_seconds: number;
  rendered_audio_seconds: number;
  render_seconds: number;
  device_class: DeviceClass;
}

export type RenderLogError = "invalid_render_log";

/** What /listen's server action answers (app/listen/actions.ts): the budget flags only. */
export type RenderLogOutcome =
  | { ok: true; over: BudgetFlag[] }
  | { ok: false; error: RenderLogError | "save_failed" | "signed_out" };

const FIELDS = new Set<string>([
  "deliveryAt",
  "voice",
  "speed",
  "characters",
  "sentences",
  "rendered",
  "cached",
  "audioSeconds",
  "renderedAudioSeconds",
  "renderSeconds",
  "deviceClass",
]);

export function renderLogInput(report: RenderReport, deliveryAt: string, deviceClass: DeviceClass): RenderLogInput {
  return {
    deliveryAt,
    voice: report.voice,
    speed: report.speed,
    characters: report.characters,
    sentences: report.sentences,
    rendered: report.rendered,
    cached: report.cached,
    audioSeconds: report.audioSeconds,
    renderedAudioSeconds: report.renderedAudioSeconds,
    renderSeconds: report.renderSeconds,
    deviceClass,
  };
}

/** Only a render that rendered something is logged: an all-cached open costs nothing. */
export const shouldLogRender = (report: RenderReport) => report.rendered > 0;

const count = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const seconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_LOG_SECONDS;
const ms = (v: number) => Math.round(v * 1000) / 1000;

function speedOf(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const steps = Math.round(v * 20);
  if (Math.abs(steps - v * 20) > 1e-6) return null;
  const speed = steps / 20;
  return speed >= MIN_SPEED && speed <= MAX_SPEED ? speed : null;
}

/** Validates untrusted input from the browser into a row. */
export function parseRenderLog(
  input: unknown,
  now = Date.now(),
): { ok: true; value: RenderLogRow } | { ok: false; error: RenderLogError } {
  const bad = { ok: false, error: "invalid_render_log" } as const;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad;
  const r = input as Record<string, unknown>;
  if (Object.keys(r).some((k) => !FIELDS.has(k))) return bad;

  if (!isBriefingVoice(r.voice)) return bad;
  const speed = speedOf(r.speed);
  if (speed === null) return bad;
  if (!count(r.characters, MAX_LOG_CHARS)) return bad;
  if (!count(r.sentences, MAX_LOG_SENTENCES) || r.sentences < 1) return bad;
  if (!count(r.rendered, MAX_LOG_SENTENCES) || !count(r.cached, MAX_LOG_SENTENCES)) return bad;
  if (r.rendered < 1 || r.rendered + r.cached !== r.sentences) return bad;
  if (!seconds(r.audioSeconds) || !seconds(r.renderedAudioSeconds) || !seconds(r.renderSeconds)) return bad;
  const audio = ms(r.audioSeconds);
  const renderedAudio = ms(r.renderedAudioSeconds);
  // Float sums may land a hair over the total; anything more is not a real report.
  if (renderedAudio > audio + 0.001) return bad;
  if (typeof r.deliveryAt !== "string") return bad;
  const delivery = Date.parse(r.deliveryAt);
  if (!Number.isFinite(delivery) || delivery < EARLIEST_DELIVERY || delivery > now + MAX_DELIVERY_AHEAD_MS) return bad;
  if (!(DEVICE_CLASSES as readonly unknown[]).includes(r.deviceClass)) return bad;

  return {
    ok: true,
    value: {
      delivery_at: new Date(delivery).toISOString(),
      voice: r.voice,
      speed,
      chars: r.characters,
      sentences: r.sentences,
      rendered: r.rendered,
      cached: r.cached,
      audio_seconds: audio,
      rendered_audio_seconds: Math.min(renderedAudio, audio),
      render_seconds: ms(r.renderSeconds),
      device_class: r.deviceClass as DeviceClass,
    },
  };
}

/**
 * A coarse device class: the browser's own mobile flag (User-Agent Client Hints, where
 * the browser has them), else whether the main pointer is a finger. Never the user agent
 * string, the screen size or anything else that could single out a device.
 */
export function deviceClassHint(nav: {
  userAgentData?: { mobile?: unknown };
  matchMedia?: (query: string) => { matches: boolean };
}): DeviceClass {
  const mobile = nav.userAgentData?.mobile;
  if (typeof mobile === "boolean") return mobile ? "mobile" : "desktop";
  if (typeof nav.matchMedia === "function") return nav.matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop";
  return "unknown";
}

/** Writes one row as the signed-in user, then checks that briefing's renders against the budget. */
export async function writeRenderLog(
  client: SupabaseClient,
  input: unknown,
): Promise<{ ok: true; budget: BriefingBudget } | { ok: false; error: RenderLogError | "save_failed" }> {
  const parsed = parseRenderLog(input);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const row = parsed.value;

  const inserted = await client.from("render_log").insert(row);
  if (inserted.error) return { ok: false, error: "save_failed" };

  // This briefing's renders, the user's own rows only (RLS).
  const read = await client
    .from("render_log")
    .select("delivery_at, audio_seconds, rendered_audio_seconds, render_seconds")
    .eq("delivery_at", row.delivery_at);
  if (read.error || !Array.isArray(read.data) || read.data.length === 0) return { ok: false, error: "save_failed" };
  const rows = (read.data as Record<string, unknown>[]).map((r) => ({
    deliveryAt: row.delivery_at, // the filter's value; Postgres writes the same instant as "+00:00"
    audioSeconds: Number(r.audio_seconds),
    renderedAudioSeconds: Number(r.rendered_audio_seconds),
    renderSeconds: Number(r.render_seconds),
  }));
  if (rows.some((r) => !Number.isFinite(r.audioSeconds + r.renderedAudioSeconds + r.renderSeconds))) {
    return { ok: false, error: "save_failed" };
  }
  // What this briefing's summaries cost: the pipeline's usage rows for this delivery (own
  // rows, RLS). Unreadable means unknown, never a failure: the render row is saved.
  const usage = await client.from("summary_usage").select("cost_usd").eq("delivery_at", row.delivery_at);
  const spend = usage.error || !Array.isArray(usage.data) ? { costUsd: null } : summarySpend(usage.data as { cost_usd: unknown }[]);
  return { ok: true, budget: checkBriefingBudget(rows, spend) };
}
