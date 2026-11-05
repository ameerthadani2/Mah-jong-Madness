import { defineConfig } from 'vitest/config';
// Pure TypeScript only: the logic module, locale resolution and the session factory (no React Native imports).
export default defineConfig({ test: { include: ['src/logic/**/*.test.ts', 'src/i18n/**/*.test.ts', 'src/game/session.test.ts'] } });
