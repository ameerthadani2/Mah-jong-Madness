/**
 * Where the Terms of Service and Privacy Policy open. When the build carries a published URL
 * (EXPO_PUBLIC_TERMS_URL / EXPO_PUBLIC_PRIVACY_URL) the system browser opens it; otherwise the
 * bundled DRAFT text (./documents.ts) is shown in the app.
 */
export type LegalDoc = 'terms' | 'privacy';

export interface LegalEnv {
  termsUrl?: string;
  privacyUrl?: string;
}

/** Each name is written out in full so the bundler can inline it. */
export function readLegalEnv(): LegalEnv {
  return { termsUrl: process.env.EXPO_PUBLIC_TERMS_URL, privacyUrl: process.env.EXPO_PUBLIC_PRIVACY_URL };
}

/** Only an https URL with a host is opened; anything else falls back to the bundled text. */
export function publishedUrl(raw: string | undefined): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return /^https:\/\/[^\s/?#]+\.[^\s/?#]+(?:[/?#]\S*)?$/i.test(v) ? v : null;
}

export function legalTarget(doc: LegalDoc, env: LegalEnv): { kind: 'url'; url: string } | { kind: 'bundled'; doc: LegalDoc } {
  const url = publishedUrl(doc === 'terms' ? env.termsUrl : env.privacyUrl);
  return url ? { kind: 'url', url } : { kind: 'bundled', doc };
}
