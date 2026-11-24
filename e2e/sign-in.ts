import { expect, type Page } from "@playwright/test";
import { E2E_USER } from "./e2e-user.mjs";

/** Signs in through the real /login form (against the fake Auth server). */
export async function signIn(page: Page, next = "/") {
  await page.goto(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(E2E_USER.email);
  await page.getByLabel("Password").fill(E2E_USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
