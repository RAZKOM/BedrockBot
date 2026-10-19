import { defineConfig } from 'vitest/config';

// Unit tests only; the e2e suite (test/e2e.test.mjs) runs with node:test against Docker BDS.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
