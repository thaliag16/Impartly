// Phase 2: the briefing's render path (render-ahead, the shared Kokoro worker renderer and
// its worker) loads ONNX Runtime from the app itself, never from jsDelivr.
//
// No model is downloaded here: every Hugging Face request is answered 503 by the test, so
// the worker gets as far as the runtime (served and verified) and then fails cleanly at
// the model stage. Real Kokoro rendering runs in the CI model job
// (tests/speech/worker-renderer.models.ts).

import { createHash } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";
import runtimePins from "../scripts/ort-runtime-pins.json";
import { signIn } from "./sign-in";

const RUNTIME_PATH = `/onnxruntime/${runtimePins.version}/`;

test("ONNX Runtime's files are served by the app, publicly, with the isolation and cache headers", async ({ request }) => {
  for (const { name, sha256 } of runtimePins.files) {
    // No sign-in: the worker fetches them like build assets.
    const response = await request.get(`${RUNTIME_PATH}${name}`, { maxRedirects: 0 });
    expect(response.status(), name).toBe(200);
    const headers = response.headers();
    expect(headers["content-type"], name).toMatch(name.endsWith(".wasm") ? /^application\/wasm/ : /^(text|application)\/javascript/);
    expect(headers["cross-origin-embedder-policy"], name).toBe("require-corp");
    expect(headers["cross-origin-resource-policy"], name).toBe("same-origin");
    expect(headers["cache-control"], name).toContain("immutable");
    expect(headers["x-content-type-options"], name).toBe("nosniff");
    expect(headers["set-cookie"], name).toBeUndefined();
    expect(createHash("sha256").update(await response.body()).digest("hex"), name).toBe(sha256);
  }
  // Only the pinned version's folder exists.
  expect((await request.get("/onnxruntime/0.0.0/ort-wasm-simd-threaded.jsep.wasm")).status()).toBe(404);
});

test("the briefing render path requests no jsDelivr URL and fails cleanly without the model", async ({ page, baseURL }) => {
  const requests: Request[] = [];
  page.context().on("request", (r) => requests.push(r));
  // Nothing leaves the machine: no model downloads, and jsDelivr would be refused anyway.
  await page.context().route(/^https:\/\/cdn\.jsdelivr\.net\//, (route) => route.abort());
  await page.context().route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//, (route) =>
    route.fulfill({ status: 503, body: "unavailable in UI tests" }),
  );

  await signIn(page, "/spike/voice");
  await expect(page).toHaveURL(/\/spike\/voice$/);
  await page.getByRole("button", { name: "Render the sample briefing" }).click();

  const log = page.locator("pre");
  await expect(log).toContainText(`runtime ${RUNTIME_PATH}ort-wasm-simd-threaded.jsep.wasm verified`, { timeout: 30_000 });
  // COOP/COEP still make the page cross-origin isolated, so threads stay possible.
  await expect(log).toContainText("isolated = true");
  // The model stage fails with a readable message naming the pinned file; no crash.
  await expect(log).toContainText(/FAILED \(model\): .*HTTP 503/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Render the sample briefing" })).toBeVisible();

  const urls = requests.map((r) => r.url());
  expect(urls.filter((u) => u.includes("jsdelivr")), "jsDelivr requests").toEqual([]);
  const wasm = requests.find((r) => r.url() === `${baseURL}${RUNTIME_PATH}ort-wasm-simd-threaded.jsep.wasm`);
  expect(wasm, "the worker fetched the runtime from the app").toBeTruthy();
  expect((await wasm!.response())?.status()).toBe(200);
  // Every request went to the app itself or to Hugging Face (the pinned model files).
  const elsewhere = urls.filter((u) => {
    const { origin, hostname } = new URL(u);
    return origin !== new URL(baseURL!).origin && !/(^|\.)(huggingface\.co|hf\.co)$/.test(hostname) && !u.startsWith("blob:") && !u.startsWith("data:");
  });
  expect(elsewhere).toEqual([]);
  expect(urls.some((u) => /huggingface\.co/.test(u)), "the model was requested from the pinned commit").toBe(true);
  expect(urls.filter((u) => /huggingface\.co/.test(u)).every((u) => /\/resolve\/[0-9a-f]{40}\//.test(u))).toBe(true);
});
