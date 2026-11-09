import {
  configDefaults,
  defineConfig,
} from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "bench/**/*.test.mjs",
      "scripts/**/*.test.mjs",
    ],
    exclude: [
      ...configDefaults.exclude,
      "scripts/check-public-tree.test.mjs",
      "scripts/export-public.test.mjs",
    ],
  },
});
