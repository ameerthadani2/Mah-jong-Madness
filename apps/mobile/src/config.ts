/**
 * Build-time configuration, read fresh on every launch from `app.config.js` extras
 * (which come from env vars such as SIGNAL_URL). Nothing here is persisted, so a new
 * build's server address always wins over whatever an older build saw.
 */
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { googleClientIdFor, readGoogleClientIds, type GoogleClientIds } from './logic/auth-config';
import { parseBuildNumber } from './telemetry/remote-config';

const extra = (Constants.expoConfig?.extra ?? {}) as { signalUrl?: unknown; googleClientIds?: unknown; storeUrls?: unknown; eas?: { projectId?: unknown } };
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The game server baked into this build (absent → a local development server). */
export const BUILD_SIGNAL_URL: string = typeof extra.signalUrl === 'string' && extra.signalUrl ? extra.signalUrl : 'ws://localhost:8787';

/** The server this launch talks to: the build's, or a developer override in development builds only. */
export function resolveSignalUrl(devOverride: string | undefined): string {
  const o = devOverride?.trim();
  return __DEV__ && o ? o : BUILD_SIGNAL_URL;
}

/** Google OAuth client ids baked into this build (EXPO_PUBLIC_GOOGLE_{IOS,ANDROID,WEB}_CLIENT_ID). */
export const GOOGLE_CLIENT_IDS: GoogleClientIds = readGoogleClientIds(extra);

/** This platform's Google client id; undefined hides the Google button. */
export const GOOGLE_CLIENT_ID: string | undefined = googleClientIdFor(GOOGLE_CLIENT_IDS, Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web');

/** iOS bundle id / Android package, used for the native Google redirect URI. */
export const APP_ID: string | undefined = (Platform.OS === 'android' ? Constants.expoConfig?.android?.package : Constants.expoConfig?.ios?.bundleIdentifier) ?? undefined;

/** Build number reported with the device at sign-in. */
export const APP_BUILD: string = String((Platform.OS === 'android' ? Constants.expoConfig?.android?.versionCode : Constants.expoConfig?.ios?.buildNumber) ?? Constants.expoConfig?.version ?? '0');

/**
 * Crash reports (Sentry) and product analytics (PostHog). `EXPO_PUBLIC_*` values are inlined into
 * the bundle when it is built; absent ones switch the service off (and hide its privacy toggle).
 */
export const SENTRY_DSN: string | undefined = str(process.env.EXPO_PUBLIC_SENTRY_DSN);
export const POSTHOG_KEY: string | undefined = str(process.env.EXPO_PUBLIC_POSTHOG_KEY);
export const POSTHOG_HOST: string = str(process.env.EXPO_PUBLIC_POSTHOG_HOST) ?? 'https://us.i.posthog.com';

/** The running native build (iOS CFBundleVersion, Android versionCode) for the update gate; null on the web. */
export const NATIVE_BUILD: number | null = parseBuildNumber(Application.nativeBuildVersion);

/** Store pages for the 'Update required' screen (APP_STORE_ID fills in the iOS one; placeholders until the apps exist). */
const storeUrls = (extra.storeUrls ?? {}) as { ios?: unknown; android?: unknown };
export const STORE_URLS: { ios: string; android: string } = {
  ios: str(storeUrls.ios) ?? 'https://apps.apple.com/app/id0000000000',
  android: str(storeUrls.android) ?? `https://play.google.com/store/apps/details?id=${APP_ID ?? 'com.mahjongmadness.app'}`,
};

/** Deep-link schemes this build answers to (APP_SCHEME, plus the bundle id when Google sign-in registers it). */
const scheme = Constants.expoConfig?.scheme as string | string[] | undefined;
export const APP_SCHEMES: string[] = (Array.isArray(scheme) ? scheme : scheme ? [scheme] : ['mahjongmadness']).filter((s) => typeof s === 'string' && s);

/** The EAS project id; Expo push tokens need it, so without one push stays off. */
export const EAS_PROJECT_ID: string | undefined = str(extra.eas?.projectId) ?? str(Constants.easConfig?.projectId);
