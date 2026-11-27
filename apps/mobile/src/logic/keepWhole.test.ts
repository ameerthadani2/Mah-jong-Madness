import { describe, expect, it } from 'vitest';
import { engineReasonTranslations, kindInfo, LESSONS, NUM_KINDS } from '@mjm/engine';
import { keepWhole, NO_BREAK_SPACE as NB, unjoined, WORD_JOINER as WJ } from './keepWhole';
import { en, zhTW } from '../i18n/locales';

/** Every string inside a value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

const joined = (word: string) => [...word].join(WJ);

describe('keepWhole', () => {
  // The showcase review of 20 November: "…加槓上開花（1" / "台）。", "（1 台，門" / "清自摸…", "discarded 9" / "Dot", "15" / "秒".
  it('joins the scoring terms and the numbers with units the review saw split', () => {
    expect(keepWhole('開槓可以補一張牌，補到胡牌還能加槓上開花（1 台）。')).toContain(`加${joined('槓上開花')}（1${NB}台）。`);
    expect(keepWhole('會失去門清（1 台，門清自摸則是 3 台）。')).toBe(`會失去${joined('門清')}（1${NB}台，${joined('門清自摸')}則是 3${NB}台）。`);
    expect(keepWhole('底100 / 台20 · 四圈 · 一般（每手 15 秒 + 備用 30 秒）')).toContain(`每手 15${NB}秒 + 備用 30${NB}秒`);
    expect(keepWhole('阿花 (Bot) discarded 9 Dot')).toBe(`阿花 (Bot) discarded 9${NB}Dot`);
  });

  // Unit 21's check of the web export: 四 / 圈 on Home (320 wide, Extra-large), 一將四 / 圈 on a lesson card, 放 / 槍 on the
  // result sheet, 六萬 / ×3 in the coach, 底 / 300 in a lesson summary, 第 / 3 / 局, 140 / 點, and a lone last character.
  it('joins a count in Chinese numerals, a number with any unit, the stakes, a tile with its count and a line\'s last two characters', () => {
    expect(keepWhole('底100 / 台20 · 四圈 · 一般')).toContain(` ${joined('四圈')} `);
    expect(keepWhole('以及一將四圈怎麼從東風圈打到北風圈。')).toContain(`${joined('一將')}${joined('四圈')}`);
    expect(keepWhole('Tester 胡牌 / 阿花（電腦）放槍')).toContain(`）${joined('放槍')}`);
    expect(keepWhole('打 四條 就聽牌，聽 三萬×1、六萬×3。')).toContain(`、${joined('六萬')}${WJ}×${WJ}3。`);
    expect(keepWhole('用底100/台20和底300/台100實際算一遍。')).toContain(`和底${WJ}300${WJ}/${WJ}台${WJ}100實`);
    expect(keepWhole('底100 / 台20 · 16 rotations')).toBe(`底${WJ}100${NB}/${NB}台${WJ}20 · 16${NB}rotations`);
    expect(keepWhole('第 3 局')).toBe(`第${NB}3${NB}局`);
    expect(keepWhole('第3局')).toBe(`第${WJ}3${WJ}局`);
    expect(keepWhole('140 點')).toBe(`140${NB}點`);
    expect(keepWhole('平均 2.3台')).toContain(`2.3${WJ}台`);
    expect(keepWhole('連2拉2')).toBe(`連${WJ}2${WJ}拉${WJ}2`);
    expect(keepWhole('每天一題、人人同題，連續紀錄別中斷！')).toMatch(new RegExp(`別中${WJ}斷！$`));
    expect(keepWhole('先湊成順子或刻子，對子留著。\n下一行')).toContain(`留${WJ}著。\n`);
  });

  it('joins a four-character term whole, never as two words a line could part', () => {
    expect(keepWhole('門清自摸 3 台')).toContain(joined('門清自摸'));
    expect(keepWhole('現在就能胡（槓上開花），共 5 台。')).toContain(joined('槓上開花'));
  });

  it('joins every tile name of two characters or more, and every English tile name of two words', () => {
    for (let k = 0; k < NUM_KINDS; k++) {
      const { nameZh, nameEn } = kindInfo(k);
      if ([...nameZh].length > 1) expect(keepWhole(`打 ${nameZh} 吧`), nameZh).toContain(joined(nameZh));
      if (nameEn.includes(' ')) expect(keepWhole(`Discard ${nameEn} now.`), nameEn).toContain(nameEn.replace(/ /g, NB));
    }
  });

  it('leaves a term that is a whole label alone, and English without tile names as it is', () => {
    expect(keepWhole('門清自摸')).toBe('門清自摸');
    expect(keepWhole('Next hand')).toBe('Next hand');
    expect(keepWhole('Dot and 9 Dots')).toBe('Dot and 9 Dots');
  });

  it('changes nothing but the joins, in every string of both locales, the lessons and the coach', () => {
    const all = [...strings(en), ...strings(zhTW), ...strings(LESSONS), ...strings(engineReasonTranslations('zh-TW')), ...strings(engineReasonTranslations('en'))];
    expect(all.length).toBeGreaterThan(2000);
    for (const s of all) expect(unjoined(keepWhole(s)), s).toBe(unjoined(s));
  });
});
