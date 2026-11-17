// Render tests (`npm run test:render`): components and screens rendered with React Native Testing Library under the
// jest-expo preset. Only *.render.test.tsx files run here; vitest runs the *.test.ts logic tests (vitest.config.ts),
// and neither picks up the other's files. Mocks for what the native layer cannot provide live in jest.setup.js.
const path = require('path');

// One React for the app, React Native and the test renderer: the app's folder has its own copy of react beside the
// hoisted one, and two copies in one tree break hooks. Use the copy React Native itself resolves.
const reactDir = path.dirname(require.resolve('react/package.json', { paths: [path.dirname(require.resolve('react-native/package.json'))] }));

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  rootDir: __dirname,
  testMatch: ['<rootDir>/src/**/*.render.test.tsx'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // `npm run coverage:render` (and the root `npm run coverage`) measures the .tsx screens and components the render
  // tests reach; the .ts modules are vitest's ground. Floors sit about two points under the figures measured when they
  // were set (docs/ARCHITECTURE.md). Measured 2026-11-17, once the daily puzzle, Quick match, Home's own buttons and the
  // privacy question, the account card and the table's Back key had render tests too (lines / branches / functions):
  // 69.96 / 61.29 / 59.85 (64.18 / 54.52 / 54.16 before them). Raised once the ranked Puzzle Rush flow and the claim,
  // defence and value puzzle views had render tests: 72.15 / 65.23 / 63.16 (70.27 / 61.89 / 60.38 before the views).
  collectCoverageFrom: ['src/**/*.tsx', '!src/**/*.render.test.tsx'],
  coverageDirectory: '<rootDir>/coverage-render',
  coverageReporters: ['text-summary', 'json-summary'],
  coverageThreshold: { global: { lines: 70, branches: 63, functions: 61 } },
  moduleNameMapper: {
    '^react$': reactDir,
    '^react/(.*)$': `${reactDir}/$1`,
  },
};
