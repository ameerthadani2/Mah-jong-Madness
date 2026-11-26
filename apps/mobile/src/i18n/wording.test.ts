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

  // The showcase review of 20 November (a native Taiwanese reader), over every zh-TW string the app shows: its own locale
  // files and the engine's templates (the coach, the review reasons). Each was a bug in the app, not only in a caption.
  it('uses Taiwan wording, not Mainland or riichi words, in every zh-TW string', async () => {
    const { engineStrings } = await import('./engineWording');
    const all = [...strings(zhTW, 'zh-TW'), ...strings(engineStrings('zh-TW'), 'engine')];
    const hits = (re: RegExp) => all.filter(([, s]) => re.test(s)).map(([k]) => k);
    expect(hits(/面子/), '面子 is a riichi word (湊面子 reads as saving face): 順子或刻子, 一組').toEqual([]);
    expect(hits(/複盤/), 'Taiwan writes 覆盤').toEqual([]);
    expect(hits(/成員/), 'a club has 會員').toEqual([]);
    expect(hits(/負責人/), "the club's owner is its 會長").toEqual([]);
    expect(hits(/(?<!備)用時/), '用時 is Mainland sports wording: 時間').toEqual([]);
    expect(hits(/表情包/), '表情包 is Mainland slang: 表情貼圖').toEqual([]);
    expect(hits(/權利/), '權利 is a legal right: 資格').toEqual([]);
    expect(hits(/自摸胡|最佳打牌|十六圈莊|圈莊/)).toEqual([]);
    expect(hits(/吃碰這張|吃碰沒有幫助/), 'a claim reason names the claim on offer').toEqual([]);
  });

  it('writes the full-width ！ in Chinese text, in both locales and in the engine templates', async () => {
    const { engineStrings } = await import('./engineWording');
    const all = [...strings(zhTW, 'zh-TW'), ...strings(en, 'en'), ...strings(engineStrings('zh-TW'), 'engine')];
    // A ! beside a Chinese character (the review grades' ?! is a chess mark, not punctuation, and stays as it is).
    const half = all.filter(([, s]) => /[\u3400-\u9fff][^\u3400-\u9fff\w%{}]{0,2}!|![\u3400-\u9fff]/.test(s.replace(/\?!/g, '')));
    expect(half).toEqual([]);
    expect([zhTW.table.claim.selfDrawWin, zhTW.table.claim.win, zhTW.table.result.wonTitle]).toEqual(['自摸！', '胡！', '你胡了！']);
    expect([en.table.claim.selfDrawWin, en.table.claim.win, en.table.result.wonTitle]).toEqual(['自摸！', '胡！', '你胡了！']);
  });

  it('counts a match in 圈 and keeps one word per thing', () => {
    expect(strings(zhTW.settings.presets, 'presets').filter(([, s]) => /\d+ 局/.test(s))).toEqual([]);
    expect(zhTW.learn.discard.title).toBe('打哪張？');
    expect(zhTW.puzzles.types.discard).toBe(zhTW.learn.discard.title);
    expect(zhTW.home.learn.open).toBe('去上課');
    expect(zhTW.clubs.members.transfer).toBe('轉讓會長');
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
