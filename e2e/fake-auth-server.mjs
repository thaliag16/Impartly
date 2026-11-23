// Runs the fake Supabase Auth server (tests/auth/fake-gotrue.mjs) on a local port for the
// UI tests. Invented user only; no database. Started by playwright.config.ts.

import { createServer } from "node:http";
import { createFakeGoTrue } from "../tests/auth/fake-gotrue.mjs";
import { E2E_USER } from "./e2e-user.mjs";

const port = Number(process.env.FAKE_AUTH_PORT ?? 54329);
const gotrue = createFakeGoTrue([E2E_USER]);

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [])),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = await gotrue.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => {
  console.log(`fake Supabase Auth on http://127.0.0.1:${port}`);
});
