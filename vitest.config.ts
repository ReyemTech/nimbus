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
        "src/operator/*.ts",
        "src/cache/cache.ts",
        "src/cli.ts",
        // The migrate pre-flight parsers are pure functions and are covered by
        // tests/unit/cli/; everything else under src/cli/ shells out to kubectl
        // or prompts interactively and is exercised by hand.
        "src/cli/azure-prompts.ts",
        "src/cli/migrate.ts",
        "src/cli/migrate-cnpg.ts",
        "src/cli/migrate-exec.ts",
        "src/cli/migrate-report.ts",
        "src/cli/migrate-superuser.ts",
        "src/cli/prompt.ts",
        "src/cli/templates.ts",
        "src/cli/templates-azure.ts",
      ],
      // TODO: re-enable thresholds after increasing coverage for platform, observability, operator modules
      // thresholds: {
      //   statements: 80,
      //   branches: 80,
      //   functions: 80,
      //   lines: 80,
      // },
    },
  },
});
