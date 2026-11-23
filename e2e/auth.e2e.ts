// Sign-in on every route, the Gmail connect start and the browser bundles, against the
// production build with a fake Supabase Auth server (e2e/fake-auth-server.mjs).
// Google is never contacted: the connect redirect is read, not followed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_SECRET_MARKER, E2E_USER } from "./e2e-user.mjs";
import { signIn } from "./sign-in";

test("signed out, every page goes to /login and every API answers 401", async ({ page, request }) => {
  for (const p of ["/", "/mail", "/spike", "/spike/voice"]) {
    await page.goto(p);
    await expect(page, p).toHaveURL(/\/login(\?|$)/);
    await expect(page.getByRole("heading", { name: "Sign in to Impartly" })).toBeVisible();
  }
  for (const p of ["/api/mail/gmail/connect", "/api/mail/gmail/callback?code=x&state=y", "/api/speech-test"]) {
    const r = await request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(401);
  }
  const r = await request.post("/api/mail/gmail/disconnect", { maxRedirects: 0, form: { connection_id: "x" } });
  expect([401, 403]).toContain(r.status());
});

test("a wrong password stays on /login with an error; the right one signs in and returns to the page", async ({ page }) => {
  await page.goto("/login?next=%2Fmail");
  await page.getByLabel("Email").fill(E2E_USER.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("login-error")).toBeVisible();
  expect(page.url()).not.toContain("not-the-password");

  await signIn(page, "/mail");
  await expect(page).toHaveURL(/\/mail$/);
  await expect(page.getByText("No mailbox is connected.")).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.filter((c) => c.name.startsWith("sb-"));
  expect(session.length).toBeGreaterThan(0);
  for (const c of session) {
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Lax");
  }
});

test("Connect Gmail starts Google sign-in for gmail.readonly with state and PKCE, signed in only", async ({ page }) => {
  await signIn(page, "/mail");
  const href = await page.getByTestId("connect-gmail").getAttribute("href");
  expect(href).toBe("/api/mail/gmail/connect");
  const r = await page.request.get(href!, { maxRedirects: 0 });
  expect(r.status()).toBe(303);
  const location = new URL(r.headers()["location"]);
  expect(location.protocol).toBe("https:");
  expect(location.hostname.endsWith(".google.com")).toBe(true);
  expect(location.pathname).toBe("/o/oauth2/v2/auth");
  expect(location.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("state")).toBeTruthy();
  const setCookie = r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  const state = setCookie.find((c) => c.startsWith("__Host-impartly-gmail-oauth="));
  expect(state).toMatch(/HttpOnly/i);
  expect(state).toMatch(/Secure/i);
  expect(state).toMatch(/SameSite=lax/i);
  expect(state).not.toContain(location.searchParams.get("state")!);
});

test("disconnect refuses a cross-site POST even when signed in", async ({ page }) => {
  await signIn(page, "/mail");
  const r = await page.request.post("/api/mail/gmail/disconnect", {
    maxRedirects: 0,
    headers: { origin: "https://evil.example" },
    form: { connection_id: "00000000-0000-4000-8000-000000000000" },
  });
  expect(r.status()).toBe(403);
});

test("sign out ends the session", async ({ page }) => {
  await signIn(page, "/mail");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/mail");
  await expect(page).toHaveURL(/\/login\?next=%2Fmail$/);
});

test("the browser bundles never contain the Supabase secret key, its name or the server modules", async () => {
  const dir = path.join(process.cwd(), ".next", "static");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:js|css|json|map)$/.test(f)) files.push(p);
    }
  };
  walk(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    expect(text, f).not.toContain(E2E_SECRET_MARKER);
    expect(text, f).not.toContain(["SUPABASE", "SECRET", "KEY"].join("_"));
    expect(text, f).not.toContain("e2e-invented-client-secret");
  }
});
