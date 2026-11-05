/**
 * Which sign-in buttons the app shows. Pure: src/config.ts feeds it the build's `extra`
 * (from app.config.js) and the screens feed it the server's `/api/config`.
 *
 * - Sign in with Apple: iOS with the capability available, and enabled on the server.
 * - Google: a client id for this platform was baked into the build, and enabled on the server.
 * - Facebook: not offered.
 * With no env vars and no server, nothing is shown and the app stays guest-only.
 */
export type Platform = 'ios' | 'android' | 'web';

export interface GoogleClientIds {
  ios?: string;
  android?: string;
  web?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Reads `extra.googleClientIds` as app.config.js writes it; anything malformed is ignored. */
export function readGoogleClientIds(extra: unknown): GoogleClientIds {
  const raw = extra && typeof extra === 'object' ? (extra as { googleClientIds?: unknown }).googleClientIds : undefined;
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: GoogleClientIds = {};
  const ios = str(r.ios);
  const android = str(r.android);
  const web = str(r.web);
  if (ios) out.ios = ios;
  if (android) out.android = android;
  if (web) out.web = web;
  return out;
}

/** The Google OAuth client id for this platform, or undefined (→ the Google button is hidden). */
export function googleClientIdFor(ids: GoogleClientIds, platform: Platform): string | undefined {
  return ids[platform];
}

export type SignInProvider = 'apple' | 'google';

/** Sign-in buttons to show, in display order. */
export function visibleProviders(o: { serverProviders: readonly string[] | null; appleAvailable: boolean; googleClientId: string | undefined }): SignInProvider[] {
  const server = new Set(o.serverProviders ?? []);
  const out: SignInProvider[] = [];
  if (o.appleAvailable && server.has('apple')) out.push('apple');
  if (o.googleClientId && server.has('google')) out.push('google');
  return out;
}
