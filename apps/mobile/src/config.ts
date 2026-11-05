/**
 * Build-time configuration, read fresh on every launch from `app.config.js` extras
 * (which come from env vars such as SIGNAL_URL). Nothing here is persisted, so a new
 * build's server address always wins over whatever an older build saw.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { googleClientIdFor, readGoogleClientIds, type GoogleClientIds } from './logic/auth-config';

const extra = (Constants.expoConfig?.extra ?? {}) as { signalUrl?: unknown; googleClientIds?: unknown };

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
