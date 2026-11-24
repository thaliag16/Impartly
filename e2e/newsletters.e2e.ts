// The newsletter picker in a real browser, against the production build with a fake
// Supabase (Auth and REST, e2e/fake-auth-server.mjs) and a fake internet under the real
// fetcher (lib/feeds/e2e-fake-web.ts). Nothing leaves the machine.
//
// Covers: the empty state's catalog picks; search → check → add → switch off → remove;
// pasting a domain; a site with no feed offered as a public archive; keyboard-only use; the error states (not in the catalog, robots.txt,
// a private address, a site refusing, rate-limited); and on every screen state, axe-core
// (WCAG 2.1 A/AA), 44px targets and at most one watermelon control.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./sign-in";

const FAKE_SUPABASE = `http://127.0.0.1:${Number(process.env.FAKE_AUTH_PORT ?? 54329)}`;
const WATERMELON_RGB = "rgb(238, 106, 130)";

async function resetFake(page: Page) {
  const r = await page.request.post(`${FAKE_SUPABASE}/__e2e/reset`);
  expect(r.ok()).toBe(true);
}

async function storedFeeds(page: Page): Promise<{ feed_url: string; feed_format: string; title: string; included: boolean; catalog_id: string | null }[]> {
  return (await (await page.request.get(`${FAKE_SUPABASE}/__e2e/state`)).json()).feeds;
}

/** axe-core (WCAG 2.0/2.1 A and AA), 44px targets and the one-watermelon rule. */
async function checkScreen(page: Page, label: string) {
  const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(
    axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `${label}: axe violations`,
  ).toEqual([]);

  const small = await page.locator("main").evaluate((main) =>
    [...main.querySelectorAll("button, a[href], input, [role=switch]")]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 44 || r.height < 44)
      .map(({ el, r }) => `${el.tagName} "${el.textContent?.trim()}" ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  expect(small, `${label}: touch targets under 44px`).toEqual([]);

  const watermelon = await page.locator("body").evaluate(
    (body, rgb) =>
      [...body.querySelectorAll("*")].filter((el) => (el as HTMLElement).offsetParent !== null && getComputedStyle(el).backgroundColor === rgb).length,
    WATERMELON_RGB,
  );
  expect(watermelon, `${label}: watermelon controls`).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  await resetFake(page);
  await signIn(page, "/newsletters");
  await expect(page).toHaveURL(/\/newsletters$/);
});

test("the empty state suggests catalog picks, including TechCrunch, StrictlyVC and Morning Brew", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1, name: "Newsletters" })).toBeVisible();
  const picks = page.getByRole("list", { name: "Suggested newsletters" });
  for (const name of ["TechCrunch", "StrictlyVC", "Morning Brew"]) {
    await expect(picks.getByRole("button", { name: `Check ${name}` })).toBeVisible();
  }
  // The theme is applied: square corners, 3px mocha borders, self-hosted fonts.
  const card = page.getByTestId("empty-state");
  await expect(card).toHaveCSS("border-top-width", "3px");
  await expect(card).toHaveCSS("border-top-left-radius", "0px");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-family", /Pixelify Sans/);
  expect(await page.evaluate(() => document.fonts.check('16px "DM Sans"'))).toBe(true);
  // Exactly one main action on this screen: Find.
  await expect(page.getByTestId("find")).toHaveCSS("background-color", WATERMELON_RGB);
  await checkScreen(page, "empty state");
});

test("search → check → add → switch off → remove, and the list survives a reload", async ({ page }) => {
  await page.getByLabel("Name or website").fill("strictly");
  const matches = page.getByRole("list", { name: "Catalog matches" });
  await expect(matches.getByText("StrictlyVC", { exact: true })).toBeVisible();
  await checkScreen(page, "catalog matches");
  await matches.getByRole("button", { name: "Check StrictlyVC" }).click();

  const preview = page.getByTestId("preview");
  await expect(preview.getByRole("heading", { name: "StrictlyVC" })).toBeVisible();
  await expect(preview.getByText("strictlyvc.com")).toBeVisible();
  await expect(page.getByTestId("preview-last-issue")).toHaveText("Nov 20, 2026");
  // While a new feed is shown, Add is the one main action and Find steps back.
  await expect(page.getByTestId("add")).toHaveCSS("background-color", WATERMELON_RGB);
  await expect(page.getByTestId("find")).not.toHaveCSS("background-color", WATERMELON_RGB);
  await checkScreen(page, "preview");
  expect(await storedFeeds(page)).toEqual([]); // previewing stores nothing

  await page.getByTestId("add").click();
  await expect(page.getByTestId("picker-done")).toHaveText("Added StrictlyVC.");
  const row = page.getByTestId("feed-row").filter({ hasText: "StrictlyVC" });
  await expect(row).toBeVisible();
  const stored = await storedFeeds(page);
  expect(stored).toHaveLength(1);
  // The stored URL is the one the server found (the page's advertised feed), not user input.
  expect(stored[0]).toMatchObject({ feed_url: "https://strictlyvc.com/feed/", title: "StrictlyVC", catalog_id: "strictlyvc", included: true });

  const toggle = row.getByRole("switch", { name: "Include StrictlyVC in briefings" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await checkScreen(page, "list");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("picker-done")).toHaveText("StrictlyVC is off.");

  await page.reload();
  await expect(page.getByRole("switch", { name: "Include StrictlyVC in briefings" })).toHaveAttribute("aria-checked", "false");
  expect((await storedFeeds(page))[0].included).toBe(false);

  await page.getByRole("button", { name: "Remove StrictlyVC" }).click();
  await expect(page.getByRole("group", { name: "Remove StrictlyVC?" })).toBeVisible();
  await checkScreen(page, "confirm remove");
  await page.getByRole("button", { name: "Yes, remove" }).click();
  await expect(page.getByTestId("picker-done")).toHaveText("Removed StrictlyVC.");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  expect(await storedFeeds(page)).toEqual([]);
});

test("a pasted domain finds the feed; adding the same newsletter again keeps one copy", async ({ page }) => {
  await page.getByLabel("Name or website").fill("morningbrew.com");
  await page.getByTestId("find").click();
  await expect(page.getByTestId("preview").getByRole("heading", { name: "Morning Brew" })).toBeVisible();
  await expect(page.getByTestId("preview-last-issue")).toHaveText("Nov 23, 2026");
  await page.getByTestId("add").click();
  await expect(page.getByTestId("picker-done")).toHaveText("Added Morning Brew.");

  // The same newsletter by its catalog name now shows as already added: no second Add.
  await page.getByLabel("Name or website").fill("Morning Brew");
  await page.getByTestId("find").click();
  await expect(page.getByTestId("preview").getByText("Already in your list.")).toBeVisible();
  await expect(page.getByTestId("add")).toHaveCount(0);
  await expect(page.getByTestId("find")).toHaveCSS("background-color", WATERMELON_RGB);
  expect(await storedFeeds(page)).toHaveLength(1);
});

test("a site with no feed offers its public archive: the preview lists the issues found, and Add stores the archive page", async ({ page }) => {
  await page.getByLabel("Name or website").fill("archive-only.example");
  await page.getByTestId("find").click();
  const preview = page.getByTestId("preview");
  await expect(preview.getByRole("heading", { name: "Invented Archive Weekly" })).toBeVisible();
  await expect(page.getByTestId("preview-kind")).toHaveText("No feed. Found a public archive");
  const issues = page.getByRole("list", { name: "Issues found" });
  await expect(issues.getByRole("listitem")).toHaveCount(2); // the off-site link is not an issue
  await expect(issues.getByText("Issue 42: Invented robots raise a round")).toBeVisible();
  await expect(page.getByTestId("preview-last-issue")).toHaveText("Nov 22, 2026");
  await expect(page.getByTestId("add")).toHaveCSS("background-color", WATERMELON_RGB);
  await checkScreen(page, "archive preview");
  expect(await storedFeeds(page)).toEqual([]);

  await page.getByTestId("add").click();
  await expect(page.getByTestId("picker-done")).toHaveText("Added Invented Archive Weekly.");
  const stored = await storedFeeds(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ feed_url: "https://archive-only.example/", feed_format: "archive", included: true });
  await expect(page.getByTestId("feed-row").filter({ hasText: "Invented Archive Weekly" })).toBeVisible();
  await checkScreen(page, "list with an archive");
});

test("works with the keyboard alone: type, Enter to find, Tab to Add, Space to switch", async ({ page }) => {
  await page.getByLabel("Name or website").focus();
  await page.keyboard.type("TechCrunch");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("preview").getByRole("heading", { name: "TechCrunch" })).toBeVisible();
  await expect(page.getByTestId("preview-last-issue")).toHaveText("Nov 22, 2026");
  await page.keyboard.press("Tab"); // Find
  await page.keyboard.press("Tab"); // Add TechCrunch
  await expect(page.getByTestId("add")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("picker-done")).toHaveText("Added TechCrunch.");
  await expect(page.getByLabel("Name or website")).toBeFocused();

  const toggle = page.getByRole("switch", { name: "Include TechCrunch in briefings" });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("error states: not in the catalog, robots.txt, a private address, a refusing site, rate-limited", async ({ page }) => {
  const input = page.getByLabel("Name or website");
  const error = page.getByTestId("picker-error");
  const cases: [string, RegExp][] = [
    ["Some Invented Weekly", /not in Impartly's catalog yet/],
    ["robots-blocked.example", /robots\.txt/],
    ["intranet.example", /not a public website/],
    ["refused.example", /refused the request/],
    ["no-feed.example", /No public feed was found/],
  ];
  for (const [query, message] of cases) {
    await input.fill(query);
    await page.getByTestId("find").click();
    await expect(error, query).toHaveText(message);
    await expect(error).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("preview")).toHaveCount(0);
  }
  await checkScreen(page, "error");

  const r = await page.request.post(`${FAKE_SUPABASE}/__e2e/exhaust-rate-limit`);
  expect(r.ok()).toBe(true);
  await input.fill("TechCrunch");
  await page.getByTestId("find").click();
  await expect(error).toHaveText(/a lot of lookups/);
  expect(await storedFeeds(page)).toEqual([]);
});
