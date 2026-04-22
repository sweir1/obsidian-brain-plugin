import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // Default exclude list + reference/ so we don't run upstream's tests
    // when we've locally cloned obsidian-dataview for grep/provenance.
    exclude: ["**/node_modules/**", "**/dist/**", "reference/**"],
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // The real `obsidian` npm package ships types only (no runtime JS).
      // For unit tests we alias to an in-repo shim that provides the minimal
      // runtime pieces our source imports at module-load time (Plugin, parseYaml).
      // The production esbuild build treats `obsidian` as external — this alias
      // is vitest-only.
      obsidian: fileURLToPath(
        new URL("./src/test-mocks/obsidian.ts", import.meta.url),
      ),
    },
  },
});
