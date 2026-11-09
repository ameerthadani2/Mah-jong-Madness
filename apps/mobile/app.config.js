// Extends app.json at build time. Every value has a default, so a build with no env set still works.
// - APP_NAME, APP_SLUG, APP_SCHEME, APP_BUNDLE_ID: product identity (store name, Expo slug, deep-link
//   scheme, iOS bundle id and Android package). The name is Mahjong Mania (麻將狂熱 in Chinese); the bundle id
//   is a placeholder until the owner's trademark check clears it and reserves it in the stores.
// - EXPO_PUBLIC_LINK_DOMAIN: the web domain for shared table links (https://<domain>/t/<code>); absent → the
//   app scheme (<scheme>://table/<code>). Read by src/config.ts at bundle time.
// - SIGNAL_URL: the deployed game server (wss://…) baked into the build; the app reads it on every launch.
// - EXPO_BASE_URL: serve the web export under a sub-path (GitHub Pages uses /<repo-name>/).
// - EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID, EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID:
//   Google sign-in OAuth client ids, exposed as extra.googleClientIds; a platform without one hides the button.
//   Sign in with Apple needs no env here (the capability is declared below; the server's APPLE_CLIENT_ID enables it).
// - EXPO_PUBLIC_SENTRY_DSN, EXPO_PUBLIC_POSTHOG_KEY, EXPO_PUBLIC_POSTHOG_HOST: crash reports and analytics; read by
//   src/config.ts at bundle time (absent → that service is off and its privacy toggle hidden).
// - SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT: source map and debug symbol upload during EAS builds. The Sentry
//   config plugin is added only when all three are set, because its upload step fails a build without them.
// - EXPO_PUBLIC_REVENUECAT_IOS_KEY, EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: store SDK keys (absent → 'Store unavailable').
// - EXPO_PUBLIC_STORE_MODE=mock: development builds only; release builds ignore it.
// - EXPO_PUBLIC_TERMS_URL, EXPO_PUBLIC_PRIVACY_URL: hosted legal texts (absent → the bundled DRAFT texts).
// - APP_STORE_ID: the numeric App Store id, for the 'Update required' link (the Play link comes from the bundle id).
// - GOOGLE_SERVICES_JSON: path to google-services.json (an EAS file variable), needed for Android push (FCM).
// Push notifications need the EAS project id (extra.eas.projectId, written by `eas init`); without it there is no token.
const IDENTITY_DEFAULTS = {
  name: 'Mahjong Mania',
  slug: 'mahjongmania',
  scheme: 'mahjongmania',
  bundleId: 'com.mahjongmania.app',
};

const env = (key, fallback) => {
  const v = process.env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
};

const reason = (type, ...codes) => ({ NSPrivacyAccessedAPIType: type, NSPrivacyAccessedAPITypeReasons: codes });
const collected = (type, linked, purposes) => ({
  NSPrivacyCollectedDataType: type,
  NSPrivacyCollectedDataTypeLinked: linked,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: purposes,
});

/**
 * Apple's privacy manifest. Required-reason APIs: UserDefaults (AsyncStorage, app-only data: CA92.1) and file
 * timestamps (files inside the app container: C617.1). Collected data matches docs/store/listing/en.md, plus crash
 * data for Sentry. Nothing is used for tracking.
 */
const PRIVACY_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyAccessedAPITypes: [reason('NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'), reason('NSPrivacyAccessedAPICategoryFileTimestamp', 'C617.1')],
  NSPrivacyCollectedDataTypes: [
    collected('NSPrivacyCollectedDataTypeEmailAddress', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    collected('NSPrivacyCollectedDataTypeUserID', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    collected('NSPrivacyCollectedDataTypeDeviceID', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    collected('NSPrivacyCollectedDataTypePurchaseHistory', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    collected('NSPrivacyCollectedDataTypeProductInteraction', false, ['NSPrivacyCollectedDataTypePurposeAnalytics']),
    collected('NSPrivacyCollectedDataTypeCrashData', false, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    // The display name players choose (users.display_name, and the names on match results) is stored with their account.
    collected('NSPrivacyCollectedDataTypeName', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    // Free text players type: the details of a player report (POST /api/reports), kept with the reporter's account.
    collected('NSPrivacyCollectedDataTypeOtherUserContent', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    // The birth year from the age gate (sent with PATCH /api/me), kept with the account.
    collected('NSPrivacyCollectedDataTypeOtherDataTypes', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    // Hands, results and puzzle answers (match results, club standings, puzzle ratings), kept with the account.
    collected('NSPrivacyCollectedDataTypeGameplayContent', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
  ],
};

module.exports = ({ config }) => {
  const bundleId = env('APP_BUNDLE_ID', IDENTITY_DEFAULTS.bundleId);
  const out = {
    ...config,
    name: env('APP_NAME', IDENTITY_DEFAULTS.name),
    slug: env('APP_SLUG', IDENTITY_DEFAULTS.slug),
    scheme: env('APP_SCHEME', IDENTITY_DEFAULTS.scheme),
    ios: { ...(config.ios || {}), bundleIdentifier: bundleId, usesAppleSignIn: true, privacyManifests: PRIVACY_MANIFEST },
    android: { ...(config.android || {}), package: bundleId },
    extra: { ...(config.extra || {}) },
    plugins: [...(config.plugins || []), 'expo-notifications'],
  };
  const sentry = { authToken: env('SENTRY_AUTH_TOKEN', undefined), organization: env('SENTRY_ORG', undefined), project: env('SENTRY_PROJECT', undefined) };
  if (sentry.authToken && sentry.organization && sentry.project) {
    // The token stays in the environment (the plugin reads SENTRY_AUTH_TOKEN); only org and project are written.
    out.plugins.push(['@sentry/react-native/expo', { organization: sentry.organization, project: sentry.project, url: env('SENTRY_URL', 'https://sentry.io/') }]);
  }
  const appStoreId = env('APP_STORE_ID', undefined);
  out.extra.storeUrls = {
    ...(appStoreId ? { ios: `https://apps.apple.com/app/id${appStoreId}` } : {}),
    android: `https://play.google.com/store/apps/details?id=${bundleId}`,
  };
  const googleServices = env('GOOGLE_SERVICES_JSON', undefined);
  if (googleServices) out.android.googleServicesFile = googleServices;
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
  // Shared table links (https://<domain>/t/<code>) open the app: iOS universal links and Android app links. The
  // domain must serve apple-app-site-association and assetlinks.json (docs/OWNER_TODO.md).
  const linkDomain = env('EXPO_PUBLIC_LINK_DOMAIN', undefined);
  if (linkDomain) {
    const host = linkDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    out.ios.associatedDomains = [`applinks:${host}`];
    out.android.intentFilters = [
      { action: 'VIEW', autoVerify: true, data: ['/t/', '/c/'].map((pathPrefix) => ({ scheme: 'https', host, pathPrefix })), category: ['BROWSABLE', 'DEFAULT'] },
    ];
  }
  const baseUrl = env('EXPO_BASE_URL', undefined);
  if (baseUrl) out.experiments = { ...(config.experiments || {}), baseUrl };
  return out;
};
