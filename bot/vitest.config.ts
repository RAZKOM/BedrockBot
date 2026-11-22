import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          // Track REL3 (docs/testing.md): a hang guard, not a speed check; the closed-loop benches take 3 to 4 times as long
          // beside a load as alone
          testTimeout: 120_000,
          // Track REL3 (docs/testing.md "Time in the unit run"): the planners' time budgets on a work clock
          setupFiles: ['test/unit/setup.ts'],
        },
      },
      {
        // Track REL3 (docs/testing.md "The perf project"): wall-clock bounds, opt-in (`pnpm test:perf`, an idle
        // machine); the default run (`--project unit`) never includes them.
        test: {
          name: 'perf',
          include: ['test/perf/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // Needs the dev BDS (`pnpm bds:up`) and BDS_E2E=1; skipped otherwise.
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
