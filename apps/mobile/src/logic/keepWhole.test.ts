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
