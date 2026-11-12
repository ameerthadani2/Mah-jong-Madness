// Extends app.json at build time. Every value has a default, so a build with no env set still works.
// - APP_NAME, APP_SLUG, APP_SCHEME, APP_BUNDLE_ID: product identity (store name, Expo slug, deep-link
//   scheme, iOS bundle id and Android package). The name is Mahjong Mania (麻將狂熱 in Chinese); the bundle id
//   is a placeholder until the owner's trademark check clears it and reserves it in the stores.
// - EXPO_PUBLIC_LINK_DOMAIN: the web domain for shared table links (https://<domain>/t/<code>); absent → the
//   app scheme (<scheme>://table/<code>). Read by src/config.ts at bundle time.
// - SIGNAL_URL: the deployed game server (wss://…) baked into the build; the app reads it on every launch.
//   A release build (EAS profile production or preview) stops with a clear error unless it is a wss://
//   address on a public host name: without it the app would silently talk to ws://localhost:8787. The
//   build workflows run the same check (releaseSignalUrlProblem below) before anything is built.
// - EXPO_BASE_URL: serve the web export under a sub-path (GitHub Pages uses /<repo-name>/).
// - EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID, EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID:
//   Google sign-in OAuth client ids, exposed as extra.googleClientIds; a platform without one hides the button.
//   Sign in with Apple needs no env here (the capability is declared below; the server's APPLE_CLIENT_ID enables it).
// - APPLE_CLIENT_ID: the value given to the server's APPLE_CLIENT_ID secret (it must name the bundle id). Needed
//   only by an iOS release build that also carries EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: App Review guideline 4.8
//   refuses an app that offers Google sign-in without Sign in with Apple, so such a build stops with a clear error
//   until this says the server offers it (appleSignInProblem below; the iOS workflow runs the same check first).
// - EXPO_PUBLIC_SENTRY_DSN, EXPO_PUBLIC_POSTHOG_KEY, EXPO_PUBLIC_POSTHOG_HOST: crash reports and analytics; read by
//   src/config.ts at bundle time (absent → that service is off and its privacy toggle hidden).
// - SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT: source map and debug symbol upload during EAS builds. The Sentry
//   config plugin is added only when all three are set, because its upload step fails a build without them.
// - EXPO_PUBLIC_REVENUECAT_IOS_KEY, EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: store SDK keys (absent → 'Store unavailable').
// - EXPO_PUBLIC_STORE_MODE=mock: development builds only; release builds ignore it.
// - EXPO_PUBLIC_TERMS_URL, EXPO_PUBLIC_PRIVACY_URL: hosted legal texts (absent → the bundled DRAFT texts).
// - APP_STORE_ID: the numeric App Store id, for the 'Update required' link (the Play link comes from the bundle id).
// - GOOGLE_SERVICES_JSON: path to google-services.json (an EAS file variable), needed for Android push (FCM).
// - APP_VERSION: the version players see (iOS short version, Android versionName), e.g. 1.0.0; default app.json's.
//   The build numbers are not set here: eas.json keeps them on the EAS servers (appVersionSource remote) and the
//   production profile raises the iOS build number and the Android version code by one on every build.
// The Android package is APP_BUNDLE_ID too, so it must also be a valid Android package (dot-separated segments that
// start with a letter; letters, digits and '_' only, no '-'): a build with any other id stops with a clear error.
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
 * data for Sentry. Nothing is used for tracking. Usage data and purchases are declared as linked to the account
 * and used for analytics: for a player who agreed to usage statistics the server sends its own events
 * (purchase_credited, report_filed) under the account id. Crash data carries no account id.
 */
const PRIVACY_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyAccessedAPITypes: [reason('NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'), reason('NSPrivacyAccessedAPICategoryFileTimestamp', 'C617.1')],
  NSPrivacyCollectedDataTypes: [
    collected('NSPrivacyCollectedDataTypeEmailAddress', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    collected('NSPrivacyCollectedDataTypeUserID', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    collected('NSPrivacyCollectedDataTypeDeviceID', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']),
    collected('NSPrivacyCollectedDataTypePurchaseHistory', true, ['NSPrivacyCollectedDataTypePurposeAppFunctionality', 'NSPrivacyCollectedDataTypePurposeAnalytics']),
    collected('NSPrivacyCollectedDataTypeProductInteraction', true, ['NSPrivacyCollectedDataTypePurposeAnalytics']),
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

/** A Play package name: two or more dot-separated segments, each a letter then letters, digits or '_'. */
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** What iOS accepts as CFBundleShortVersionString (and Play shows as versionName): up to three numbers. */
const APP_VERSION = /^\d+(\.\d+){0,2}$/;

/** Host name endings that only resolve on a private network or nowhere at all. */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'lan', 'home', 'home.arpa', 'test', 'invalid', 'example'];

/**
 * Why `value` cannot be the game server of a release build, or null when it can. A release build
 * must reach the deployed server over TLS from anywhere: wss://, a public host name (not an IP
 * address, not a name that only a private network resolves), no credentials in the address.
 */
function releaseSignalUrlProblem(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return 'it is not set. Set it to the deployed game server, e.g. wss://mahjong-signal.fly.dev; without it the build would talk to a development address.';
  if (/\s/.test(v)) return `'${v}' contains white space.`;
  if (!v.startsWith('wss://')) return `'${v}' does not start with wss:// (lower case). A release build talks to the deployed server over TLS.`;
  let url;
  try {
    url = new URL(v);
  } catch {
    return `'${v}' is not an address. Use wss://<your server>, e.g. wss://mahjong-signal.fly.dev.`;
  }
  if (url.username || url.password) return `'${v}' carries a user name or password; the address is baked into the app, so it must not.`;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return `'${v}' points at an IP address. Use the server's host name (a certificate is issued for a name, and a private address is unreachable from a phone).`;
  if (!host.includes('.') || host.endsWith('.')) return `'${v}' has no public host name (the host is '${host}'). Use the deployed server, e.g. wss://mahjong-signal.fly.dev.`;
  if (PRIVATE_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))) return `'${v}' points at a local or private name ('${host}'). A release build must never point at localhost or a private network.`;
  return null;
}

/**
 * App Review guideline 4.8: an iOS app that offers another sign-in must offer Sign in with Apple
 * beside it. Why an iOS release build with these values would break that, or null when it would
 * not. The build offers Google sign-in on iOS when it carries a Google iOS client id. Sign in with
 * Apple is offered when the server's APPLE_CLIENT_ID names this build's bundle id (the audience of
 * the token iOS issues); the build cannot ask the server, so the owner repeats that value as the
 * build variable APPLE_CLIENT_ID (a comma-separated list, as on the server).
 */
function appleSignInProblem({ googleIosClientId, appleClientId, bundleId }) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  if (!text(googleIosClientId)) return null;
  const apple = text(appleClientId).split(',').map((s) => s.trim()).filter(Boolean);
  const fix = `Set the server secret APPLE_CLIENT_ID to the bundle id '${bundleId}' (fly secrets set), set the build variable APPLE_CLIENT_ID to the same value, or build without EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID.`;
  if (!apple.length) return `it offers Google sign-in (EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is set) and APPLE_CLIENT_ID is not set, so nothing says Sign in with Apple is offered too. App Review refuses an iOS app that offers Google sign-in alone (guideline 4.8). ${fix}`;
  if (!apple.includes(bundleId)) return `it offers Google sign-in and APPLE_CLIENT_ID ('${apple.join(', ')}') does not name the bundle id '${bundleId}', so Sign in with Apple would fail on this build (the token iOS issues is addressed to the bundle id). ${fix}`;
  return null;
}

module.exports = ({ config }) => {
  // On EAS the build profile is in the environment: stop a release build that has no usable server address.
  const profile = env('EAS_BUILD_PROFILE', undefined);
  const release = profile === 'production' || profile === 'preview';
  if (release) {
    const problem = releaseSignalUrlProblem(process.env.SIGNAL_URL);
    if (problem) throw new Error(`SIGNAL_URL cannot be used for a ${profile} build: ${problem} Set it as a repository variable (the build workflows copy it) or as an EAS environment variable for a build started with eas build.`);
  }
  const bundleId = env('APP_BUNDLE_ID', IDENTITY_DEFAULTS.bundleId);
  // An iOS release build (EAS names the platform on its builders) never offers Google sign-in without Sign in with Apple.
  if (release && env('EAS_BUILD_PLATFORM', undefined) === 'ios') {
    const problem = appleSignInProblem({ googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, appleClientId: process.env.APPLE_CLIENT_ID, bundleId });
    if (problem) throw new Error(`This iOS ${profile} build cannot be made: ${problem}`);
  }
  if (!ANDROID_PACKAGE.test(bundleId)) {
    throw new Error(`APP_BUNDLE_ID '${bundleId}' cannot be the Android package: use dot-separated segments that start with a letter, with letters, digits and '_' only (e.g. com.mahjongmania.app)`);
  }
  const version = env('APP_VERSION', undefined);
  if (version !== undefined && !APP_VERSION.test(version)) throw new Error(`APP_VERSION '${version}' must be one to three numbers separated by dots (e.g. 1.0.0)`);
  const out = {
    ...config,
    ...(version !== undefined ? { version } : {}),
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

module.exports.releaseSignalUrlProblem = releaseSignalUrlProblem;
module.exports.appleSignInProblem = appleSignInProblem;
