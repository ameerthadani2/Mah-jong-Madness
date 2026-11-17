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
  // were set (docs/ARCHITECTURE.md). Measured 2026-11-17 (lines / branches / functions): 38.68 / 29.77 / 27.60.
  collectCoverageFrom: ['src/**/*.tsx', '!src/**/*.render.test.tsx'],
  coverageDirectory: '<rootDir>/coverage-render',
  coverageReporters: ['text-summary', 'json-summary'],
  coverageThreshold: { global: { lines: 36, branches: 27, functions: 25 } },
  moduleNameMapper: {
    '^react$': reactDir,
    '^react/(.*)$': `${reactDir}/$1`,
  },
};
