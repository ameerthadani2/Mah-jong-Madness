// Extends app.json at build time. Every value has a default, so a build with no env set still works.
// - APP_NAME, APP_SLUG, APP_SCHEME, APP_BUNDLE_ID: product identity (store name, Expo slug, deep-link
//   scheme, iOS bundle id and Android package). Today's values are placeholders until the name is cleared.
// - SIGNAL_URL: the deployed game server (wss://…) baked into the build; the app reads it on every launch.
// - EXPO_BASE_URL: serve the web export under a sub-path (GitHub Pages uses /<repo-name>/).
const IDENTITY_DEFAULTS = {
  name: 'Mahjong Madness',
  slug: 'mahjong-madness',
  scheme: 'mahjongmadness',
  bundleId: 'com.mahjongmadness.app',
};

const env = (key, fallback) => {
  const v = process.env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
};

module.exports = ({ config }) => {
  const bundleId = env('APP_BUNDLE_ID', IDENTITY_DEFAULTS.bundleId);
  const out = {
    ...config,
    name: env('APP_NAME', IDENTITY_DEFAULTS.name),
    slug: env('APP_SLUG', IDENTITY_DEFAULTS.slug),
    scheme: env('APP_SCHEME', IDENTITY_DEFAULTS.scheme),
    ios: { ...(config.ios || {}), bundleIdentifier: bundleId },
    android: { ...(config.android || {}), package: bundleId },
    extra: { ...(config.extra || {}) },
  };
  if (process.env.SIGNAL_URL) out.extra.signalUrl = process.env.SIGNAL_URL;
  if (process.env.EXPO_BASE_URL) out.experiments = { ...(config.experiments || {}), baseUrl: process.env.EXPO_BASE_URL };
  return out;
};
