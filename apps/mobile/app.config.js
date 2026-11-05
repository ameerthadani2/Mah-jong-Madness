// Extends app.json at build time. Every value has a default, so a build with no env set still works.
// - APP_NAME, APP_SLUG, APP_SCHEME, APP_BUNDLE_ID: product identity (store name, Expo slug, deep-link
//   scheme, iOS bundle id and Android package). Today's values are placeholders until the name is cleared.
// - SIGNAL_URL: the deployed game server (wss://…) baked into the build; the app reads it on every launch.
// - EXPO_BASE_URL: serve the web export under a sub-path (GitHub Pages uses /<repo-name>/).
// - EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID, EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID:
//   Google sign-in OAuth client ids, exposed as extra.googleClientIds; a platform without one hides the button.
//   Sign in with Apple needs no env here (the capability is declared below; the server's APPLE_CLIENT_ID enables it).
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
    ios: { ...(config.ios || {}), bundleIdentifier: bundleId, usesAppleSignIn: true },
    android: { ...(config.android || {}), package: bundleId },
    extra: { ...(config.extra || {}) },
  };
  const signalUrl = env('SIGNAL_URL', undefined);
  if (signalUrl) out.extra.signalUrl = signalUrl;
  const google = {
    ios: env('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID', undefined),
    android: env('EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID', undefined),
    web: env('EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID', undefined),
  };
  const googleIds = Object.fromEntries(Object.entries(google).filter(([, v]) => v));
  if (Object.keys(googleIds).length) {
    out.extra.googleClientIds = googleIds;
    // The native Google redirect is <bundle id>:/oauthredirect, so the bundle id must also be a URL scheme.
    if (googleIds.ios || googleIds.android) out.scheme = [out.scheme, bundleId];
  }
  const baseUrl = env('EXPO_BASE_URL', undefined);
  if (baseUrl) out.experiments = { ...(config.experiments || {}), baseUrl };
  return out;
};
