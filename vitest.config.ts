import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@sculptsdk/core/kernel": r("./packages/core/src/kernel/index.ts"),
      "@sculptsdk/core": r("./packages/core/src/index.ts"),
      "@sculptsdk/adapter-testing": r("./packages/adapter-testing/src/index.ts")
    }
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**", "packages/adapter-testing/src/**"],
      exclude: ["packages/core/src/generated/**", "packages/core/src/kernel/global.ts"],
      reporter: ["text", "html"]
    }
  }
});
