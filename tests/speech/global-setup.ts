import { MODELS_DIR, readPins, verifyModel } from "../../scripts/fetch-models.mjs";

// Says plainly, before any test runs, whether the model suite will run or be skipped.
export default async function setup() {
  const required = process.env.CI === "true" || process.env.REQUIRE_MODELS === "1";
  for (const [name, model] of Object.entries(await readPins())) {
    const { ok, problems } = await verifyModel(model, MODELS_DIR);
    if (ok) {
      console.log(`[test:models] ${name}: pinned files present and SHA-256 verified`);
    } else if (required) {
      console.error(`[test:models] ${name}: files NOT verified, the suite will FAIL:\n  ${problems.join("\n  ")}`);
    } else {
      console.warn(
        `\n[test:models] SKIPPED ${name}: the pinned files are not present and verified in models/.\n` +
          `  ${problems.join("\n  ")}\n` +
          "  Run `npm run fetch:models` (needs huggingface.co) first. CI runs this suite and fails if it cannot.\n",
      );
    }
  }
}
