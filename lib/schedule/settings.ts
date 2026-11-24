import "server-only";

// Reads and writes the signed-in user's delivery time and timezone (user_settings), and
// asks the database for the next delivery. The row is read and written with the user's
// own client (publishable key, under RLS: a user can only touch their own row). Saving a
// new time or zone resets the scheduled pull in the database itself (the trigger in
// supabase/migrations/20261124120000_delivery_settings.sql), whatever wrote the row.
// The next-delivery math is the scheduled pull's own SQL, called with the server's
// service-role RPC (it reads no table).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Rpc } from "../mail";
import {
  DEFAULT_DELIVERY,
  fromDbTime,
  isKnownTimezone,
  parseDeliverySettings,
  type DeliveryError,
  type DeliverySettings,
} from "./delivery";

export interface LoadedDeliverySettings extends DeliverySettings {
  /** False when the user has no row yet (the schedule uses the defaults). */
  saved: boolean;
}

export type SaveDeliveryOutcome =
  | { ok: true; value: DeliverySettings }
  | { ok: false; error: DeliveryError | "save_failed" };

/** The user's settings, the defaults when there is no row, or null when the read failed. */
export async function loadDeliverySettings(client: SupabaseClient): Promise<LoadedDeliverySettings | null> {
  const { data, error } = await client.from("user_settings").select("delivery_time, timezone").limit(1);
  if (error) return null;
  const row = (data ?? [])[0] as { delivery_time?: unknown; timezone?: unknown } | undefined;
  if (!row) return { ...DEFAULT_DELIVERY, saved: false };
  const deliveryTime = fromDbTime(row.delivery_time);
  const timezone = typeof row.timezone === "string" ? row.timezone : null;
  if (!deliveryTime || !timezone) return null;
  return { deliveryTime, timezone, saved: true };
}

/** Validates untrusted input, then updates the user's row, or inserts it when there is none. */
export async function saveDeliverySettings(client: SupabaseClient, userId: string, input: unknown): Promise<SaveDeliveryOutcome> {
  const parsed = parseDeliverySettings(input);
  if ("error" in parsed) return parsed;
  const { deliveryTime, timezone } = parsed.value;
  const values = { delivery_time: deliveryTime, timezone, updated_at: new Date().toISOString() };

  const updated = await client.from("user_settings").update(values).eq("user_id", userId).select("user_id");
  if (updated.error) return { ok: false, error: errorFor(updated.error.code) };
  if ((updated.data ?? []).length === 0) {
    const inserted = await client.from("user_settings").insert({ user_id: userId, delivery_time: deliveryTime, timezone });
    if (inserted.error) {
      // Another save inserted the row first: update it instead.
      if (inserted.error.code !== "23505") return { ok: false, error: errorFor(inserted.error.code) };
      const retry = await client.from("user_settings").update(values).eq("user_id", userId).select("user_id");
      if (retry.error || (retry.data ?? []).length === 0) return { ok: false, error: "save_failed" };
    }
  }
  return { ok: true, value: parsed.value };
}

/** 23514: the database's own zone check refused a name this runtime accepted. */
function errorFor(code: string | undefined): "invalid_timezone" | "save_failed" {
  return code === "23514" ? "invalid_timezone" : "save_failed";
}

/** The next delivery strictly after `now`, or null when it cannot be worked out. */
export async function nextDelivery(rpc: Rpc, now: Date, settings: DeliverySettings): Promise<Date | null> {
  if (!isKnownTimezone(settings.timezone)) return null;
  try {
    const raw = await rpc("delivery_next_after", {
      p_after: now.toISOString(),
      p_time: settings.deliveryTime,
      p_tz: settings.timezone,
    });
    const t = typeof raw === "string" ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  } catch {
    return null;
  }
}
