// Phase 2: the listening settings screen (/settings/listening) in a real browser, against
// the production build with the fake Supabase (Auth and REST) and the stand-in tone
// renderer (IMPARTLY_E2E_FAKE_RENDER=1: a tone per voice, 220 Hz Heart and 330 Hz Daniel,
// no model download). The briefing is two invented newsletters, one issue each.
//
// Covers: reaching it from /settings and from the player's voice and speed chips; voice,
// speed and order saved to the user's own row and kept after a reload; the voice preview
// (rendered through the same renderer path, played, and the right voice); reordering by
// keyboard with the new position announced in a live region; /listen re-rendering in the
// new voice, speed and order, with the old clips gone from the device; and axe, 44px
// targets, one watermelon and the theme on every state.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_USER } from "./e2e-user.mjs";
import { installProbe, type Probe } from "./instrument";
import { signIn } from "./sign-in";

const FAKE_SUPABASE = `http://127.0.0.1:${Number(process.env.FAKE_AUTH_PORT ?? 54329)}`;
const WATERMELON_RGB = "rgb(238, 106, 130)";
const LEDGER = "11111111-1111-4111-8111-111111111111";
const HARBOR = "22222222-2222-4222-8222-222222222222";
const CLIP_CACHE = "impartly-briefing-audio-v1";

const probe = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__probe))) as Promise<Probe>;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const orderTitles = (page: Page) => page.getByTestId("order-list").locator("[data-testid=order-title]").allInnerTexts();

async function stored(page: Page) {
  const state = await (await page.request.get(`${FAKE_SUPABASE}/__e2e/state`)).json();
  return state.settings as { user_id: string; voice: string; speed: string; feed_order: string[]; delivery_time: string }[];
}

async function seedBriefing(page: Page) {
  expect((await page.request.post(`${FAKE_SUPABASE}/__e2e/reset`)).ok()).toBe(true);
  const login = await page.request.post(`${FAKE_SUPABASE}/auth/v1/token?grant_type=password`, {
    data: { email: E2E_USER.email, password: E2E_USER.password },
  });
  const userId = (await login.json()).user.id as string;
  const now = Date.now();
  const r = await page.request.post(`${FAKE_SUPABASE}/__e2e/seed-briefing`, {
    data: {
      user_id: userId,
      feeds: [
        { id: LEDGER, title: "The Invented Ledger", feed_url: "https://ledger.invented.example/rss", created_at: new Date(now - 90_000_000).toISOString() },
        { id: HARBOR, title: "Harbor Notes", feed_url: "https://harbor.invented.example/rss", created_at: new Date(now - 80_000_000).toISOString() },
      ],
      newsletters: [
        // No saved order: the newest issue's newsletter comes first (Ledger).
        { id: "aaaaaaaa-0000-4000-8000-000000000001", feed_id: LEDGER, subject: "Larkspur Robotics raises a round", received_at: new Date(now - 3_600_000).toISOString() },
        { id: "aaaaaaaa-0000-4000-8000-000000000002", feed_id: HARBOR, subject: "Ferry timetable changes", received_at: new Date(now - 7_200_000).toISOString() },
      ],
      summaries: [
        { newsletter_id: "aaaaaaaa-0000-4000-8000-000000000001", summary_text: "Larkspur Robotics raised 40 million dollars. Fernhill Capital led it." },
        { newsletter_id: "aaaaaaaa-0000-4000-8000-000000000002", summary_text: "The harbor ferry adds two evening trips. They start in March." },
      ],
    },
  });
  expect(r.ok()).toBe(true);
}

async function checkScreen(page: Page, label: string) {
  const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(
    axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `${label}: axe violations`,
  ).toEqual([]);
  const small = await page.locator("main").evaluate((main) =>
    [...main.querySelectorAll("button, a[href], input, select")]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 44 || r.height < 44)
      .map(({ el, r }) => `${el.tagName} "${el.textContent?.trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  expect(small, `${label}: touch targets under 44px`).toEqual([]);
  const watermelon = await page.locator("body").evaluate(
    (body, rgb) =>
      [...body.querySelectorAll("*")].filter((el) => (el as HTMLElement).offsetParent !== null && getComputedStyle(el).backgroundColor === rgb).length,
    WATERMELON_RGB,
  );
  expect(watermelon, `${label}: watermelon controls`).toBe(1);
}

/** The tone (Hz) at the start of the first sound in a WAV the page holds as a blob URL. */
async function toneOf(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate(async (audio: HTMLAudioElement) => {
    const bytes = await (await fetch(audio.src)).arrayBuffer();
    const view = new DataView(bytes);
    const rate = view.getUint32(24, true);
    const samples = new Int16Array(bytes.slice(44));
    let start = samples.findIndex((s) => s !== 0);
    start += Math.round(rate * 0.02); // past the fade-in
    const span = Math.round(rate * 0.2);
    let crossings = 0;
    for (let i = start + 1; i < start + span; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++;
    return crossings / 2 / 0.2;
  });
}

async function clipKeys(page: Page): Promise<string[]> {
  return page.evaluate(async (name) => {
    const cache = await caches.open(name);
    return (await cache.keys()).map((r) => new URL(r.url).pathname.replace(/^\/audio\//, ""));
  }, CLIP_CACHE);
}

async function openListen(page: Page) {
  await page.goto("/listen");
  await expect(button(page, "Play")).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("player-status")).toHaveText("Paused");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installProbe);
  await seedBriefing(page);
});

test("reached from the settings screen and from the player's voice and speed; signed out it goes to sign-in", async ({ page }) => {
  await page.goto("/settings/listening");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Flistening$/);
  await signIn(page, "/settings");
  await page.getByRole("link", { name: "Voice, speed and order" }).click();
  await expect(page).toHaveURL(/\/settings\/listening$/);
  await expect(page.getByRole("heading", { level: 1, name: "Listening" })).toBeVisible();
  await page.getByRole("link", { name: "Delivery time" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await openListen(page);
  await page.getByRole("link", { name: /Change voice and speed/ }).click();
  await expect(page).toHaveURL(/\/settings\/listening$/);
});

test("voice, speed and order save to the user's own row and come back after a reload", async ({ page }) => {
  await signIn(page, "/settings/listening");
  await expect(page.getByLabel("Voice")).toHaveValue("af_heart");
  await expect(page.getByLabel("Speed")).toHaveValue("1.00");
  expect(await orderTitles(page)).toEqual(["The Invented Ledger", "Harbor Notes"]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-family", /Pixelify Sans/);
  await expect(page.getByTestId("listening-form")).toHaveCSS("border-top-width", "3px");
  await expect(page.getByTestId("listening-form")).toHaveCSS("border-top-left-radius", "0px");
  await expect(page.getByTestId("save")).toHaveCSS("background-color", WATERMELON_RGB);
  await expect(page.getByTestId("save")).toBeDisabled(); // nothing changed yet
  await checkScreen(page, "defaults");

  // Speeds offered: 0.50x to 2.00x in 0.05 steps.
  const speeds = await page.getByLabel("Speed").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(speeds).toHaveLength(31);
  expect([speeds[0], speeds[1], speeds.at(-1)]).toEqual(["0.50", "0.55", "2.00"]);

  await page.getByLabel("Voice").selectOption("bm_daniel");
  await page.getByLabel("Speed").selectOption("1.50");
  await button(page, "Move Harbor Notes up").click();
  expect(await orderTitles(page)).toEqual(["Harbor Notes", "The Invented Ledger"]);
  await page.getByTestId("save").click();
  await expect(page.getByTestId("settings-done")).toHaveText("Saved. Your next briefing uses Daniel at 1.50x.");
  await expect(page.getByTestId("save")).toBeDisabled();
  await checkScreen(page, "saved");

  const rows = await stored(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ voice: "bm_daniel", speed: "1.50", feed_order: [HARBOR, LEDGER] });
  expect(rows[0].user_id).toMatch(/^[0-9a-f-]{36}$/); // the signed-in user's own row (the fake refuses any other)
  expect(rows[0].delivery_time).toBe("07:00:00"); // the delivery default is untouched

  await page.reload();
  await expect(page.getByLabel("Voice")).toHaveValue("bm_daniel");
  await expect(page.getByLabel("Speed")).toHaveValue("1.50");
  expect(await orderTitles(page)).toEqual(["Harbor Notes", "The Invented Ledger"]);
});

test("changing only the voice keeps the newest-first order (no order is pinned)", async ({ page }) => {
  await signIn(page, "/settings/listening");
  await page.getByLabel("Voice").selectOption("bm_daniel");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("settings-done")).toBeVisible();
  expect((await stored(page))[0]).toMatchObject({ voice: "bm_daniel", speed: "1.00", feed_order: [] });
});

test("reordering works from the keyboard, and each move is announced", async ({ page }) => {
  await signIn(page, "/settings/listening");
  await expect(button(page, "Move The Invented Ledger up")).toBeDisabled();
  await expect(button(page, "Move Harbor Notes down")).toBeDisabled();

  await button(page, "Move The Invented Ledger down").focus();
  await page.keyboard.press("Enter");
  const status = page.getByTestId("order-status");
  await expect(status).toHaveText("The Invented Ledger moved to position 2 of 2.");
  await expect(status).toHaveAttribute("aria-live", "polite");
  expect(await orderTitles(page)).toEqual(["Harbor Notes", "The Invented Ledger"]);
  // Its Down button is now disabled, so focus stays on the same newsletter's Up button.
  await expect(button(page, "Move The Invented Ledger up")).toBeFocused();
  await checkScreen(page, "after a keyboard move");

  await page.keyboard.press("Space");
  await expect(status).toHaveText("The Invented Ledger moved to position 1 of 2.");
  await expect(button(page, "Move The Invented Ledger down")).toBeFocused();
  expect(await orderTitles(page)).toEqual(["The Invented Ledger", "Harbor Notes"]);
  // Back where it started: nothing to save.
  await expect(page.getByTestId("save")).toBeDisabled();

  await page.keyboard.press("Enter");
  await expect(status).toHaveText("The Invented Ledger moved to position 2 of 2.");
  // Tab on to Save and press it, all by keyboard.
  await page.getByTestId("save").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-done")).toBeVisible();
  expect((await stored(page))[0].feed_order).toEqual([HARBOR, LEDGER]);
});

test("the preview reads one sentence in the chosen voice and speed, with no microphone", async ({ page }) => {
  await signIn(page, "/settings/listening");
  await page.getByLabel("Voice").selectOption("bm_daniel");
  await page.getByLabel("Speed").selectOption("2.00");
  await button(page, "Preview").click();
  await expect(page.getByTestId("preview-status")).toHaveText("Preview: Daniel at 2.00x.");
  await expect.poll(async () => page.getByTestId("preview-audio").evaluate((a: HTMLAudioElement) => !a.paused || a.ended)).toBe(true);
  expect(await toneOf(page, "preview-audio")).toBeCloseTo(330, -1);
  const fast = await page.getByTestId("preview-audio").evaluate((a: HTMLAudioElement) => a.duration);

  await page.getByLabel("Voice").selectOption("af_heart");
  await page.getByLabel("Speed").selectOption("1.00");
  // A change stops the old preview.
  await expect.poll(async () => page.getByTestId("preview-audio").evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await button(page, "Preview").click();
  await expect(page.getByTestId("preview-status")).toHaveText("Preview: Heart at 1.00x.");
  expect(await toneOf(page, "preview-audio")).toBeCloseTo(220, -1);
  const slow = await page.getByTestId("preview-audio").evaluate((a: HTMLAudioElement) => a.duration);
  expect(slow / fast).toBeCloseTo(2, 0);
  await checkScreen(page, "preview played");

  const result = await probe(page);
  expect(result.micOpens).toBe(0);
  expect(result.violations).toEqual([]);
  expect(result.otherAudio).toEqual([]);
  // Previewing saves nothing.
  expect(await stored(page)).toEqual([]);
});

test("/listen re-renders in the new voice, speed and order, and the old clips are gone", async ({ page }) => {
  await signIn(page, "/");
  await openListen(page);
  await expect(page.getByTestId("voice")).toContainText("Heart");
  await expect(page.getByTestId("speed")).toHaveText("1.00x");
  expect(await toneOf(page, "briefing-audio")).toBeCloseTo(220, -1);
  const before = await page.getByTestId("briefing-audio").evaluate((a: HTMLAudioElement) => a.duration);
  const oldKeys = await clipKeys(page);
  expect(oldKeys.length).toBeGreaterThan(0);
  expect(oldKeys.every((k) => k.includes("/af_heart/1.00/"))).toBe(true);

  await page.goto("/settings/listening");
  await page.getByLabel("Voice").selectOption("bm_daniel");
  await page.getByLabel("Speed").selectOption("1.50");
  await button(page, "Move Harbor Notes up").click();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("settings-done")).toBeVisible();

  await openListen(page);
  await expect(page.getByTestId("voice")).toContainText("Daniel");
  await expect(page.getByTestId("speed")).toHaveText("1.50x");
  // The new clips: Daniel's tone, and shorter at 1.50x.
  expect(await toneOf(page, "briefing-audio")).toBeCloseTo(330, -1);
  const after = await page.getByTestId("briefing-audio").evaluate((a: HTMLAudioElement) => a.duration);
  expect(after).toBeLessThan(before * 0.8);
  // The old voice's clips were removed from the device, so they can never be played.
  const keys = await clipKeys(page);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.every((k) => k.includes("/bm_daniel/1.50/"))).toBe(true);
  expect(keys.some((k) => oldKeys.includes(k))).toBe(false);
  // The new order: Harbor Notes first.
  await button(page, "Play").click();
  await button(page, "Next newsletter").click();
  await expect(page.getByTestId("now-playing")).toHaveText("Harbor Notes");
  await expect(page.getByTestId("current-sentence")).toHaveText("First, Harbor Notes.");
});
