import { defineConfig, devices } from "@playwright/test";
import { E2E_SECRET_MARKER } from "./e2e/e2e-user.mjs";

// UI tests run against a production build of the app (`next build` + `next start`).
//
// Browser: locally we use the system Google Chrome (`channel: "chrome"`), because the
// agent environment cannot download Playwright's own browsers. In CI (`CI` set) the
// browser Playwright installs is used instead (`npx playwright install chromium`).
//
// Fake media devices: Chrome answers microphone prompts itself and feeds a generated
// tone as the mic, so no real microphone or permission click is needed.

const PORT = Number(process.env.E2E_PORT ?? 3123);
const AUTH_PORT = Number(process.env.FAKE_AUTH_PORT ?? 54329);

// Sign-in is required on every route, so the app runs against a fake Supabase Auth server
// (e2e/fake-auth-server.mjs, invented user, no database). Every value below is invented
// for the tests; none is a real key or account. SUPABASE_SECRET_KEY is set to a marker so
// e2e/auth.e2e.ts can check that it never appears in the browser bundles.
const APP_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${AUTH_PORT}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "e2e-invented-publishable-key",
  SUPABASE_SECRET_KEY: E2E_SECRET_MARKER,
  GOOGLE_CLIENT_ID: "e2e-invented-client-id",
  GOOGLE_CLIENT_SECRET: "e2e-invented-client-secret",
  GOOGLE_REDIRECT_URI: `http://localhost:${PORT}/api/mail/gmail/callback`,
};

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // In CI, also write an HTML report; the workflow uploads it when a run fails.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
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
  webServer: [
    {
      command: "node e2e/fake-auth-server.mjs",
      url: `http://127.0.0.1:${AUTH_PORT}/auth/v1/health`,
      env: { FAKE_AUTH_PORT: String(AUTH_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `npm run build && npx next start -p ${PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/login`,
      env: APP_ENV,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
