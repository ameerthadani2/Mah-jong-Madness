import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_CAVEATS, AUDIT_FAILURES, type AuditFailure } from '@mjm/net';
import { en, zhTW } from '../i18n/locales';
import { caveatText, endUnverified, failureText } from './fairnessText';
import { translator } from './translator.fixture';

/**
 * A hand that fails its checks is the one moment the Fair play screen must be understood, so its
 * reasons are shown in the player's language: `fairness.failure.<key>` for every sentence the
 * table client can write (packages/net keeps the list and tests that it is complete).
 */
const english = en.fairness.failure as Record<string, string>;
const chinese = zhTW.fairness.failure as Record<string, string>;
const entries = Object.entries(AUDIT_FAILURES) as Array<[AuditFailure, string | RegExp]>;
const placeholders = (text: string) => [...text.matchAll(/%\{(\w+)\}/g)].map((m) => m[1]).sort();
const carried = (entry: string | RegExp) => (typeof entry === 'string' ? [] : [...entry.source.matchAll(/\(\?<(\w+)>/g)].map((m) => m[1]));

/** A sentence the client would write for a key: the plain text itself, or the pattern with its values filled in. */
function example(entry: string | RegExp): string {
  if (typeof entry === 'string') return entry;
  return entry.source
    .replace(/^\^|\$$/g, '')
    .replace(/\(\?<fields>[^)]*\)/, 'scores, dealerSeat')
    .replace(/\(\?<detail>[^)]*\)/, 'Not your turn')
    .replace(/\(\?<\w+>(?:\[[^\]]*\]|[^()])*\)/g, '7')
    .replace(/\\([()])/g, '$1');
}

describe('audit failure texts in the app', () => {
  it('every failure the table client can report has text in both languages', () => {
    for (const [key] of entries) {
      expect(english[key], `en fairness.failure.${key}`).toBeTruthy();
      expect(chinese[key], `zh-TW fairness.failure.${key}`).toBeTruthy();
      expect(chinese[key], `zh-TW fairness.failure.${key} is translated`).not.toBe(english[key]);
    }
  });

  it('there is no text for a failure the client no longer reports', () => {
    expect(Object.keys(english).sort()).toEqual(Object.keys(AUDIT_FAILURES).sort());
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(AUDIT_FAILURES).sort());
  });

  it('a text asks only for values its sentence carries, the same ones in both languages', () => {
    for (const [key, entry] of entries) {
      const available = carried(entry);
      for (const name of placeholders(english[key])) expect(available, `en fairness.failure.${key} %{${name}}`).toContain(name);
      expect(placeholders(chinese[key]), `zh-TW fairness.failure.${key}`).toEqual(placeholders(english[key]));
    }
  });

  it('the Chinese texts are Chinese sentences, not the client\'s English', () => {
    for (const [key] of entries) {
      const text = chinese[key].replace(/%\{\w+\}/g, '');
      expect(/\p{Script=Han}/u.test(text), key).toBe(true);
      // "App" is the one Latin word a player in Taiwan reads as their own.
      expect(text.replace(/\bApp\b/g, '').match(/[A-Za-z]{2,}/g) ?? [], key).toEqual([]);
      expect(/[。）]$/.test(text), `${key} ends as a sentence`).toBe(true);
    }
  });

  it('shows every failure in the language of the app, with its values in place', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const t = translator(locale);
      for (const [key, entry] of entries) {
        const raw = example(entry);
        const shown = failureText(t, raw);
        expect(shown, `${locale} ${key}`).toBe(t(`fairness.failure.${key}`, Object.fromEntries(carried(entry).map((name) => [name, name === 'fields' ? 'scores, dealerSeat' : name === 'detail' ? 'Not your turn' : '7']))));
        expect(shown, `${locale} ${key}`).not.toContain('%{');
        expect(shown, `${locale} ${key}`).not.toMatch(/missing|\[object/i);
        if (locale === 'zh-TW') expect(shown, key).not.toBe(raw);
      }
    }
  });

  it('puts the turn, the seat and the counts of a sentence into its translation', () => {
    const zh = translator('zh-TW');
    const english = translator('en');
    expect(failureText(zh, 'The table played for this seat and passed up its win (turn 17)')).toBe('牌桌替你出牌，卻放掉了你可以胡的牌（第 17 手）。');
    expect(failureText(english, 'The table played for this seat and passed up its win (turn 17)')).toBe('The table played for you and passed up your win (turn 17).');
    expect(failureText(zh, 'Restart 1 blames seat 3, which is a bot')).toBe('發牌第 1 次重來算在 3 號位頭上，但那是電腦玩家。');
    expect(failureText(english, '4 ceremony attempts is more than 2, the most an honest table with 1 human seats needs')).toBe('The deal took 4 attempts. An honest table with this many human players (1) needs 2 at most.');
    expect(failureText(zh, 'Host altered my secret')).toBe('紀錄裡你這個位子的祕密，和你的手機送出的不一樣。');
  });

  it('shows a reason this build does not know as it came, in either colour', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const t = translator(locale);
      expect(failureText(t, 'A check added by a newer table')).toBe('A check added by a newer table');
      expect(failureText(t, '')).toBe('');
      expect(caveatText(t, 'A caveat added by a newer table')).toBe('A caveat added by a newer table');
      // A failure is never explained with a caveat's words, nor the other way round.
      expect(failureText(t, AUDIT_CAVEATS.appRestart)).toBe(AUDIT_CAVEATS.appRestart);
      expect(caveatText(t, 'Host altered my secret')).toBe('Host altered my secret');
    }
  });

  it('tells a player whose app restarted that the amber hand is expected, in the words of the green label', () => {
    // The first hand after a restart is amber by design: the sentence must not read like an accusation,
    // and it names the green status exactly as the pill shows it.
    for (const [locale, tree] of [['en', en], ['zh-TW', zhTW]] as const) {
      const text = caveatText(translator(locale), AUDIT_CAVEATS.appRestart);
      expect(text, locale).toContain(tree.fairness.status.ok);
      expect(text, locale).toBe(tree.fairness.caveat.appRestart);
    }
  });

  it('shows a caveat by its key', () => {
    expect(caveatText(translator('zh-TW'), AUDIT_CAVEATS.appRestart)).toBe(zhTW.fairness.caveat.appRestart);
    expect(caveatText(translator('en'), AUDIT_CAVEATS.standIn)).toBe(en.fairness.caveat.standIn);
  });
});

describe('final scores this phone could not check', () => {
  it('are marked only when the match is over and the verified hands do not lead to its end', () => {
    expect(endUnverified({ matchOver: true, matchEndVerified: false })).toBe(true);
    expect(endUnverified({ matchOver: true, matchEndVerified: true })).toBe(false);
    // During a match there are no final scores to mark, whatever the flag says.
    expect(endUnverified({ matchOver: false, matchEndVerified: false })).toBe(false);
    expect(endUnverified({ matchOver: false, matchEndVerified: true })).toBe(false);
  });

  it('are marked when a saved record from an older build carries no verdict, and never without a table', () => {
    expect(endUnverified({ matchOver: true } as { matchOver: boolean; matchEndVerified: boolean })).toBe(true);
    expect(endUnverified(null)).toBe(false);
    expect(endUnverified(undefined)).toBe(false);
  });

  it('are marked when the last hand could not check the scores it started from, even if that hand itself ends the match as told', () => {
    // A phone that missed earlier hands and was not shown their records: the last hand carries the gap caveat.
    expect(endUnverified({ matchOver: true, matchEndVerified: true, auditCaveats: [AUDIT_CAVEATS.gap] })).toBe(true);
    expect(endUnverified({ matchOver: true, matchEndVerified: true, auditCaveats: [AUDIT_CAVEATS.standIn, AUDIT_CAVEATS.gap] })).toBe(true);
    // Other caveats are about the deal, not about the scores: the end stays checked.
    expect(endUnverified({ matchOver: true, matchEndVerified: true, auditCaveats: [AUDIT_CAVEATS.standIn, AUDIT_CAVEATS.appRestart] })).toBe(false);
    expect(endUnverified({ matchOver: true, matchEndVerified: true, auditCaveats: [] })).toBe(false);
    // And never while the match is still on.
    expect(endUnverified({ matchOver: false, matchEndVerified: true, auditCaveats: [AUDIT_CAVEATS.gap] })).toBe(false);
  });

  it('has a sentence for it in both languages', () => {
    expect(translator('en')('fairness.endUnverified')).toMatch(/could not check the final scores/);
    expect(translator('zh-TW')('fairness.endUnverified')).toMatch(/無法核對最終分數/);
  });

  it('is what both sheets that show final scores ask before they show the note', () => {
    const sheet = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'table', 'ResultSheet.tsx'), 'utf8');
    // The hand result at the end of a match (both layouts) and the match-over ranking.
    expect(sheet.match(/<EndUnverifiedNote state=\{state\} testID="result-end-unverified" \/>/g)).toHaveLength(2);
    expect(sheet.match(/<EndUnverifiedNote state=\{state\} testID="match-end-unverified" \/>/g)).toHaveLength(1);
    expect(sheet).toContain('if (!endUnverified(state)) return null;');
  });
});

describe('the Fair play screen after a match against bots', () => {
  const screen = readFileSync(join(__dirname, '..', 'screens', 'FairnessScreen.tsx'), 'utf8');

  it('says the phone dealt and checked its own deal, above the steps written for online tables', () => {
    expect(screen).toMatch(/const local = app\.session\?\.mode === 'local';/);
    expect(screen.indexOf('testID="fairness-local"')).toBeGreaterThan(0);
    expect(screen.indexOf('testID="fairness-local"')).toBeLessThan(screen.indexOf("t('fairness.step1')"));
    expect(translator('en')('fairness.localNote')).toMatch(/your phone deals and checks its own deal/);
    expect(translator('zh-TW')('fairness.localNote')).toMatch(/你的手機自己來/);
  });

  it('does not call the fifth secret a server\'s when no server took part', () => {
    expect(screen).toMatch(/t\(local \? 'fairness\.table' : 'fairness\.server'\)/);
    expect(translator('en')('fairness.table')).toBe('table');
  });

  it('uses one Chinese name for quick match everywhere', () => {
    const all = JSON.stringify(zhTW);
    expect(all).not.toContain('快速配桌');
    expect(zhTW.fairness.trust).toContain('快速配對');
    expect(zhTW.lobby.quickStarts).toContain('快速配對');
  });
});
