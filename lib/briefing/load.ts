// Loads the signed-in user's latest briefing: their summaries for the latest delivery
// window, with each newsletter's name, plus their newsletter order, ready for
// assembleBriefing (lib/briefing/script.ts).
//
// The window: the latest delivery whose pull has started (delivery time and zone from the
// user's settings, else 07:00 UTC; the lead is the server's PULL_LEAD_MINUTES), and every
// issue STORED from that pull's start on. So an issue published days ago but pulled for
// this delivery is in it, and nothing pulled for an earlier delivery is. The date math is
// the scheduled pull's own (public.delivery_due_at, server only,
// supabase/migrations/20261124170000_briefing_loader.sql), so the two always agree.
//
// Every row is read with the user's own client (publishable key, under RLS): settings,
// issues, summaries and feed names. A user only ever gets their own rows
// (tests/db/briefing-loader.test.ts). One summary per issue: the user's chosen length if
// there is one, else the newest. Issues with no summary yet and newsletters switched off
// are left out. At most 200 issues, the newest by received time.
//
// Names, subjects and summaries come from newsletters (untrusted): only well-formed items
// pass, and the script cleans them for speech.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Rpc } from "../mail/token-store";
import { assembleBriefing, type BriefingItem, type BriefingScript } from "./script";

export interface LoadedBriefing {
  /** The delivery this briefing is for (ISO 8601). */
  deliveryAt: string;
  /** Issues stored from this moment on are in it (ISO 8601). */
  windowStart: string;
  /** The user's web feed ids, in briefing order (user_settings.feed_order). */
  feedOrder: string[];
  /** Oldest received first. */
  items: BriefingItem[];
}

export type LoadBriefingResult = { ok: true; value: LoadedBriefing } | { ok: false; error: "load_failed" };

export interface BriefingReaders {
  /** The signed-in user's client (publishable key, RLS). */
  user: Pick<SupabaseClient, "from">;
  /** Server-only RPC (service role), for public.delivery_due_at only. */
  rpc: Rpc;
}

export interface LoadOptions {
  /** PULL_LEAD_MINUTES (lib/schedule/budget.ts, leadMinutesFromEnv). */
  leadMinutes: number;
  now?: Date;
}

export const MAX_BRIEFING_ITEMS = 200;
/** Up to three lengths per issue. */
const MAX_SUMMARY_ROWS = 3 * MAX_BRIEFING_ITEMS;
const MAX_LEAD_MINUTES = 360;
const DEFAULTS = { deliveryTime: "07:00", timezone: "UTC", length: "brief" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isInstant = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One item as merged from the reads, before checks. */
export interface RawBriefingItem {
  id: unknown;
  feed_id: unknown;
  source: unknown;
  subject: unknown;
  summary: unknown;
  partial: unknown;
  received_at: unknown;
}

/** Checks one item. Null when anything is missing or malformed. */
export function parseBriefingItem(raw: RawBriefingItem): BriefingItem | null {
  const source = str(raw.source)?.trim();
  const subject = str(raw.subject);
  const summary = str(raw.summary);
  if (!isUuid(raw.id) || !(raw.feed_id === null || isUuid(raw.feed_id))) return null;
  if (!source || source.length > 500 || subject === null || subject.length > 1_000) return null;
  if (summary === null || summary.trim() === "" || summary.length > 20_000) return null;
  if (typeof raw.partial !== "boolean" || !isInstant(raw.received_at)) return null;
  return {
    id: raw.id.toLowerCase(),
    feedId: isUuid(raw.feed_id) ? raw.feed_id.toLowerCase() : null,
    source,
    subject,
    summary,
    partial: raw.partial,
    receivedAt: new Date(raw.received_at).toISOString(),
  };
}

type Row = Record<string, unknown>;

/** The user's latest briefing. */
export async function loadLatestBriefing(readers: BriefingReaders, options: LoadOptions): Promise<LoadBriefingResult> {
  const fail = { ok: false, error: "load_failed" } as const;
  const lead = Number.isInteger(options.leadMinutes) ? Math.min(Math.max(options.leadMinutes, 0), MAX_LEAD_MINUTES) : 30;
  const now = options.now ?? new Date();
  const { user } = readers;

  // 1. Settings (own row under RLS), else the schedule's defaults.
  const settingsRead = await user.from("user_settings").select("delivery_time, timezone, summary_length, feed_order").limit(1);
  if (settingsRead.error) return fail;
  const s = ((settingsRead.data ?? []) as Row[])[0] ?? {};
  const deliveryTime = str(s.delivery_time) ?? DEFAULTS.deliveryTime;
  const timezone = str(s.timezone) ?? DEFAULTS.timezone;
  const length = str(s.summary_length) ?? DEFAULTS.length;
  const feedOrder = Array.isArray(s.feed_order) ? s.feed_order.filter(isUuid).map((id) => id.toLowerCase()) : [];

  // 2. The window, from the scheduled pull's own math.
  let deliveryAt: Date;
  try {
    const raw = await readers.rpc("delivery_due_at", {
      p_now: now.toISOString(),
      p_time: deliveryTime,
      p_tz: timezone,
      p_lead_minutes: lead,
    });
    if (!isInstant(raw)) return fail;
    deliveryAt = new Date(raw);
  } catch {
    return fail;
  }
  const windowStart = new Date(deliveryAt.getTime() - lead * 60_000).toISOString();
  const empty: LoadedBriefing = { deliveryAt: deliveryAt.toISOString(), windowStart, feedOrder, items: [] };

  // 3. Issues stored in the window (own rows under RLS).
  const issuesRead = await user
    .from("newsletters")
    .select("id, feed_id, sender_name, sender_address, subject, partial, received_at")
    .gte("created_at", windowStart)
    .order("received_at", { ascending: false })
    .limit(MAX_BRIEFING_ITEMS);
  if (issuesRead.error) return fail;
  const issues = (issuesRead.data ?? []) as Row[];
  if (issues.length === 0) return { ok: true, value: empty };

  // 4. Their summaries (a summary is always written after its issue is stored, so the
  //    same lower bound applies) and the feed names.
  const [summariesRead, feedsRead] = await Promise.all([
    user
      .from("summaries")
      .select("newsletter_id, length, summary_text, created_at")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: false })
      .limit(MAX_SUMMARY_ROWS),
    user.from("web_feeds").select("id, title, included"),
  ]);
  if (summariesRead.error || feedsRead.error) return fail;

  const chosen = new Map<string, Row>();
  for (const row of (summariesRead.data ?? []) as Row[]) {
    const id = str(row.newsletter_id)?.toLowerCase();
    if (!id) continue;
    const current = chosen.get(id);
    // Newest first, so the first row seen wins unless a later one has the chosen length.
    if (!current || (current.length !== length && row.length === length)) chosen.set(id, row);
  }
  const feeds = new Map(((feedsRead.data ?? []) as Row[]).map((f) => [str(f.id)?.toLowerCase(), f]));

  const items: BriefingItem[] = [];
  for (const issue of issues) {
    const id = str(issue.id)?.toLowerCase();
    const summary = id ? chosen.get(id) : undefined;
    if (!id || !summary) continue;
    const feedId = str(issue.feed_id)?.toLowerCase() ?? null;
    const feed = feedId ? feeds.get(feedId) : undefined;
    if (feedId && (!feed || feed.included !== true)) continue;
    const item = parseBriefingItem({
      id: issue.id,
      feed_id: issue.feed_id ?? null,
      source: str(feed?.title)?.trim() || str(issue.sender_name)?.trim() || issue.sender_address,
      subject: issue.subject,
      summary: summary.summary_text,
      partial: issue.partial,
      received_at: issue.received_at,
    });
    if (item) items.push(item);
  }
  items.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  return { ok: true, value: { ...empty, items } };
}

/** The script for a loaded briefing, in the user's order. */
export function scriptFor(briefing: LoadedBriefing): BriefingScript {
  return assembleBriefing(briefing.items, { feedOrder: briefing.feedOrder });
}
