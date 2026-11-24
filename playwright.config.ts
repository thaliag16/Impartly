import { defineConfig, devices } from "@playwright/test";

// UI tests run against a production build of the app (`next build` + `next start`).
//
// Browser: locally we use the system Google Chrome (`channel: "chrome"`), because the
// agent environment cannot download Playwright's own browsers. In CI (`CI` set) the
// browser Playwright installs is used instead (`npx playwright install chromium`).
//
// Fake media devices: Chrome answers microphone prompts itself and feeds a generated
// tone as the mic, so no real microphone or permission click is needed.

const PORT = Number(process.env.E2E_PORT ?? 3123);

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.CI ? undefined : "chrome",
        permissions: ["microphone"],
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/spike`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
