#!/usr/bin/env node
// Used by ios-testflight.yml and android-play.yml, from apps/mobile, just before `eas build`.
//
// EAS cloud builds do not inherit the workflow's environment; a build profile's `env` does reach
// them. This copies the public build-time variables (they end up in the app bundle anyway) from
// the job's environment into build.<PROFILE>.env of eas.json, and, for iOS, writes the App Store
// Connect app id into submit.<PROFILE>.ios.ascAppId: a submission without a person at the keyboard
// needs it there (an API key cannot look the record up or create it). The edit is never committed.
//
//   PROFILE=production PLATFORM=ios APP_STORE_ID=1234567890 node eas-build-env.cjs [path/to/eas.json]
const fs = require('node:fs');

const BUILD_VARIABLES = [
  'SIGNAL_URL', 'APP_NAME', 'APP_SLUG', 'APP_SCHEME', 'APP_BUNDLE_ID', 'APP_VERSION', 'APP_STORE_ID',
  'EXPO_PUBLIC_LINK_DOMAIN', 'EXPO_PUBLIC_SENTRY_DSN', 'EXPO_PUBLIC_POSTHOG_KEY', 'EXPO_PUBLIC_POSTHOG_HOST',
  'SENTRY_ORG', 'SENTRY_PROJECT', 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID', 'EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY',
  'EXPO_PUBLIC_TERMS_URL', 'EXPO_PUBLIC_PRIVACY_URL',
  // Not read by the app: app.config.js checks it on the builder (an iOS build with Google sign-in needs Sign in with Apple).
  'APPLE_CLIENT_ID',
];

/** App Store Connect's numeric app id ("Apple ID" under App information). */
const APP_STORE_ID = /^\d{1,30}$/;

function applyBuildEnv(eas, env) {
  const name = env.PROFILE;
  const profile = eas.build && eas.build[name];
  if (!profile) throw new Error(`eas.json has no build profile '${name}'`);
  profile.env = { ...(profile.env || {}) };
  for (const key of BUILD_VARIABLES) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (value) profile.env[key] = value;
  }
  const appStoreId = typeof env.APP_STORE_ID === 'string' ? env.APP_STORE_ID.trim() : '';
  if (env.PLATFORM === 'ios' && appStoreId) {
    if (!APP_STORE_ID.test(appStoreId)) throw new Error(`APP_STORE_ID '${appStoreId}' is not an App Store Connect app id (digits only, e.g. 1234567890)`);
    eas.submit = { ...(eas.submit || {}) };
    const submit = { ...(eas.submit[name] || {}) };
    submit.ios = { ...(submit.ios || {}), ascAppId: appStoreId };
    eas.submit[name] = submit;
  }
  return eas;
}

module.exports = { applyBuildEnv, BUILD_VARIABLES, APP_STORE_ID };

if (require.main === module) {
  const file = process.argv[2] || 'eas.json';
  try {
    const eas = applyBuildEnv(JSON.parse(fs.readFileSync(file, 'utf8')), process.env);
    fs.writeFileSync(file, JSON.stringify(eas, null, 2));
    const set = Object.keys(eas.build[process.env.PROFILE].env);
    console.log('Build variables set: ' + (set.join(', ') || 'none'));
    const ios = eas.submit && eas.submit[process.env.PROFILE] && eas.submit[process.env.PROFILE].ios;
    if (process.env.PLATFORM === 'ios') console.log('App Store Connect app id for submission: ' + ((ios && ios.ascAppId) || 'not set'));
  } catch (err) {
    console.error('::error title=Could not prepare eas.json::' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
}
