import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        "src/**/interfaces.ts",
        "src/aws/**",
        "src/azure/**",
        "src/global-lb/glb.ts",
        "src/platform/stack.ts",
        "src/observability/stack.ts",
        "src/observability/dashboards.ts",
        "src/backup/**",
        "src/operator/**",
        "src/cache/cache.ts",
        "src/cli.ts",
        "src/cli/**",
        "src/rackspace/**",
        "src/platform/components/**",
        "src/utils/**",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
