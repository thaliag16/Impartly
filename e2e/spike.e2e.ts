// Phase 0 UI tests for the audio spike page (/spike).
// The mic is Chrome's fake device (see playwright.config.ts). No model downloads are needed:
// the spike page builds its test track and cue sounds in the browser.

import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { buildCue, type CueSound } from "../app/spike/tone";
import { installProbe, type Probe } from "./instrument";

// JSON round trip drops the handler functions, which cannot leave the page.
const probe = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__probe))) as Promise<Probe>;

const briefingState = (page: Page) =>
  page.getByTestId("briefing-audio").evaluate((element: HTMLAudioElement) => ({
    paused: element.paused,
    time: element.currentTime,
  }));

async function expectedCueHash(sound: CueSound, starting: boolean) {
  const bytes = new Uint8Array(await buildCue(sound, starting).arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

// SHA-256 of the audio a blob URL points at, computed in the page.
function hashInPage(page: Page, src: string) {
  return page.evaluate(async (url) => {
    const data = await (await fetch(url)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }, src);
}

async function cueHashes(page: Page) {
  const start = await page.getByTestId("cue-start").getAttribute("src");
  const end = await page.getByTestId("cue-end").getAttribute("src");
  expect(start).toBeTruthy();
  expect(end).toBeTruthy();
  return { start: await hashInPage(page, start!), end: await hashInPage(page, end!) };
}

const status = (page: Page) => page.getByRole("status");
const log = (page: Page) => page.locator("pre");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installProbe);
  await page.goto("/spike");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});

test("on-screen pause button stops playback and Play resumes where it left off", async ({ page }) => {
  await page.getByRole("button", { name: "Start" }).click();
  await expect(status(page)).toHaveText("Playing");
  await expect.poll(async () => (await briefingState(page)).time).toBeGreaterThan(0.5);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(status(page)).toHaveText("Paused");
  const paused = await briefingState(page);
  expect(paused.paused).toBe(true);

  // Position holds while paused.
  await page.waitForTimeout(600);
  const later = await briefingState(page);
  expect(later.paused).toBe(true);
  expect(later.time).toBeCloseTo(paused.time, 2);

  await page.getByRole("button", { name: "Play" }).click();
  await expect(status(page)).toHaveText("Playing");
  await expect.poll(async () => (await briefingState(page)).time).toBeGreaterThan(paused.time + 0.2);
  // Resumed from the paused position, not from the start.
  const resumed = await briefingState(page);
  expect(resumed.time).toBeLessThan(paused.time + 3);
});

test("Bell is the default cue and the cue choice loads the matching sounds", async ({ page }) => {
  await expect(page.getByRole("radio", { name: "Bell" })).toBeChecked();
  await expect
    .poll(() => cueHashes(page))
    .toEqual({ start: await expectedCueHash("bell", true), end: await expectedCueHash("bell", false) });

  await page.getByRole("radio", { name: "Soft pop" }).check();
  await expect
    .poll(() => cueHashes(page))
    .toEqual({ start: await expectedCueHash("pop", true), end: await expectedCueHash("pop", false) });

  await page.getByRole("radio", { name: "Bell" }).check();
  await expect
    .poll(() => cueHashes(page))
    .toEqual({ start: await expectedCueHash("bell", true), end: await expectedCueHash("bell", false) });
});

test("the Bell cue plays at the start and end of listening", async ({ page }) => {
  await page.getByRole("button", { name: "Start" }).click();
  await expect(status(page)).toHaveText("Playing");
  await page.getByRole("button", { name: /Tap to ask/ }).click();

  await expect(status(page)).toContainText("Listening");
  await expect(status(page)).toHaveText("Playing", { timeout: 15_000 });

  await expect(log(page)).toContainText("CUE start: played to the end");
  await expect(log(page)).toContainText("CUE end: played to the end");

  const result = await probe(page);
  // Muted plays are the silent unlock during the Start tap, not audible cues.
  const audible = result.cuePlays.filter((play) => !play.muted);
  const starts = audible.filter((play) => play.id === "cue-start");
  const ends = audible.filter((play) => play.id === "cue-end");
  // Start cue sounds once the mic is open, before speaking; end cue after the mic closes.
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  expect(starts[0].micLive).toBeGreaterThan(0);
  expect(ends[0].micLive).toBe(0);
  expect(ends[0].at).toBeGreaterThan(starts[0].at);
  expect(await hashInPage(page, starts[0].src)).toBe(await expectedCueHash("bell", true));
  expect(await hashInPage(page, ends[0].src)).toBe(await expectedCueHash("bell", false));
});

test("briefing playback and the open mic are mutually exclusive", async ({ page }) => {
  await page.getByRole("button", { name: "Start" }).click();
  await expect(status(page)).toHaveText("Playing");
  await expect.poll(async () => (await briefingState(page)).time).toBeGreaterThan(0.5);

  // Right after the mic opens, try to restart the briefing the two ways a listener could:
  // the on-screen Play button and the lock-screen / headphone play control.
  await page.evaluate(() => {
    window.__probe.attackOnMicOpen = true;
  });
  await page.getByRole("button", { name: /Tap to ask/ }).click();
  await expect.poll(async () => (await probe(page)).micOpens).toBe(1);
  await expect.poll(async () => (await probe(page)).attacks).toContain("Media Session play");

  // Try again in the middle of recording.
  await expect(status(page)).toContainText("Listening");
  await page.evaluate(() => window.__probe.handlers.play?.());
  await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
  expect((await briefingState(page)).paused).toBe(true);

  // After listening ends, the briefing resumes on its own and the mic is closed.
  await expect(status(page)).toHaveText("Playing", { timeout: 15_000 });
  await expect(log(page)).toContainText("RESUMED at");

  const result = await probe(page);
  expect(result.micCloses).toBe(1);
  expect(result.micLive).toBe(0);
  expect(result.violations).toEqual([]);
});
