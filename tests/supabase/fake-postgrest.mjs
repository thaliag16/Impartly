// A fake Supabase REST API (PostgREST) for the UI tests, in memory, with invented data only.
// It covers what the newsletter picker uses:
//   * GET  /rest/v1/web_feeds          the signed-in user's own feeds (as RLS would allow)
//   * POST /rest/v1/rpc/<fn>           feeds_discovery_take, feeds_subscribe,
//                                      feeds_set_included, feeds_remove: service key only,
//                                      each scoped to the p_user_id it is given, as the SQL is
//   * GET/PATCH/POST /rest/v1/user_settings   the signed-in user's own row only (as RLS would
//                                      allow): read, update, insert; another user's id is refused;
//                                      voice, speed (numeric, read back as text) and feed_order
//                                      with the table's own checks
//   * POST /rest/v1/rpc/delivery_next_after   service key only; a stand-in for the SQL math
//                                      (tested on real Postgres in tests/db/delivery-settings.test.ts)
//   * POST /rest/v1/rpc/delivery_due_at   service key only; a stand-in for the SQL math
//                                      (tested on real Postgres in tests/db/briefing-loader.test.ts)
//   * GET  /rest/v1/newsletters, /rest/v1/summaries   the signed-in user's own rows (as RLS
//                                      would allow), with select, `<col>=gte.<value>`, order
//                                      and limit, as lib/briefing/load.ts reads them
//   * any other GET /rest/v1/<table>   [] for a signed-in user (no database here)
// Test controls (not part of Supabase): POST /__e2e/reset, POST /__e2e/exhaust-rate-limit,
// POST /__e2e/seed-briefing ({ user_id, feeds, newsletters, summaries }: invented rows for
// one user), GET /__e2e/state. The SQL these stand in for is tested on real Postgres in tests/db/.

import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * @param {{ serviceKey: string, userIdForToken: (token: string) => Promise<string | null> }} options
 */
export function createFakePostgrest({ serviceKey, userIdForToken }) {
  let feeds = []; // { id, user_id, feed_url, feed_format, title, homepage_url, catalog_id, included, ... }
  let settings = []; // { user_id, delivery_time ("07:00:00"), timezone, voice, speed ("1.00"), feed_order, updated_at }
  let attempts = new Map(); // user id -> [ms timestamps]
  let newsletters = []; // { id, user_id, feed_id, sender_name, sender_address, subject, partial, received_at, created_at }
  let summaries = []; // { newsletter_id, user_id, length, summary_text, created_at }
  let renderLog = []; // { id, user_id, delivery_at, voice, speed, chars, ..., device_class, created_at }
  let exhausted = false;
  const calls = [];

  const reset = () => {
    feeds = [];
    settings = [];
    attempts = new Map();
    newsletters = [];
    summaries = [];
    renderLog = [];
    exhausted = false;
    calls.length = 0;
  };

  const rpc = {
    feeds_discovery_take({ p_user_id, p_limit, p_window_seconds }) {
      if (exhausted) return false;
      const now = Date.now();
      const recent = (attempts.get(p_user_id) ?? []).filter((t) => t > now - p_window_seconds * 1000);
      if (recent.length >= p_limit) return false;
      recent.push(now);
      attempts.set(p_user_id, recent);
      return true;
    },
    feeds_subscribe({ p_user_id, p_feed_url, p_feed_format, p_title, p_homepage_url, p_catalog_id }) {
      const existing = feeds.find((f) => f.user_id === p_user_id && f.feed_url === p_feed_url);
      if (existing) {
        existing.included = true;
        return { id: existing.id, inserted: false };
      }
      const row = {
        id: randomUUID(),
        user_id: p_user_id,
        feed_url: p_feed_url,
        feed_format: p_feed_format,
        title: String(p_title).slice(0, 200),
        homepage_url: p_homepage_url,
        catalog_id: p_catalog_id,
        included: true,
        last_fetched_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
      };
      feeds.push(row);
      return { id: row.id, inserted: true };
    },
    feeds_set_included({ p_user_id, p_feed_id, p_included }) {
      const f = feeds.find((x) => x.id === p_feed_id && x.user_id === p_user_id);
      if (!f) return false;
      f.included = p_included;
      return true;
    },
    feeds_remove({ p_user_id, p_feed_id }) {
      const before = feeds.length;
      feeds = feeds.filter((x) => !(x.id === p_feed_id && x.user_id === p_user_id));
      return feeds.length < before;
    },
    delivery_next_after({ p_after, p_time, p_tz }) {
      return nextDeliveryAfter(new Date(p_after), String(p_time), String(p_tz)).toISOString();
    },
    delivery_due_at({ p_now, p_time, p_tz, p_lead_minutes }) {
      return latestDeliveryDueAt(new Date(p_now), String(p_time).slice(0, 5), String(p_tz), Number(p_lead_minutes)).toISOString();
    },
  };

  /** Returns a Response, or null when the path is not this fake's. */
  async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/reset" && request.method === "POST") {
      reset();
      return json(200, { ok: true });
    }
    if (url.pathname === "/__e2e/exhaust-rate-limit" && request.method === "POST") {
      exhausted = true;
      return json(200, { ok: true });
    }
    if (url.pathname === "/__e2e/seed-briefing" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const user_id = body.user_id;
      const now = new Date().toISOString();
      for (const f of body.feeds ?? []) {
        feeds.push({ included: true, feed_format: "rss", created_at: now, ...f, user_id });
      }
      for (const n of body.newsletters ?? []) {
        newsletters.push({ id: randomUUID(), feed_id: null, sender_name: null, sender_address: "news@invented.example", subject: "", partial: false, created_at: now, ...n, user_id });
      }
      for (const x of body.summaries ?? []) summaries.push({ length: "brief", created_at: now, ...x, user_id });
      return json(200, { ok: true });
    }
    if (url.pathname === "/__e2e/state" && request.method === "GET") {
      return json(200, { feeds, settings, calls, renderLog });
    }
    if (!url.pathname.startsWith("/rest/v1/")) return null;

    const apikey = request.headers.get("apikey") ?? "";
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch && request.method === "POST") {
      // Server-only functions: the service key, never a user's session.
      if (apikey !== serviceKey) return json(401, { message: "permission denied" });
      const fn = rpc[rpcMatch[1]];
      if (!fn) return json(404, { code: "PGRST202", message: "function not found" });
      const args = await request.json().catch(() => ({}));
      calls.push({ fn: rpcMatch[1], args });
      return json(200, fn(args));
    }

    if (url.pathname === "/rest/v1/user_settings") {
      const userId = await userIdForToken(bearer);
      if (!userId) return json(401, { message: "JWT invalid" });
      return userSettings(request, url, userId);
    }

    if (url.pathname === "/rest/v1/render_log") {
      const userId = await userIdForToken(bearer);
      if (!userId) return json(401, { message: "JWT invalid" });
      return renderLogRoute(request, url, userId);
    }

    if (request.method === "GET") {
      const userId = await userIdForToken(bearer);
      if (!userId) return json(401, { message: "JWT invalid" });
      if (url.pathname === "/rest/v1/web_feeds") {
        const cols = (url.searchParams.get("select") ?? "*").split(",").map((c) => c.trim());
        const rows = feeds
          .filter((f) => f.user_id === userId)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((f) => (cols.includes("*") ? { ...f } : Object.fromEntries(cols.map((c) => [c, f[c] ?? null]))));
        return json(200, rows);
      }
      if (url.pathname === "/rest/v1/newsletters") return json(200, query(newsletters, url, userId));
      if (url.pathname === "/rest/v1/summaries") return json(200, query(summaries, url, userId));
      return json(200, []);
    }
    return json(405, { message: "not supported by the fake" });
  }

  async function userSettings(request, url, userId) {
    const pick = (row) => {
      const cols = (url.searchParams.get("select") ?? "*").split(",").map((c) => c.trim());
      return cols.includes("*") ? { ...row } : Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
    };
    const own = () => settings.filter((r) => r.user_id === userId);
    const validTime = (t) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(t);
    const validZone = (tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return typeof tz === "string";
      } catch {
        return false;
      }
    };
    const check = (body) => {
      if ("delivery_time" in body && !validTime(body.delivery_time)) return json(400, { code: "22007", message: "invalid time" });
      if ("timezone" in body && !validZone(body.timezone)) return json(400, { code: "23514", message: "check violation" });
      // The table's checks: voice in the two voices, speed numeric(3,2) 0.50 to 2.00, at most
      // 200 non-null uuids in feed_order.
      if ("voice" in body && !["af_heart", "bm_daniel"].includes(body.voice)) return json(400, { code: "23514", message: "check violation" });
      if ("speed" in body) {
        const n = Number(body.speed);
        if (!Number.isFinite(n) || n < 0.5 || n > 2) return json(400, { code: "23514", message: "check violation" });
      }
      if (
        "feed_order" in body &&
        !(Array.isArray(body.feed_order) && body.feed_order.length <= 200 && body.feed_order.every((id) => typeof id === "string" && UUID.test(id)))
      ) {
        return json(400, { code: "23514", message: "check violation" });
      }
      return null;
    };
    const asSpeed = (v) => Number(v).toFixed(2);
    const asTime = (t) => (t.length === 5 ? `${t}:00` : t);

    if (request.method === "GET") return json(200, own().map(pick));
    const body = await request.json().catch(() => ({}));
    if (request.method === "PATCH") {
      // Only `user_id=eq.<id>` filters; RLS limits the update to the caller's own row anyway.
      const filter = url.searchParams.get("user_id");
      const target = filter?.startsWith("eq.") ? filter.slice(3) : null;
      const bad = check(body);
      if (bad) return bad;
      const rows = own().filter((r) => target === null || r.user_id === target);
      for (const r of rows) {
        if (body.delivery_time) r.delivery_time = asTime(body.delivery_time);
        if (body.timezone) r.timezone = body.timezone;
        if ("voice" in body) r.voice = body.voice;
        if ("speed" in body) r.speed = asSpeed(body.speed);
        if ("feed_order" in body) r.feed_order = [...body.feed_order];
        r.updated_at = new Date().toISOString();
      }
      return url.searchParams.has("select") ? json(200, rows.map(pick)) : new Response(null, { status: 204 });
    }
    if (request.method === "POST") {
      if (body.user_id !== userId) return json(403, { code: "42501", message: "new row violates row-level security policy" });
      if (own().length) return json(409, { code: "23505", message: "duplicate key value" });
      const bad = check(body);
      if (bad) return bad;
      settings.push({
        user_id: userId,
        delivery_time: asTime(body.delivery_time ?? "07:00"),
        timezone: body.timezone ?? "UTC",
        voice: body.voice ?? "af_heart",
        speed: asSpeed(body.speed ?? 1),
        feed_order: [...(body.feed_order ?? [])],
        summary_length: "brief",
        updated_at: new Date().toISOString(),
      });
      return new Response(null, { status: 201 });
    }
    return json(405, { message: "not supported by the fake" });
  }

  // render_log (supabase/migrations/20261124190000_render_log.sql): the user reads their own
  // rows and inserts rows for themselves only; no update or delete. user_id comes from the
  // token (the column's default, auth.uid()); id and created_at cannot be sent.
  async function renderLogRoute(request, url, userId) {
    if (request.method === "GET") return json(200, query(renderLog, url, userId));
    if (request.method !== "POST") return json(403, { code: "42501", message: "permission denied for table render_log" });
    const body = await request.json().catch(() => null);
    const rows = Array.isArray(body) ? body : [body];
    const fresh = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") return json(400, { message: "bad body" });
      if ("id" in r || "created_at" in r) return json(403, { code: "42501", message: "permission denied for table render_log" });
      if ("user_id" in r && r.user_id !== userId) {
        return json(403, { code: "42501", message: "new row violates row-level security policy" });
      }
      // The table's checks.
      const finite = (v) => typeof v === "number" && v >= 0 && v <= 14400;
      if (
        !["af_heart", "bm_daniel"].includes(r.voice) ||
        !(Number(r.speed) >= 0.5 && Number(r.speed) <= 2) ||
        !["mobile", "desktop", "unknown"].includes(r.device_class) ||
        !(Number.isInteger(r.sentences) && r.sentences >= 1 && r.rendered >= 1 && r.rendered + r.cached === r.sentences) ||
        ![r.audio_seconds, r.rendered_audio_seconds, r.render_seconds].every(finite) ||
        r.rendered_audio_seconds > r.audio_seconds ||
        typeof r.delivery_at !== "string"
      ) {
        return json(400, { code: "23514", message: "check violation" });
      }
      fresh.push({ ...r, id: randomUUID(), user_id: userId, created_at: new Date().toISOString() });
    }
    renderLog.push(...fresh);
    return new Response(null, { status: 201 });
  }

  return { handle, reset };
}

/** The user's own rows (as RLS), with PostgREST's select, `gte` and `eq` filters, order and limit. */
function query(table, url, userId) {
  let rows = table.filter((r) => r.user_id === userId);
  for (const [key, value] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (value.startsWith("eq.")) {
      const want = value.slice(3);
      rows = rows.filter((r) => r[key] !== null && compare(r[key], want) === 0);
      continue;
    }
    if (!value.startsWith("gte.")) throw new Error(`filter not supported by the fake: ${key}=${value}`);
    const bound = value.slice(4);
    rows = rows.filter((r) => r[key] !== null && compare(r[key], bound) >= 0);
  }
  const order = url.searchParams.get("order");
  if (order) {
    const [col, dir] = order.split(".");
    rows = [...rows].sort((a, b) => compare(a[col], b[col]) * (dir === "desc" ? -1 : 1));
  }
  const limit = url.searchParams.get("limit");
  if (limit) rows = rows.slice(0, Number(limit));
  const cols = (url.searchParams.get("select") ?? "*").split(",").map((c) => c.trim());
  return rows.map((r) => (cols.includes("*") ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
}

/** Instants compare as times, anything else as text. */
function compare(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && /\d{4}-\d\d-\d\dT/.test(String(a)) && /\d{4}-\d\d-\d\dT/.test(String(b))) return ta - tb;
  return String(a).localeCompare(String(b));
}

/** The latest delivery D with D - lead <= now (stand-in for private.delivery_due_at). */
function latestDeliveryDueAt(now, hhmm, tz, leadMinutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const local = new Date(now.getTime() + offsetMinutes(now, tz) * 60000);
  let best = null;
  for (let d = -2; d <= 1; d++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, h, m);
    const guess = new Date(wall - offsetMinutes(new Date(wall), tz) * 60000);
    const at = new Date(wall - offsetMinutes(guess, tz) * 60000);
    if (at.getTime() - leadMinutes * 60000 <= now.getTime() && (!best || at > best)) best = at;
  }
  return best;
}

/** Minutes east of UTC for `tz` at instant `t`. */
function offsetMinutes(t, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t.getTime() / 60000) * 60000) / 60000;
}

/** A simple stand-in for the SQL math (the plain conversion; DST edge cases are tested in SQL). */
function nextDeliveryAfter(after, hhmm, tz) {
  const [h, m] = hhmm.split(":").map(Number);
  const local = new Date(after.getTime() + offsetMinutes(after, tz) * 60000);
  for (let d = -1; d <= 2; d++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, h, m);
    const guess = new Date(wall - offsetMinutes(new Date(wall), tz) * 60000);
    const at = new Date(wall - offsetMinutes(guess, tz) * 60000);
    if (at > after) return at;
  }
  throw new Error("no delivery found");
}
