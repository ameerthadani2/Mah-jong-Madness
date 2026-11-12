// Flat ESLint config for the whole monorepo: the TypeScript sources, and the plain .js/.cjs/.mjs build,
// config and end-to-end scripts (the core recommended rules, so a typo or a stale variable fails CI there too).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const SCRIPTS = ['**/*.js', '**/*.cjs', '**/*.mjs'];
const UNUSED = { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' };

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/dist-e2e/**', '**/.expo/**', '**/e2e-shots/**', '.claude/**', '**/*.d.ts'],
  },
  ...tseslint.configs.recommended.map((c) => ({ ...c, ignores: [...(c.ignores ?? []), ...SCRIPTS] })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', UNUSED],
      // The engine and net code use `!` deliberately after explicit phase checks; `any` is confined to tests and transport shims.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', UNUSED] },
  },
  {
    // The app's entry point and this file are ES modules.
    files: ['**/*.mjs', 'apps/mobile/index.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023, globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', UNUSED] },
  },
  {
    // The end-to-end scripts also run functions inside the page.
    files: ['apps/mobile/e2e/*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
