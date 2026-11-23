import { defineConfig } from "vitest/config";

// `npm run verify:catalog`: checks every data/newsletter-catalog.json entry against the
// live sites. Needs the public internet, so it runs from a GitHub runner
// (.github/workflows/catalog.yml) or by hand; it is not part of `npm test`.
export default defineConfig({
  test: {
    include: ["tests/catalog/**/*.catalog.ts"],
    testTimeout: 600_000,
  },
});
