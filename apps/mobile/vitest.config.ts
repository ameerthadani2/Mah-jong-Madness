import { defineConfig } from 'vitest/config';
// Pure TypeScript only: a test here must not import React Native or Expo modules (keep platform code behind injected interfaces).
export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['**/node_modules/**'] } });
