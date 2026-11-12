import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { supportAddress, supportContact, supportHref, supportReason } from './support';

describe('the support contact of a build', () => {
  it('is the address when the build names a well-formed one, else an https help page, else nothing', () => {
    expect(supportContact({ email: ' help@example.com ' })).toEqual({ kind: 'email', address: 'help@example.com' });
    expect(supportContact({ email: 'help@example.com', url: 'https://example.com/help' })).toEqual({ kind: 'email', address: 'help@example.com' });
    expect(supportContact({ url: 'https://example.com/help' })).toEqual({ kind: 'url', url: 'https://example.com/help' });
    expect(supportContact({ email: 'not an address', url: 'http://example.com' })).toBeNull();
    expect(supportContact({ email: '[support email]' })).toBeNull();
    expect(supportContact({})).toBeNull();
  });

  it('opens a message with the subject and the player id, or the help page as it is', () => {
    const mail = supportHref({ kind: 'email', address: 'help@example.com' }, { subject: 'Mahjong Mania support', idLine: 'Player ID: u-123' });
    expect(mail).toBe('mailto:help@example.com?subject=Mahjong%20Mania%20support&body=Player%20ID%3A%20u-123%0A%0A');
    expect(supportHref({ kind: 'email', address: 'help@example.com' }, { subject: 'x', idLine: null })).toBe('mailto:help@example.com?subject=x');
    expect(supportHref({ kind: 'url', url: 'https://example.com/help' }, { subject: 'x', idLine: 'y' })).toBe('https://example.com/help');
  });

  it('gives the legal texts the address to print, or nothing', () => {
    expect(supportAddress({ kind: 'email', address: 'help@example.com' })).toBe('help@example.com');
    expect(supportAddress({ kind: 'url', url: 'https://example.com/help' })).toBe('https://example.com/help');
    expect(supportAddress(null)).toBeNull();
  });
});

describe('copy that sends a player to support', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  it('is offered under a ban and under a birth year that is too recent, and nowhere else', () => {
    expect(supportReason('quickmatch.errors.banned')).toBe('mistake');
    expect(supportReason('settings.account.banned')).toBe('mistake');
    expect(supportReason('quickmatch.errors.ageUnder')).toBe('birthYear');
    expect(supportReason('quickmatch.errors.rateLimited')).toBeNull();
    expect(supportReason(undefined)).toBeNull();
  });

  it('never tells a player to contact support in a string that is shown without the link', () => {
    // The sentence lives only under legal.support, which SupportLink renders, and only in a build with a contact.
    const mentions = (tree: unknown, path = ''): string[] =>
      typeof tree === 'string' ? (/contact support|corrected by support|聯絡客服/i.test(tree) ? [path] : []) : Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) => mentions(v, path ? `${path}.${k}` : k));
    for (const locale of [en, zhTW]) expect(mentions(locale).filter((k) => !k.startsWith('legal.support.'))).toEqual([]);
    expect(read('components/SupportLink.tsx')).toMatch(/if \(!SUPPORT\) return null;/);
  });

  it('puts the link wherever the ban or the age refusal is shown', () => {
    for (const f of ['screens/AccountCard.tsx', 'screens/ClubsScreen.tsx', 'screens/TableScreen.tsx', 'components/SignInPrompt.tsx']) expect(read(f), f).toMatch(/<SupportLink reason="mistake"/);
    expect(read('screens/QuickMatchScreen.tsx')).toMatch(/<SupportLink reason=\{failure\.support\}/);
    expect(read('screens/SettingsScreen.tsx')).toMatch(/<SupportLink \/>/);
  });

  it('says a ban once on the account card', () => {
    expect(read('screens/AccountCard.tsx')).toMatch(/auth\.error && !auth\.banned/);
  });
});
