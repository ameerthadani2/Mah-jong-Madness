import { defineConfig } from 'vitest/config';

// Coverage (`vitest run --coverage`) runs the code about four times slower, so a test's default time limit grows with it.
const coverageRun = process.argv.includes('--coverage');
// Pure TypeScript only: a test here must not import React Native or Expo modules (keep platform code behind injected interfaces).
export default defineConfig({
  test: {
    testTimeout: coverageRun ? 60_000 : 5_000,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // `npm run coverage` at the root measures the TypeScript modules (the .tsx screens are the render tests' ground).
    // Floors sit about two points under the figures measured when they were set (docs/ARCHITECTURE.md).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Measured 2026-11-16 (lines / branches / functions): 79.41 / 82.72 / 72.23.
      thresholds: { lines: 77, branches: 80, functions: 70 },
    },
  },
});
