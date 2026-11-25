// Phase 2: the render cost log (GOAL.md Phase 2, "Render cost per briefing logged and within
// budget") in a real browser, against the production build with the fake Supabase and the
// stand-in tone renderer (IMPARTLY_E2E_FAKE_RENDER=1, no model download).
//
// Covers: opening /listen renders the briefing and writes exactly one row to the signed-in
// user's render log, with counts and timings only (no user agent, no IP); a reload with
// every clip cached writes none; the budget outcome is only a data attribute (nothing on
// screen); and a second user cannot read the first user's rows. The real table's RLS is
// tested on Postgres in tests/db/render-log.test.ts and tests/db/rls.test.ts.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_OTHER_USER, E2E_USER } from "./e2e-user.mjs";
import { signIn } from "./sign-in";

const FAKE_SUPABASE = `http://127.0.0.1:${Number(process.env.FAKE_AUTH_PORT ?? 54329)}`;
const LEDGER = "11111111-1111-4111-8111-111111111111";
const NEWSLETTER = "aaaaaaaa-0000-4000-8000-000000000001";

async function token(request: APIRequestContext, user: { email: string; password: string }) {
  const r = await request.post(`${FAKE_SUPABASE}/auth/v1/token?grant_type=password`, { data: user });
  expect(r.ok()).toBe(true);
  const body = await r.json();
  return { id: body.user.id as string, accessToken: body.access_token as string };
}

async function seed(page: Page) {
  expect((await page.request.post(`${FAKE_SUPABASE}/__e2e/reset`)).ok()).toBe(true);
  const { id } = await token(page.request, E2E_USER);
  const r = await page.request.post(`${FAKE_SUPABASE}/__e2e/seed-briefing`, {
    data: {
      user_id: id,
      feeds: [{ id: LEDGER, title: "The Invented Ledger", feed_url: "https://ledger.invented.example/rss" }],
      newsletters: [
        { id: NEWSLETTER, feed_id: LEDGER, subject: "Larkspur Robotics raises a round", received_at: new Date(Date.now() - 3_600_000).toISOString() },
      ],
      summaries: [{ newsletter_id: NEWSLETTER, summary_text: "Larkspur Robotics raised 40 million dollars. Fernhill Capital led it." }],
    },
  });
  expect(r.ok()).toBe(true);
  return id;
}

const renderLog = async (request: APIRequestContext) =>
  (await (await request.get(`${FAKE_SUPABASE}/__e2e/state`)).json()).renderLog as Record<string, unknown>[];

const readAs = async (request: APIRequestContext, accessToken: string) => {
  const r = await request.get(`${FAKE_SUPABASE}/rest/v1/render_log?select=*`, {
    headers: { authorization: `Bearer ${accessToken}`, apikey: "e2e-publishable" },
  });
  expect(r.ok()).toBe(true);
  return (await r.json()) as Record<string, unknown>[];
};

async function openPlayer(page: Page) {
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 30_000 });
}

test("a render writes exactly one row of counts and timings; a cached reload writes none", async ({ page }) => {
  const userId = await seed(page);
  await signIn(page, "/listen");
  await expect(page).toHaveURL(/\/listen$/);
  await openPlayer(page);
  await expect(page.locator("main")).toHaveAttribute("data-render-budget", "ok");

  const rows = await renderLog(page.request);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  // Exactly these columns: no user agent, IP, screen size or sentence text.
  expect(Object.keys(row).sort()).toEqual(
    [
      "audio_seconds",
      "cached",
      "chars",
      "created_at",
      "delivery_at",
      "device_class",
      "id",
      "render_seconds",
      "rendered",
      "rendered_audio_seconds",
      "sentences",
      "speed",
      "user_id",
      "voice",
    ].sort(),
  );
  expect(row).toMatchObject({ user_id: userId, voice: "af_heart", speed: 1, cached: 0, device_class: "desktop" });
  expect(row.rendered).toBe(row.sentences);
  expect(row.sentences as number).toBeGreaterThanOrEqual(4); // opening, lead-in, two summary sentences, close
  expect(row.chars as number).toBeGreaterThan(50);
  // The stand-in renderer's audio is 0.04 s per character, rendered at 20x real time.
  expect(row.audio_seconds as number).toBeGreaterThan(2);
  expect(row.rendered_audio_seconds).toBe(row.audio_seconds);
  expect(row.render_seconds as number).toBeCloseTo((row.audio_seconds as number) / 20, 2);
  expect(Date.parse(row.delivery_at as string)).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000);

  // The budget outcome is not shown: no text about budgets or render cost on the screen.
  await expect(page.locator("main")).not.toContainText(/budget|render cost/i);

  // Reload: every clip is cached, nothing is rendered, nothing is logged.
  await page.reload();
  await openPlayer(page);
  await expect(page.locator("main")).toHaveAttribute("data-render-budget", "none");
  expect(await renderLog(page.request)).toHaveLength(1);
});

test("a second user cannot read the first user's render log", async ({ page }) => {
  await seed(page);
  await signIn(page, "/listen");
  await openPlayer(page);
  await expect(page.locator("main")).toHaveAttribute("data-render-budget", "ok");

  const first = await token(page.request, E2E_USER);
  const other = await token(page.request, E2E_OTHER_USER);
  expect(other.id).not.toBe(first.id);
  expect(await readAs(page.request, first.accessToken)).toHaveLength(1);
  expect(await readAs(page.request, other.accessToken)).toEqual([]);
  // Nor write one in the first user's name.
  const forged = await page.request.post(`${FAKE_SUPABASE}/rest/v1/render_log`, {
    headers: { authorization: `Bearer ${other.accessToken}`, apikey: "e2e-publishable" },
    data: { user_id: first.id },
  });
  expect(forged.status()).toBe(403);
  expect(await renderLog(page.request)).toHaveLength(1);
});
