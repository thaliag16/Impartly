// A fake Supabase REST API (PostgREST) for the UI tests, in memory, with invented data only.
// It covers what the newsletter picker uses:
//   * GET  /rest/v1/web_feeds          the signed-in user's own feeds (as RLS would allow)
//   * POST /rest/v1/rpc/<fn>           feeds_discovery_take, feeds_subscribe,
//                                      feeds_set_included, feeds_remove: service key only,
//                                      each scoped to the p_user_id it is given, as the SQL is
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
  let attempts = new Map(); // user id -> [ms timestamps]
  let exhausted = false;
  const calls = [];

  const reset = () => {
    feeds = [];
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
      return json(200, { feeds, calls });
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

  return { handle, reset };
}
