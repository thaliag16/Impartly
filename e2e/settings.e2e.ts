// The delivery time and timezone screen in a real browser, against the production build
// with the fake Supabase (Auth and REST, e2e/fake-auth-server.mjs). The browser runs in
// America/Los_Angeles, so a first visit should start from that zone.
//
// Covers: reaching it from home and /newsletters; the never-saved state (browser zone,
// 7:00 AM UTC note); saving writes only the user's own row and shows the next briefing in
// the chosen zone; a change of zone; the values survive a reload; keyboard-only use; and on
// every screen state, axe-core (WCAG 2.1 A/AA), 44px targets and one watermelon control.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_USER } from "./e2e-user.mjs";
import { signIn } from "./sign-in";

const FAKE_SUPABASE = `http://127.0.0.1:${Number(process.env.FAKE_AUTH_PORT ?? 54329)}`;
const WATERMELON_RGB = "rgb(238, 106, 130)";
const WEEKDAY = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)";

test.use({ timezoneId: "America/Los_Angeles" });

async function storedSettings(page: Page): Promise<{ user_id: string; delivery_time: string; timezone: string }[]> {
  return (await (await page.request.get(`${FAKE_SUPABASE}/__e2e/state`)).json()).settings;
}

/** The weekday names of today and tomorrow in `tz` (the next briefing is one of them). */
function nearWeekdays(tz: string): string[] {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  return [f.format(new Date()), f.format(new Date(Date.now() + 86_400_000))];
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

test.beforeEach(async ({ page }) => {
  expect((await page.request.post(`${FAKE_SUPABASE}/__e2e/reset`)).ok()).toBe(true);
});

test("home and the newsletter picker link to the settings screen", async ({ page }) => {
  await signIn(page, "/");
  await page.getByRole("link", { name: "Delivery time" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "Delivery time" })).toBeVisible();
  await page.goto("/newsletters");
  await page.getByRole("link", { name: "Delivery time" }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test("signed out, /settings goes to sign-in and comes back", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
  await page.getByLabel("Email").fill(E2E_USER.email);
  await page.getByLabel("Password").fill(E2E_USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test("first visit starts from the browser's zone; saving stores the user's row and shows the next briefing", async ({ page }) => {
  await signIn(page, "/settings");
  await expect(page.getByTestId("saved-zone")).toHaveText("Not set yet. Until you save, briefings are ready at 7:00 AM UTC.");
  await expect(page.getByTestId("next-briefing")).toHaveText(new RegExp(`^Your next briefing: ${WEEKDAY} 7:00 AM$`));
  await expect(page.getByLabel("Time zone")).toHaveValue("America/Los_Angeles");
  await expect(page.getByLabel("Delivery time")).toHaveValue("07:00");
  // The theme: Pixelify headline, square 3px card, Save is the one watermelon action.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-family", /Pixelify Sans/);
  await expect(page.getByTestId("delivery-form")).toHaveCSS("border-top-width", "3px");
  await expect(page.getByTestId("delivery-form")).toHaveCSS("border-top-left-radius", "0px");
  await expect(page.getByTestId("save")).toHaveCSS("background-color", WATERMELON_RGB);
  await checkScreen(page, "never saved");
  expect(await storedSettings(page)).toEqual([]);

  // Only 15-minute steps are offered.
  const times = await page.getByLabel("Delivery time").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(times).toHaveLength(96);
  expect(times.every((t) => /^\d\d:(00|15|30|45)$/.test(t))).toBe(true);

  await page.getByLabel("Delivery time").selectOption("06:15");
  await page.getByTestId("save").click();
  const [today, tomorrow] = nearWeekdays("America/Los_Angeles");
  await expect(page.getByTestId("settings-done")).toHaveText(new RegExp(`^Saved\\. Your next briefing: (${today}|${tomorrow}) 6:15 AM\\.$`));
  await expect(page.getByTestId("next-briefing")).toHaveText(new RegExp(`^Your next briefing: (${today}|${tomorrow}) 6:15 AM$`));
  await expect(page.getByTestId("saved-zone")).toHaveText("6:15 AM every day, America/Los Angeles time.");
  await expect(page.getByTestId("save")).toBeDisabled(); // nothing changed since saving
  await checkScreen(page, "saved");
  const stored = await storedSettings(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ delivery_time: "06:15:00", timezone: "America/Los_Angeles" });
  expect(stored[0].user_id).toMatch(/^[0-9a-f-]{36}$/); // the signed-in user's own row (the fake refuses any other)

  // The values come back from the database after a reload.
  await page.reload();
  await expect(page.getByLabel("Delivery time")).toHaveValue("06:15");
  await expect(page.getByLabel("Time zone")).toHaveValue("America/Los_Angeles");
  await expect(page.getByTestId("next-briefing")).toHaveText(new RegExp(`^Your next briefing: (${today}|${tomorrow}) 6:15 AM$`));
});

test("changing the zone updates the same row and the next briefing follows the new zone", async ({ page }) => {
  await signIn(page, "/settings");
  await page.getByTestId("save").click(); // 7:00 AM in the browser's zone
  await expect(page.getByTestId("settings-done")).toBeVisible();
  await page.getByLabel("Time zone").selectOption("Asia/Kolkata");
  await page.getByLabel("Delivery time").selectOption("21:30");
  await page.getByTestId("save").click();
  const [today, tomorrow] = nearWeekdays("Asia/Kolkata");
  await expect(page.getByTestId("next-briefing")).toHaveText(new RegExp(`^Your next briefing: (${today}|${tomorrow}) 9:30 PM$`));
  await expect(page.getByTestId("saved-zone")).toHaveText("9:30 PM every day, Asia/Kolkata time.");
  const stored = await storedSettings(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ delivery_time: "21:30:00", timezone: "Asia/Kolkata" });
});

test("works from the keyboard alone", async ({ page }) => {
  await signIn(page, "/settings");
  await page.getByLabel("Delivery time").focus();
  await page.keyboard.press("ArrowDown"); // 07:15
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Time zone")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("save")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-done")).toHaveText(/7:15 AM\.$/);
  expect((await storedSettings(page))[0]).toMatchObject({ delivery_time: "07:15:00", timezone: "America/Los_Angeles" });
});
