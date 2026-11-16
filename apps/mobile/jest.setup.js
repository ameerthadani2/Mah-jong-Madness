// Mocks for the render tests (jest.config.js): only what the native layer cannot provide inside jest. Each one says why.
const { jest } = require('@jest/globals');

// AsyncStorage is a native module, absent under jest. The package ships an in-memory stand-in for tests.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

// The crash-report and analytics SDKs (src/telemetry/platform.native.ts) ship ES modules that load native code. A test
// build has no Sentry DSN or PostHog key, so neither ever starts; these stand-ins only let the telemetry module load.
jest.mock('@sentry/react-native', () => ({ init: jest.fn(), close: jest.fn(async () => true), captureException: jest.fn(), wrap: (root) => root }));
jest.mock('posthog-react-native', () => ({ __esModule: true, default: jest.fn() }));

// RevenueCat's purchases SDK (src/monetisation/revenuecat-native.ts) loads an ES module and a native store module. A test
// build has no RevenueCat key, so the app's store code never calls it; the stand-in only lets the module load.
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: { setLogLevel: jest.fn(), configure: jest.fn(), logIn: jest.fn(), getProducts: jest.fn(async () => []), purchaseStoreProduct: jest.fn(), restorePurchases: jest.fn() },
  LOG_LEVEL: { WARN: 'WARN' },
  PRODUCT_CATEGORY: { SUBSCRIPTION: 'SUBSCRIPTION', NON_SUBSCRIPTION: 'NON_SUBSCRIPTION' },
}));

// expo-audio needs its native player module, which jest-expo does not stand in for. The game's sound cues
// (src/audio/index.ts) only create players and play them; silent players are enough for a render.
jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({ volume: 1, play: jest.fn(), seekTo: jest.fn(async () => undefined), remove: jest.fn() })),
  setAudioModeAsync: jest.fn(async () => undefined),
}));
