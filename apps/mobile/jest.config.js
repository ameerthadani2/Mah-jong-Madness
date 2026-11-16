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
  moduleNameMapper: {
    '^react$': reactDir,
    '^react/(.*)$': `${reactDir}/$1`,
  },
};
