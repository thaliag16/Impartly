// Runs the fake Supabase Auth server (tests/auth/fake-gotrue.mjs) and the fake REST API
// (tests/supabase/fake-postgrest.mjs) on a local port for the UI tests. Invented user and
// in-memory data only; no database. Started by playwright.config.ts.

import { createServer } from "node:http";
import { createFakeGoTrue } from "../tests/auth/fake-gotrue.mjs";
import { createFakePostgrest } from "../tests/supabase/fake-postgrest.mjs";
import { E2E_SECRET_MARKER, E2E_USER } from "./e2e-user.mjs";

const port = Number(process.env.FAKE_AUTH_PORT ?? 54329);
const gotrue = createFakeGoTrue([E2E_USER]);
const postgrest = createFakePostgrest({
  serviceKey: E2E_SECRET_MARKER,
  async userIdForToken(token) {
    if (!token) return null;
    const r = await gotrue.handle(
      new Request(`http://127.0.0.1:${port}/auth/v1/user`, { headers: { authorization: `Bearer ${token}` } }),
    );
    return r.ok ? (await r.json()).id : null;
  },
});

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [])),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = (await postgrest.handle(request.clone())) ?? (await gotrue.handle(request));
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => {
  console.log(`fake Supabase Auth on http://127.0.0.1:${port}`);
});
