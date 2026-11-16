import { defineConfig } from 'vitest/config';

// Coverage (`vitest run --coverage`) runs the code about four times slower, so a test's default time limit grows with it.
const coverageRun = process.argv.includes('--coverage');
export default defineConfig({
  test: {
    testTimeout: coverageRun ? 60_000 : 5_000,
    include: ['test/**/*.test.ts'],
    // `npm run coverage` at the root. Floors sit about two points under the figures measured when they were set
    // (docs/ARCHITECTURE.md, How the app is tested): they guard what is covered without blocking work.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Measured 2026-11-16 (lines / branches / functions): 97.79 / 92.82 / 95.77.
      thresholds: { lines: 95, branches: 90, functions: 93 },
    },
  },
});
