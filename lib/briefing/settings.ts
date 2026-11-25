// Reads and writes the signed-in user's listening settings (GOAL.md Phase 2): voice,
// playback speed and newsletter order, all in their own user_settings row. Read and
// written with the user's own client (publishable key, under RLS: a user can touch only
// their own row; tests/db/listen-settings.test.ts). Saving voice, speed or order does not
// touch the delivery schedule (that trigger fires only on delivery time and timezone).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isBriefingVoice, type BriefingVoice } from "../speech/pins";
import { MAX_SPEED, MIN_SPEED } from "./render-ahead";

export interface ListenSettings {
  voice: BriefingVoice;
  /** Playback speed passed to Kokoro, 0.50 to 2.00 in 0.05 steps. */
  speed: number;
  /** The user's web feed ids, in briefing order. */
  feedOrder: string[];
}

export interface LoadedListenSettings extends ListenSettings {
  saved: boolean;
}

export type ListenSettingsError = "invalid_voice" | "invalid_speed" | "invalid_order";

export const DEFAULT_LISTEN_SETTINGS: Readonly<ListenSettings> = Object.freeze({
  voice: "af_heart",
  speed: 1,
  feedOrder: [] as string[],
});

/** Matches the database's limit (cardinality <= 200). */
export const MAX_FEED_ORDER = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plain decimals only ("1.25"); not "0x1", "1e0" or "Infinity", which Number() would take. */
const DECIMAL = /^\s*\d+(?:\.\d+)?\s*$/;

function parseSpeed(value: unknown): number | null {
  if (typeof value === "string" && !DECIMAL.test(value)) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const steps = Math.round(n * 20);
  if (Math.abs(steps - n * 20) > 1e-6) return null;
  const speed = steps / 20;
  return speed >= MIN_SPEED && speed <= MAX_SPEED ? speed : null;
}

/** Validates untrusted input. `ownFeedIds` are the user's own web feed ids. */
export function parseListenSettings(
  input: unknown,
  ownFeedIds: readonly string[],
): { ok: true; value: ListenSettings } | { ok: false; error: ListenSettingsError } {
  const record = (input ?? {}) as Record<string, unknown>;
  if (!isBriefingVoice(record.voice)) return { ok: false, error: "invalid_voice" };
  const speed = parseSpeed(record.speed);
  if (speed === null) return { ok: false, error: "invalid_speed" };
  const order = record.feedOrder;
  const own = new Set(ownFeedIds.map((id) => id.toLowerCase()));
  if (
    !Array.isArray(order) ||
    order.length > MAX_FEED_ORDER ||
    !order.every((id) => typeof id === "string" && UUID.test(id) && own.has(id.toLowerCase())) ||
    new Set(order.map((id: string) => id.toLowerCase())).size !== order.length
  ) {
    return { ok: false, error: "invalid_order" };
  }
  return { ok: true, value: { voice: record.voice, speed, feedOrder: order.map((id: string) => id.toLowerCase()) } };
}

/** The user's settings, the defaults when there is no row, or null when the read failed. */
export async function loadListenSettings(client: SupabaseClient): Promise<LoadedListenSettings | null> {
  const { data, error } = await client.from("user_settings").select("voice, speed, feed_order").limit(1);
  if (error) return null;
  const row = (data ?? [])[0] as { voice?: unknown; speed?: unknown; feed_order?: unknown } | undefined;
  if (!row) return { ...DEFAULT_LISTEN_SETTINGS, feedOrder: [], saved: false };
  const speed = parseSpeed(row.speed);
  if (!isBriefingVoice(row.voice) || speed === null) return null;
  const feedOrder = Array.isArray(row.feed_order)
    ? row.feed_order.filter((id): id is string => typeof id === "string" && UUID.test(id))
    : [];
  return { voice: row.voice, speed, feedOrder, saved: true };
}

/** Validates, then updates the user's row, or inserts it when there is none. */
export async function saveListenSettings(
  client: SupabaseClient,
  userId: string,
  input: unknown,
): Promise<{ ok: true; value: ListenSettings } | { ok: false; error: ListenSettingsError | "save_failed" }> {
  // The order may name only the user's own feeds (read under RLS).
  const feeds = await client.from("web_feeds").select("id");
  if (feeds.error) return { ok: false, error: "save_failed" };
  const own = ((feeds.data ?? []) as { id: string }[]).map((f) => f.id);
  const parsed = parseListenSettings(input, own);
  if (!parsed.ok) return parsed;

  const { voice, speed, feedOrder } = parsed.value;
  const values = { voice, speed, feed_order: feedOrder };
  const updated = await client
    .from("user_settings")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .select("user_id");
  if (updated.error) return { ok: false, error: "save_failed" };
  if ((updated.data ?? []).length === 0) {
    const inserted = await client.from("user_settings").insert({ user_id: userId, ...values });
    if (inserted.error) {
      if (inserted.error.code !== "23505") return { ok: false, error: "save_failed" };
      const retry = await client
        .from("user_settings")
        .update({ ...values, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .select("user_id");
      if (retry.error || (retry.data ?? []).length === 0) return { ok: false, error: "save_failed" };
    }
  }
  return parsed;
}

// ---- The listening settings screen (app/settings/listening) ------------------------------

/** Every speed the screen offers: 0.50x to 2.00x in 0.05 steps (decided 2026-11-24). */
export const SPEED_OPTIONS: readonly number[] = Object.freeze(
  Array.from({ length: Math.round((MAX_SPEED - MIN_SPEED) * 20) + 1 }, (_, i) => (MIN_SPEED * 20 + i) / 20),
);

export const speedLabel = (speed: number) => `${speed.toFixed(2)}x`;

export const VOICE_LABELS: Readonly<Record<BriefingVoice, string>> = Object.freeze({ af_heart: "Heart", bm_daniel: "Daniel" });

/** The one sentence the voice preview reads. */
export const previewSentence = (voice: BriefingVoice) =>
  `This is ${VOICE_LABELS[voice]}, reading your briefing at the speed you picked.`;

export const LISTEN_ERROR_MESSAGES: Readonly<Record<ListenSettingsError | "save_failed" | "signed_out", string>> = Object.freeze({
  invalid_voice: "Pick one of the two voices.",
  invalid_speed: "Pick a speed between 0.50x and 2.00x.",
  invalid_order: "Your newsletters changed since this page opened. Reload the page and try again.",
  save_failed: "Could not save your settings. Try again.",
  signed_out: "You were signed out. Sign in again to save.",
});

export interface OrderableFeed {
  id: string;
  title: string;
  included: boolean;
}

/** The saved order cut down to the user's current feeds, lower case, once each. */
export function savedOrderFor(feeds: readonly OrderableFeed[], savedOrder: readonly string[]): string[] {
  const own = new Set(feeds.map((f) => f.id.toLowerCase()));
  const out: string[] = [];
  for (const raw of savedOrder) {
    const id = raw.toLowerCase();
    if (own.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The feeds as the screen lists them: the saved order first, then the rest as given. */
export function orderFeeds<T extends OrderableFeed>(feeds: readonly T[], savedOrder: readonly string[]): T[] {
  const byId = new Map(feeds.map((f) => [f.id.toLowerCase(), f]));
  const placed = savedOrderFor(feeds, savedOrder).map((id) => byId.get(id)!);
  return [...placed, ...feeds.filter((f) => !placed.includes(f))];
}

/** The order with the item at `index` moved one place; null when it would leave the list. */
export function moveFeed(order: readonly string[], index: number, delta: -1 | 1): string[] | null {
  const to = index + delta;
  if (index < 0 || index >= order.length || to < 0 || to >= order.length) return null;
  const next = [...order];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export const positionAnnouncement = (title: string, index: number, total: number) =>
  `${title} moved to position ${index + 1} of ${total}.`;
