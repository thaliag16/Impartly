// Phase 2: the player (/listen) in a real browser, against the production build with the
// fake Supabase and the stand-in tone renderer (IMPARTLY_E2E_FAKE_RENDER=1, no model
// download). The briefing is two invented newsletters, one issue each.
//
// Covers: play, pause and resume in place; next and previous newsletter; 15-second skips;
// the highlighted sentence follows playback; every Media Session handler, pressed through
// the instrument probe as the lock screen would; the mic rule (nothing plays while the mic
// is open, Bell cues at the start and end); and axe, 44px targets and one watermelon.

import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { buildCue } from "../app/spike/tone";
import { E2E_USER } from "./e2e-user.mjs";
import { installProbe, type Probe } from "./instrument";
import { signIn } from "./sign-in";

const FAKE_SUPABASE = `http://127.0.0.1:${Number(process.env.FAKE_AUTH_PORT ?? 54329)}`;
const WATERMELON_RGB = "rgb(238, 106, 130)";
const LEDGER = "11111111-1111-4111-8111-111111111111";
const HARBOR = "22222222-2222-4222-8222-222222222222";
const FIRST = "First, The Invented Ledger.";
const SECOND = "Finally, Harbor Notes.";

const probe = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__probe))) as Promise<Probe>;
const audioState = (page: Page) =>
  page.getByTestId("briefing-audio").evaluate((a: HTMLAudioElement) => ({ paused: a.paused, time: a.currentTime, duration: a.duration }));
const current = (page: Page) => page.getByTestId("current-sentence");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

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
        { id: LEDGER, title: "The Invented Ledger", feed_url: "https://ledger.invented.example/rss" },
        { id: HARBOR, title: "Harbor Notes", feed_url: "https://harbor.invented.example/rss" },
      ],
      newsletters: [
        // The newest issue's newsletter comes first (no saved order).
        { id: "aaaaaaaa-0000-4000-8000-000000000001", feed_id: LEDGER, subject: "Larkspur Robotics raises a round", received_at: new Date(now - 3_600_000).toISOString() },
        { id: "aaaaaaaa-0000-4000-8000-000000000002", feed_id: HARBOR, subject: "Ferry timetable changes", received_at: new Date(now - 7_200_000).toISOString() },
      ],
      summaries: [
        { newsletter_id: "aaaaaaaa-0000-4000-8000-000000000001", summary_text: "Larkspur Robotics raised 40 million dollars. Fernhill Capital led it. The company builds warehouse robots and plans to hire sixty engineers next year." },
        { newsletter_id: "aaaaaaaa-0000-4000-8000-000000000002", summary_text: "The harbor ferry adds two evening trips. They start in March. Fares stay the same, and the new boats run every forty minutes after six." },
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

async function open(page: Page) {
  await page.addInitScript(installProbe);
  await seedBriefing(page);
  await signIn(page, "/listen");
  await expect(page).toHaveURL(/\/listen$/);
  await expect(button(page, "Play")).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("player-status")).toHaveText("Paused");
}

async function play(page: Page) {
  await button(page, "Play").click();
  await expect(page.getByTestId("player-status")).toHaveText("Playing");
}

test("home links to the player, and signed out it goes to sign-in", async ({ page }) => {
  await page.goto("/listen");
  await expect(page).toHaveURL(/\/login\?next=%2Flisten$/);
  await signIn(page, "/");
  await page.getByRole("link", { name: "Listen" }).click();
  await expect(page).toHaveURL(/\/listen$/);
});

test("the screen matches the look rules while paused and playing", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your briefing");
  await expect(page.getByTestId("voice")).toContainText("Heart");
  await expect(page.getByTestId("speed")).toHaveText("1.00x");
  await expect(current(page)).toHaveText(/^Here is your briefing: 2 stories from 2 newsletters\.$/);
  await expect(current(page)).toHaveCSS("background-color", "rgb(248, 196, 203)"); // blush
  await checkScreen(page, "paused");
  await play(page);
  await expect(button(page, "Pause")).toBeVisible();
  await checkScreen(page, "playing");
});

test("pause holds the position and Play resumes from it", async ({ page }) => {
  await open(page);
  await play(page);
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(1);
  await button(page, "Pause").click();
  await expect(page.getByTestId("player-status")).toHaveText("Paused");
  const paused = await audioState(page);
  expect(paused.paused).toBe(true);
  await page.waitForTimeout(700);
  expect((await audioState(page)).time).toBeCloseTo(paused.time, 2);
  await play(page);
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(paused.time + 0.2);
  expect((await audioState(page)).time).toBeLessThan(paused.time + 3);
});

test("the highlighted sentence follows playback", async ({ page }) => {
  await open(page);
  await play(page);
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400);
    const { time } = await audioState(page);
    const el = current(page);
    const index = Number(await el.getAttribute("data-index"));
    const start = Number(await el.getAttribute("data-start"));
    const end = Number(await el.getAttribute("data-end"));
    // Within a frame or two of the clock: inside the sentence or the pause after it.
    expect(time, `sentence ${index}`).toBeGreaterThanOrEqual(start - 0.25);
    expect(time, `sentence ${index}`).toBeLessThanOrEqual(end + 0.5 + 0.25);
    seen.push(index);
  }
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen.at(-1)!).toBeGreaterThan(seen[0]);
});

test("next and previous newsletter, and 15-second skips", async ({ page }) => {
  await open(page);
  await play(page);
  await button(page, "Next newsletter").click();
  await expect(current(page)).toHaveText(FIRST);
  await expect(page.getByTestId("now-playing")).toHaveText("The Invented Ledger");
  await expect(page.getByTestId("where")).toContainText("1 of 2");
  await button(page, "Next newsletter").click();
  await expect(current(page)).toHaveText(SECOND);
  await expect(page.getByTestId("now-playing")).toHaveText("Harbor Notes");
  await button(page, "Previous newsletter").click(); // just started: the one before
  await expect(current(page)).toHaveText(FIRST);
  expect((await audioState(page)).paused).toBe(false);

  await button(page, "Pause").click();
  const before = (await audioState(page)).time;
  await button(page, "+15s forward").click();
  expect((await audioState(page)).time).toBeCloseTo(before + 15, 1);
  await button(page, "-15s back").click();
  expect((await audioState(page)).time).toBeCloseTo(before, 1);
});

test("lock-screen controls: every Media Session handler works", async ({ page }) => {
  await open(page);
  const handlers = await page.evaluate(() => Object.keys(window.__probe.handlers).filter((k) => window.__probe.handlers[k]));
  expect(handlers.sort()).toEqual(["nexttrack", "pause", "play", "previoustrack", "seekbackward", "seekforward", "seekto"]);
  const press = (action: string) => page.evaluate((a) => window.__probe.handlers[a]?.(), action);
  const session = () =>
    page.evaluate(() => ({ title: navigator.mediaSession.metadata?.title, artist: navigator.mediaSession.metadata?.artist, state: navigator.mediaSession.playbackState }));

  expect(await session()).toEqual({ title: "Your briefing", artist: "Impartly", state: "paused" });
  // A first tap on the screen (browsers start sound only after one), then the lock screen.
  await play(page);
  await press("pause");
  await expect(page.getByTestId("player-status")).toHaveText("Paused");
  expect((await session()).state).toBe("paused");
  await press("play");
  await expect(page.getByTestId("player-status")).toHaveText("Playing");
  expect((await session()).state).toBe("playing");
  await press("nexttrack");
  await expect(current(page)).toHaveText(FIRST);
  await expect.poll(async () => (await session()).title).toBe("The Invented Ledger");
  await press("nexttrack");
  await expect(current(page)).toHaveText(SECOND);
  await expect.poll(async () => (await session()).title).toBe("Harbor Notes");
  await press("previoustrack");
  await expect(current(page)).toHaveText(FIRST);
  await press("pause");
  await expect(page.getByTestId("player-status")).toHaveText("Paused");
  expect((await session()).state).toBe("paused");
  const before = (await audioState(page)).time;
  await press("seekforward");
  expect((await audioState(page)).time).toBeCloseTo(before + 15, 1);
  await press("seekbackward");
  expect((await audioState(page)).time).toBeCloseTo(before, 1);
  // The probe passes only { action }; seekto without a time leaves the place alone.
  await press("seekto");
  expect((await audioState(page)).time).toBeCloseTo(before, 1);
});

test("nothing plays while the mic is open; the Bell cues mark the start and end", async ({ page }) => {
  await open(page);
  await play(page);
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(1);

  // Right after the mic opens, try to restart the briefing the ways a listener could.
  await page.evaluate(() => {
    window.__probe.attackOnMicOpen = true;
  });
  await page.getByRole("button", { name: "Ask" }).click();
  await expect.poll(async () => (await probe(page)).micOpens).toBe(1);
  await expect.poll(async () => (await probe(page)).attacks).toContain("Media Session play");

  // And again while listening: on screen, lock screen, and a skip.
  await expect(page.getByTestId("player-status")).toContainText("Listening");
  await checkScreen(page, "listening");
  await expect(button(page, "Play")).toBeDisabled();
  await page.evaluate(() => window.__probe.handlers.play?.());
  await page.evaluate(() => window.__probe.handlers.nexttrack?.());
  await page.waitForTimeout(300);
  expect((await audioState(page)).paused).toBe(true);

  // When listening ends, the briefing resumes on its own and the mic is closed.
  await expect(page.getByTestId("player-status")).toHaveText("Playing", { timeout: 15_000 });
  const result = await probe(page);
  expect(result.micCloses).toBe(1);
  expect(result.micLive).toBe(0);
  expect(result.violations).toEqual([]);
  expect(result.otherAudio).toEqual([]);

  const audible = result.cuePlays.filter((p) => !p.muted);
  const starts = audible.filter((p) => p.id === "cue-start");
  const ends = audible.filter((p) => p.id === "cue-end");
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  expect(starts[0].micLive).toBeGreaterThan(0);
  expect(ends[0].micLive).toBe(0);
  const hash = async (src: string) =>
    page.evaluate(async (url) => {
      const data = await (await fetch(url)).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    }, src);
  const expected = async (starting: boolean) =>
    createHash("sha256").update(new Uint8Array(await buildCue("bell", starting).arrayBuffer())).digest("hex");
  expect(await hash(starts[0].src)).toBe(await expected(true));
  expect(await hash(ends[0].src)).toBe(await expected(false));
});
