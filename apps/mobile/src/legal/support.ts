/**
 * Where a player reaches support. A build names an address (EXPO_PUBLIC_SUPPORT_EMAIL) or a help page
 * (EXPO_PUBLIC_SUPPORT_URL); with neither there is no support desk to send anyone to, so every screen leaves
 * the "contact support" sentence and link out instead of pointing at nothing.
 */
import { publishedUrl } from './links';

export interface SupportEnv {
  email?: string;
  url?: string;
}

export type SupportContact = { kind: 'email'; address: string } | { kind: 'url'; url: string };

/** Each name is written out in full so the bundler can inline it. */
export function readSupportEnv(): SupportEnv {
  return { email: process.env.EXPO_PUBLIC_SUPPORT_EMAIL, url: process.env.EXPO_PUBLIC_SUPPORT_URL };
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** The address when the build has a well-formed one, else an https help page, else null. */
export function supportContact(env: SupportEnv): SupportContact | null {
  const email = typeof env.email === 'string' ? env.email.trim() : '';
  if (EMAIL.test(email)) return { kind: 'email', address: email };
  const url = publishedUrl(env.url);
  return url ? { kind: 'url', url } : null;
}

/**
 * What the "Contact support" link opens: the help page, or a message to the address with the subject and,
 * when the player has an account, its id on the first line (support cannot find an account without it).
 */
export function supportHref(contact: SupportContact, mail: { subject: string; idLine?: string | null }): string {
  if (contact.kind === 'url') return contact.url;
  const query = [`subject=${encodeURIComponent(mail.subject)}`, ...(mail.idLine ? [`body=${encodeURIComponent(`${mail.idLine}\n\n`)}`] : [])];
  return `mailto:${contact.address}?${query.join('&')}`;
}

/** Which "contact support" sentence belongs under a refusal, by its copy key; null where support is not the way out. */
export function supportReason(key: string | null | undefined): 'mistake' | 'birthYear' | null {
  if (key === 'quickmatch.errors.banned' || key === 'errors.banned' || key === 'settings.account.banned') return 'mistake';
  if (key === 'quickmatch.errors.ageUnder') return 'birthYear';
  return null;
}

/** What the legal texts print where they name the support address: the address, the help page, or null to keep the placeholder. */
export function supportAddress(contact: SupportContact | null): string | null {
  return contact ? (contact.kind === 'email' ? contact.address : contact.url) : null;
}
