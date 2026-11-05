import { defineConfig } from 'vitest/config';
// Pure TypeScript only: the logic module, locale resolution, the auth client and the session factory (no React Native imports).
export default defineConfig({ test: { include: ['src/logic/**/*.test.ts', 'src/i18n/**/*.test.ts', 'src/auth/**/*.test.ts', 'src/game/session.test.ts'] } });
