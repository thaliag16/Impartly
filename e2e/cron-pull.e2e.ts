// The scheduled pull route on the production build: it is outside the sign-in proxy, answers
// POST only, and refuses every call without the exact bearer CRON_SECRET with one and the
// same 401. The secret below is invented (playwright.config.ts). With the right secret the
// request gets past the check and reaches the database, which the fake Supabase here does
// not provide, so it ends in a bare 500: nothing about users is ever returned.

import { expect, test } from "@playwright/test";

const ROUTE = "/api/cron/pull";
const SECRET = "e2e-invented-cron-secret-0123456789abcdef";

test("GET and other methods are 405, not the sign-in proxy's 401", async ({ request }) => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const r = await request.fetch(ROUTE, { method, maxRedirects: 0, headers: { authorization: `Bearer ${SECRET}` } });
    expect(r.status(), method).toBe(405);
  }
});

test("a missing, malformed or wrong secret gets the same 401 and body", async ({ request }) => {
  const bodies = new Set<string>();
  for (const headers of [
    {},
    { authorization: "Bearer wrong-secret-of-the-same-length-000000000" },
    { authorization: `Basic ${SECRET}` },
    { authorization: `Bearer ${SECRET}x` },
    { cookie: "sb-access-token=anything" },
  ]) {
    const r = await request.post(ROUTE, { headers, maxRedirects: 0 });
    expect(r.status()).toBe(401);
    expect(r.headers()["cache-control"]).toContain("no-store");
    bodies.add(await r.text());
  }
  expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
});

test("the right secret gets past the check; a failure says nothing more", async ({ request }) => {
  const r = await request.post(ROUTE, { headers: { authorization: `Bearer ${SECRET}` }, maxRedirects: 0 });
  expect(r.status()).toBe(500);
  expect(await r.text()).toBe('{"error":"pull_failed"}');
});
