/**
 * Build-time configuration, read fresh on every launch from `app.config.js` extras
 * (which come from env vars such as SIGNAL_URL). Nothing here is persisted, so a new
 * build's server address always wins over whatever an older build saw.
 */
import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as { signalUrl?: unknown };

/** The game server baked into this build (absent → a local development server). */
export const BUILD_SIGNAL_URL: string = typeof extra.signalUrl === 'string' && extra.signalUrl ? extra.signalUrl : 'ws://localhost:8787';

/** The server this launch talks to: the build's, or a developer override in development builds only. */
export function resolveSignalUrl(devOverride: string | undefined): string {
  const o = devOverride?.trim();
  return __DEV__ && o ? o : BUILD_SIGNAL_URL;
}
