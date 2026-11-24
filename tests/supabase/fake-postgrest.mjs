// A fake Supabase REST API (PostgREST) for the UI tests, in memory, with invented data only.
// It covers what the newsletter picker uses:
//   * GET  /rest/v1/web_feeds          the signed-in user's own feeds (as RLS would allow)
//   * POST /rest/v1/rpc/<fn>           feeds_discovery_take, feeds_subscribe,
//                                      feeds_set_included, feeds_remove: service key only,
//                                      each scoped to the p_user_id it is given, as the SQL is
//   * GET/PATCH/POST /rest/v1/user_settings   the signed-in user's own row only (as RLS would
//                                      allow): read, update, insert; another user's id is refused
//   * POST /rest/v1/rpc/delivery_next_after   service key only; a stand-in for the SQL math
//                                      (tested on real Postgres in tests/db/delivery-settings.test.ts)
//   * any other GET /rest/v1/<table>   [] for a signed-in user (no database here)
// Test controls (not part of Supabase): POST /__e2e/reset, POST /__e2e/exhaust-rate-limit,
// GET /__e2e/state. The SQL these stand in for is tested on real Postgres in tests/db/.

import { randomUUID } from "node:crypto";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * @param {{ serviceKey: string, userIdForToken: (token: string) => Promise<string | null> }} options
 */
export function createFakePostgrest({ serviceKey, userIdForToken }) {
  let feeds = []; // { id, user_id, feed_url, feed_format, title, homepage_url, catalog_id, included, ... }
  let settings = []; // { user_id, delivery_time ("07:00:00"), timezone, updated_at }
  let attempts = new Map(); // user id -> [ms timestamps]
  let exhausted = false;
  const calls = [];

  const reset = () => {
    feeds = [];
    settings = [];
    attempts = new Map();
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
    if (url.pathname === "/__e2e/state" && request.method === "GET") {
      return json(200, { feeds, settings, calls });
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
      return null;
    };
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
        updated_at: new Date().toISOString(),
      });
      return new Response(null, { status: 201 });
    }
    return json(405, { message: "not supported by the fake" });
  }

  return { handle, reset };
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
