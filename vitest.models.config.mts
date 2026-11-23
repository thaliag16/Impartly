import { defineConfig } from "vitest/config";

// Model tests (`npm run test:models`): slow, need the pinned model files in models/,
// so they run in their own CI job and stay out of `npm test`.
export default defineConfig({
  test: {
    include: ["tests/speech/**/*.models.ts"],
    globalSetup: ["tests/speech/global-setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
