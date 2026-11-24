// Delivery time and timezone: the values the settings screen offers, their validation and
// the "Your next briefing" label. Pure and browser-safe (the settings form imports it).
// The schedule math itself (which instant "07:00 in Europe/Berlin" is on a given day,
// daylight saving included) lives in SQL with the scheduled pull: the page asks
// public.delivery_next_after for the instant and only formats it here.
//
// The database has the final word on a zone: user_settings.timezone must be a name
// Postgres knows (pg_timezone_names). Zones are checked here first so a bad value never
// reaches it.

/** Delivery times offered: every 15 minutes, "00:00" to "23:45". */
export const DELIVERY_STEP_MINUTES = 15;
export const DELIVERY_TIMES: readonly string[] = Object.freeze(
  Array.from({ length: (24 * 60) / DELIVERY_STEP_MINUTES }, (_, i) => {
    const m = i * DELIVERY_STEP_MINUTES;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }),
);

/** The schedule's defaults when a user has no settings row (pull_claim_next). */
export const DEFAULT_DELIVERY = Object.freeze({ deliveryTime: "07:00", timezone: "UTC" });

export interface DeliverySettings {
  deliveryTime: string;
  timezone: string;
}

export type DeliveryError = "invalid_time" | "invalid_timezone";

/** What the settings screen's save action returns; `next` is the "Wed 7:00 AM" label. */
export type SaveOutcome =
  | { ok: true; value: DeliverySettings; next: string | null }
  | { ok: false; error: DeliveryError | "save_failed" | "signed_out" };

export const DELIVERY_ERROR_MESSAGES: Record<DeliveryError | "signed_out" | "save_failed", string> = {
  invalid_time: "Pick a time from the list (every 15 minutes).",
  invalid_timezone: "Pick a time zone from the list.",
  signed_out: "You are signed out. Sign in again to save.",
  save_failed: "Could not save. Nothing was changed; try again.",
};

export function isDeliveryTime(value: unknown): value is string {
  return typeof value === "string" && DELIVERY_TIMES.includes(value);
}

/**
 * Old zone names that browsers and Node (ICU) still report, with the current IANA name.
 * Postgres builds that ship tzdata without its "backward" links (Ubuntu's, for one) know
 * only the current names, so Impartly always offers and stores those. A test checks that
 * every offered zone is one Postgres accepts (tests/db/delivery-settings.test.ts).
 */
export const LEGACY_ZONES: Readonly<Record<string, string>> = Object.freeze({
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
});

/** The current IANA name for a zone ("Asia/Calcutta" as "Asia/Kolkata"). */
export function currentZoneName(tz: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_ZONES, tz) ? LEGACY_ZONES[tz] : tz;
}

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;

/** An IANA zone name this runtime knows ("UTC", "America/Los_Angeles"). */
export function isKnownTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Validates untrusted input (a server action's argument). */
export function parseDeliverySettings(input: unknown): { ok: true; value: DeliverySettings } | { ok: false; error: DeliveryError } {
  const o = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (!isDeliveryTime(o.deliveryTime)) return { ok: false, error: "invalid_time" };
  if (!isKnownTimezone(o.timezone)) return { ok: false, error: "invalid_timezone" };
  return { ok: true, value: { deliveryTime: o.deliveryTime, timezone: currentZoneName(o.timezone) } };
}

/** Postgres `time` ("07:00:00") as "07:00"; null for anything else. */
export function fromDbTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d(\.\d+)?)?$/.exec(value);
  return m ? `${m[1]}:${m[2]}` : null;
}

/** "07:00" as "7:00 AM", "13:45" as "1:45 PM", "00:15" as "12:15 AM". */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Zone names offered: UTC, then every zone the runtime lists under its current name, in
 * order, plus any extras (the saved one, kept as saved).
 */
export function timezoneOptions(extra: readonly string[] = []): string[] {
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const out = new Set<string>(["UTC", ...listed.map(currentZoneName).sort()]);
  for (const tz of extra) if (isKnownTimezone(tz)) out.add(tz);
  return [...out];
}

/** "America/Los_Angeles" as "America/Los Angeles". */
export function timezoneLabel(tz: string): string {
  return tz.replace(/_/g, " ");
}

/** The next briefing as the user reads it: "Wed 7:00 AM" in their zone. */
export function nextBriefingLabel(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}
