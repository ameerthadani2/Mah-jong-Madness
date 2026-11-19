import { describe, expect, it } from 'vitest';
import { en, zhTW } from './locales';

/** Every string inside a locale, with its key. */
function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe('plain Taiwanese wording in the app', () => {
  it('never shows 向聽 (a riichi term Taiwanese players do not use) in either locale', () => {
    // 差 N 張聽牌 for a count, 離聽牌還差幾張 for the idea; in English, "from ready".
    expect([...strings(en, 'en'), ...strings(zhTW, 'zh-TW')].filter(([, s]) => s.includes('向聽'))).toEqual([]);
    expect(zhTW.puzzles.view.fromReady).toBe('差 %{n} 張聽牌');
  });

  it('asks the Rush and daily discard question in Chinese without doubling the verb', () => {
    // The sixth assessment read '你剛摸完牌。最佳打法打完後還差 4 張聽牌。要打哪一張？': 打法打完後 says "play" twice.
    const fill = (s: string, params: Record<string, string | number>) => s.replace(/%\{(\w+)\}/g, (_, k: string) => String(params[k]));
    const prompt = (status: string) => fill(zhTW.puzzles.view.discardIntro, { status });
    expect(prompt(fill(zhTW.puzzles.view.status.leaves, { n: 4 }))).toBe('你剛摸完牌。就算打對了，也還差 4 張聽牌。要打哪一張？');
    expect(prompt(zhTW.puzzles.view.status.oneFromReady)).toBe('你剛摸完牌。打對一張就聽牌。要打哪一張？');
    expect(strings(zhTW, 'zh-TW').filter(([, s]) => /打法打|打完後/.test(s))).toEqual([]);
  });

  it('names the claim 吃 Chow in English everywhere a player meets it at the table: the coach, the buttons and the review', async () => {
    const { engineStrings } = await import('./engineWording');
    const at = (o: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], o) as string;
    // The coach's bar and sheet (the engine's template, in the app's wording), the claim button's gloss and spoken name.
    expect(at(engineStrings('en'), 'hint.label.chi')).toBe('Chow (吃) %{handTiles} + %{tileName}');
    expect(en.table.claimGloss.chi).toBe('Chow');
    expect(en.table.a11y.chi).toBe('Chow');
    expect(en.review.action.chi).toMatch(/^Chow /);
    // No English line at the table or in the review says Chi; the engine's other templates are as it gives them.
    expect([...strings(en.table, 'table'), ...strings(en.review, 'review')].filter(([, s]) => /\bChi\b/.test(s))).toEqual([]);
    expect(at(engineStrings('en'), 'hint.label.pong')).toBe(at((await import('@mjm/engine')).engineReasonTranslations('en'), 'hint.label.pong'));
    expect(at(engineStrings('zh-TW'), 'hint.label.chi')).toBe('吃 %{handTiles} + %{tileZh}');
  });
});
