import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { translator } from '../logic/translator.fixture';
import { AGE_LIMIT, ageStatus, allowedFromYear, gateFor, migrateAgeRecord, needsServerSync, parseBirthYear } from './age';
import { LEGAL_DOCUMENTS, legalDocument } from './documents';
import { legalTarget, publishedUrl, readLegalEnv } from './links';
import { buildReport, REPORT_NOTE_MAX, REPORT_REASONS } from './reports';
import { canStartSeason, sortStandings, standingPoints } from './standings';

const YEAR = 2026;
const rec = (birthYear: number) => ({ birthYear, at: 0, synced: false });

describe('age gate', () => {
  it('limits play to 18 and over, counting the youngest a birth year allows', () => {
    expect(AGE_LIMIT).toBe(18);
    expect(ageStatus(null, YEAR)).toBe('unknown');
    expect(ageStatus(rec(1990), YEAR)).toBe('allowed');
    // Born 2007: certainly 18 by 1 January 2026.
    expect(ageStatus(rec(2007), YEAR)).toBe('allowed');
    // Born 2008: may still be 17 on any day of 2026.
    expect(ageStatus(rec(2008), YEAR)).toBe('blocked');
    expect(ageStatus(rec(2015), YEAR)).toBe('blocked');
    expect(allowedFromYear(2008)).toBe(2027);
    expect(ageStatus(rec(2008), 2027)).toBe('allowed');
  });

  it('says 18 wherever the app states the age, in both languages', () => {
    const texts = [...(['terms', 'privacy'] as const).flatMap((d) => (['en', 'zh-TW'] as const).map((l) => JSON.stringify(legalDocument(d, l)))), en.quickmatch.errors.ageUnder, zhTW.quickmatch.errors.ageUnder];
    for (const text of texts) expect(text).not.toMatch(/\b17\b/);
    expect(JSON.stringify(legalDocument('terms', 'en'))).toMatch(/rated 18\+\. You must be at least 18 years old/);
    expect(JSON.stringify(legalDocument('privacy', 'zh-TW'))).toMatch(/18 歲以上/);
    expect(en.quickmatch.errors.ageUnder).toMatch(/aged 18 and over/);
    expect(zhTW.quickmatch.errors.ageUnder).toMatch(/18 歲以上/);
    // The blocked screen takes the age from the same constant.
    expect(en.legal.age.blockedBody).toContain('%{age}');
    expect(readFileSync(join(__dirname, '..', 'components', 'AgeGate.tsx'), 'utf8')).toMatch(/age: AGE_LIMIT/);
  });

  it('accepts only a plausible four-digit year', () => {
    expect(parseBirthYear(' 1990 ', YEAR)).toBe(1990);
    for (const bad of ['', '90', '19900', 'abcd', '2027', '1890', '19 9']) expect(parseBirthYear(bad, YEAR), bad).toBeNull();
  });

  it('asks on a fresh install before anything else, and before the Shop or Clubs on an older install', () => {
    expect(gateFor('home', 'unknown', true)).toBe('ask');
    expect(gateFor('home', 'unknown', false)).toBe('none');
    expect(gateFor('shop', 'unknown', false)).toBe('ask');
    expect(gateFor('clubs', 'unknown', false)).toBe('ask');
    for (const where of ['home', 'shop', 'clubs'] as const) {
      expect(gateFor(where, 'blocked', false)).toBe('blocked');
      expect(gateFor(where, 'allowed', true)).toBe('none');
    }
  });

  it('sends an unsent answer once there is a server session, and reads stored answers defensively', () => {
    expect(needsServerSync(rec(1990), false)).toBe(false);
    expect(needsServerSync(rec(1990), true)).toBe(true);
    expect(needsServerSync({ ...rec(1990), synced: true }, true)).toBe(false);
    expect(needsServerSync(null, true)).toBe(false);
    expect(migrateAgeRecord({ birthYear: 1990, at: 5, synced: true })).toEqual({ birthYear: 1990, at: 5, synced: true });
    expect(migrateAgeRecord({ birthYear: '1990' })).toBeNull();
    expect(migrateAgeRecord(null)).toBeNull();
  });
});

describe('terms and privacy', () => {
  it('opens a published https URL when the build has one, else the bundled draft', () => {
    expect(legalTarget('terms', { termsUrl: 'https://example.com/terms' })).toEqual({ kind: 'url', url: 'https://example.com/terms' });
    expect(legalTarget('privacy', { termsUrl: 'https://example.com/terms' })).toEqual({ kind: 'bundled', doc: 'privacy' });
    for (const bad of ['', 'http://example.com/p', 'javascript:alert(1)', 'https://', 'example.com']) expect(publishedUrl(bad), bad).toBeNull();
  });

  it('with no env set the bundled drafts are used', () => {
    const env = readLegalEnv();
    expect(legalTarget('terms', env).kind).toBe('bundled');
    expect(legalTarget('privacy', env).kind).toBe('bundled');
  });

  it('both documents exist in both languages with the same sections, marked as drafts', () => {
    for (const doc of ['terms', 'privacy'] as const) {
      const en = LEGAL_DOCUMENTS[doc].en;
      const zh = LEGAL_DOCUMENTS[doc]['zh-TW'];
      expect(en.version).toMatch(/^DRAFT /);
      expect(zh.version).toBe(en.version);
      expect(zh.review).toBe('first pass, needs native review');
      expect(zh.sections.length).toBe(en.sections.length);
      zh.sections.forEach((s, i) => expect(s.paragraphs.length, `${doc} ${i}`).toBe(en.sections[i].paragraphs.length));
      for (const s of zh.sections) expect(s.heading + s.paragraphs.join(''), doc).toMatch(/[一-鿿]/);
      expect(legalDocument(doc, 'zh-TW')).toBe(zh);
    }
  });

  it('the terms carry the no-monetary-value sentence the Shop, Clubs and standings show', () => {
    const en = translator('en');
    const zh = translator('zh-TW');
    expect(en('legal.noValue')).toBe('Diamonds and points have no monetary value and cannot be redeemed or transferred.');
    expect(LEGAL_DOCUMENTS.terms.en.sections.flatMap((s) => s.paragraphs).join(' ')).toContain(en('legal.noValue').replace(/\.$/, ''));
    expect(LEGAL_DOCUMENTS.terms['zh-TW'].sections.flatMap((s) => s.paragraphs).join('')).toContain(zh('legal.noValue').replace(/。$/, ''));
    expect(en('legal.draftBanner')).toMatch(/^DRAFT — pending counsel review/);
  });

  it('the notice is rendered on the Shop, Clubs (list and standings) and Settings screens', () => {
    const read = (f: string) => readFileSync(join(__dirname, '..', 'screens', f), 'utf8');
    expect(read('ShopScreen.tsx')).toContain('<NoValueNotice');
    expect(read('ClubsScreen.tsx').match(/<NoValueNotice/g)?.length).toBe(2);
    expect(read('SettingsScreen.tsx')).toContain('<LegalLinks');
    expect(read('ShopScreen.tsx')).toContain('<LegalLinks');
  });
});

describe('reports', () => {
  const target = { userId: 'u-2', name: 'Auntie', roomCode: 'ROOM1' };
  it('needs a known reason and someone other than yourself', () => {
    expect(buildReport(target, null, '', 'u-1')).toBeNull();
    expect(buildReport(target, 'bogus' as never, '', 'u-1')).toBeNull();
    expect(buildReport(target, 'abusive_chat', '', 'u-2')).toBeNull();
    expect(buildReport({ ...target, userId: '' }, 'abusive_chat', '', 'u-1')).toBeNull();
    expect(buildReport(target, 'abusive_chat', '  ', 'u-1')).toEqual({ reportedUserId: 'u-2', reason: 'abusive_chat', roomCode: 'ROOM1' });
  });

  it('trims and caps the note', () => {
    const r = buildReport(target, 'other', `  ${'x'.repeat(REPORT_NOTE_MAX + 50)}  `, null)!;
    expect(r.details!.length).toBe(REPORT_NOTE_MAX);
  });

  it('every reason has copy in both languages', () => {
    for (const loc of ['en', 'zh-TW'] as const) {
      const t = translator(loc);
      for (const r of REPORT_REASONS) expect(t(`legal.report.reasons.${r}`), r).not.toMatch(/legal\./);
    }
  });
});

describe('seasonal standings', () => {
  const m = (name: string, points: number, seasonPoints?: number, lifetimePoints?: number, matchesWon = 0) => ({ name, points, seasonPoints, lifetimePoints, matchesWon });
  it('sorts by the chosen view, falling back to all-time points on an older server', () => {
    const members = [m('A', 50, 10, 50), m('B', 30, 40, 30), m('C', 20)];
    expect(sortStandings(members, 'season').map((x) => x.name)).toEqual(['B', 'C', 'A']);
    expect(sortStandings(members, 'lifetime').map((x) => x.name)).toEqual(['A', 'B', 'C']);
    expect(standingPoints(m('D', 7), 'season')).toBe(7);
  });

  it('breaks ties by matches won, then by name', () => {
    expect(sortStandings([m('Zed', 0, 0, 0, 1), m('Amy', 0, 0, 0, 1), m('Bob', 0, 0, 0, 3)], 'season').map((x) => x.name)).toEqual(['Bob', 'Amy', 'Zed']);
  });

  it('only the owner starts a new season', () => {
    expect(canStartSeason('owner')).toBe(true);
    expect(canStartSeason('admin')).toBe(false);
    expect(canStartSeason(undefined)).toBe(false);
  });
});
