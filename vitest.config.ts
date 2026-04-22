import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default exclude list + reference/ so we don't run upstream's tests
    // when we've locally cloned obsidian-dataview for grep/provenance.
    exclude: ["**/node_modules/**", "**/dist/**", "reference/**"],
    include: ["src/**/*.test.ts"],
  },
});
