import { defineConfig } from "vitest/config";

// Summary eval (`npm run eval:summaries`, GOAL.md section 4). With SUMMARY_API_KEY set it
// grades the configured model; without it, it checks the harness against a fake provider
// and says plainly that no model was evaluated.
export default defineConfig({
  test: {
    include: ["tests/eval/**/*.eval.ts"],
    testTimeout: 1_200_000,
  },
});
