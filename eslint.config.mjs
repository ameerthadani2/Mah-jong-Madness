// Flat ESLint config for the whole monorepo (TypeScript only; plain .js/.cjs build and e2e scripts are not linted).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/dist-e2e/**', '**/.expo/**', '**/e2e-shots/**', '.claude/**', '**/*.js', '**/*.cjs', '**/*.mjs', '**/*.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // The engine and net code use `!` deliberately after explicit phase checks; `any` is confined to tests and transport shims.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
