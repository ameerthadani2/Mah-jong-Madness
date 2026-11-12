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

  const text = (doc: 'terms' | 'privacy', locale: 'en' | 'zh-TW') => LEGAL_DOCUMENTS[doc][locale].sections.flatMap((s) => s.paragraphs).join(' ');

  it('says what deleting an account removes and exactly what is kept, in both languages', () => {
    // The name goes from match results, archived seasons and reports, as the server does on deletion.
    expect(text('terms', 'en')).toMatch(/takes your name out of match results, archived club seasons and reports/);
    expect(text('privacy', 'en')).toMatch(/replace your name with "Deleted player" in your club entries, in match results and in archived club seasons/);
    expect(text('privacy', 'en')).toMatch(/erased within 30 days/);
    // Kept, without the name, each with how long.
    expect(text('privacy', 'en')).toMatch(/match results and archived club standings, which stay as long as the club or table history/);
    expect(text('privacy', 'en')).toMatch(/reports you made and reports made about you, kept as moderation records for as long as the service runs/);
    expect(text('privacy', 'en')).toMatch(/purchase and wallet records, kept for as long as tax and accounting law requires/);
    expect(text('privacy', 'en')).not.toMatch(/erase the rest within 30 days/);
    expect(text('terms', 'zh-TW')).toMatch(/從比賽結果、已封存的俱樂部賽季和檢舉紀錄中拿掉/);
    expect(text('privacy', 'zh-TW')).toMatch(/改為「已刪除的玩家」/);
    expect(text('privacy', 'zh-TW')).toMatch(/作為管理紀錄保存/);
  });

  it('says joining a club is free and running one needs The Four Winds Club', () => {
    expect(text('terms', 'en')).toMatch(/Joining a club and playing in it is free\. Creating and running a club needs The Four Winds Club\./);
    expect(text('terms', 'en')).not.toMatch(/Clubs are free/);
    expect(text('terms', 'zh-TW')).toMatch(/加入俱樂部並在其中打牌免費；開設並經營俱樂部需要四風俱樂部方案。/);
    expect(text('terms', 'zh-TW')).not.toMatch(/俱樂部免費。/);
  });

  it('says a yearly plan renews every year until cancelled', () => {
    expect(text('terms', 'en')).toMatch(/a yearly plan every year, until you cancel/);
    expect(text('terms', 'zh-TW')).toMatch(/年繳方案每年一次，直到你/);
  });

  it('lists the push token, the notification provider, the block list and the two privacy choices', () => {
    const en = text('privacy', 'en');
    expect(en).toMatch(/if you allow notifications, a push notification token/);
    expect(en).toMatch(/the players you block/);
    expect(en).toMatch(/notification delivery/);
    expect(en).toMatch(/Expo’s push service, which passes it to Apple or Google/);
    expect(en).toMatch(/your two privacy choices \(usage statistics and crash reports/);
    expect(en).toMatch(/Both are off until you agree: the app asks once, after the age question/);
    expect(en).toMatch(/switch usage statistics and crash reports on or off/);
    const zh = text('privacy', 'zh-TW');
    for (const term of ['推播通知權杖', '你封鎖的玩家', '通知傳送', 'Expo 的推播服務', '兩項隱私選擇', '同意之前都是關閉的', '開啟或關閉使用統計與當機報告']) expect(zh, term).toContain(term);
  });

  it('calls a club 俱樂部 everywhere in Chinese', () => {
    const all = JSON.stringify(zhTW) + text('terms', 'zh-TW') + text('privacy', 'zh-TW');
    expect(all).not.toContain('牌社');
    expect(all).toContain('俱樂部');
  });

  it('prints the build\'s support address in place of the placeholder, and keeps the placeholder without one', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      for (const doc of ['terms', 'privacy'] as const) {
        const filled = JSON.stringify(legalDocument(doc, locale, 'help@example.com'));
        expect(filled).toContain('help@example.com');
        expect(filled).not.toMatch(/\[support email\]|\[客服信箱\]/);
        expect(JSON.stringify(legalDocument(doc, locale, null))).toMatch(/\[support email\]|\[客服信箱\]/);
        // Still a draft either way.
        expect(legalDocument(doc, locale, 'help@example.com').version).toMatch(/^DRAFT /);
      }
    }
    expect(readFileSync(join(__dirname, 'LegalScreen.tsx'), 'utf8')).toMatch(/legalDocument\(doc, locale, supportAddress\(SUPPORT\)\)/);
    expect(readFileSync(join(__dirname, 'LegalScreen.tsx'), 'utf8')).toMatch(/legal\.draftBanner/);
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
