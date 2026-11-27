import { describe, expect, it } from 'vitest';
import { compassSentence, hudNotice, wallCall, wallSentence, type HudFacts } from './hudSpeech';
import { I18n } from 'i18n-js';
import { en, zhTW } from '../../i18n/locales';

const i18n = new I18n({ en, 'zh-TW': zhTW });
const translate = (locale: string, key: string, params?: Record<string, unknown>) => i18n.t(key, { ...params, locale });

const facts = (o: Partial<HudFacts> = {}): HudFacts => ({ round: 0, myWind: 1, dealerRel: 3, drawsLeft: 40, ...o });

describe('what the compass and wall say aloud', () => {
  it('speaks the wall only as it drops to 10, to 5 and to its last tile', () => {
    const said: number[] = [];
    for (let n = 60; n > 0; n--) {
      const c = wallCall(n, n - 1);
      if (c !== null) said.push(c);
    }
    expect(said).toEqual([10, 5, 1]);
    expect(wallCall(null, 10)).toBeNull();
    expect(wallCall(3, 56)).toBeNull(); // a new hand's wall says nothing
    expect(wallCall(Number.NaN, 4)).toBeNull();
  });

  it('speaks the compass when the round or the seats turn, not when the dealer keeps the deal or on the first reading', () => {
    expect(hudNotice(null, facts())).toEqual([]);
    expect(hudNotice(facts(), facts({ drawsLeft: 39 }))).toEqual([]);
    expect(hudNotice(facts({ drawsLeft: 2 }), facts({ drawsLeft: 56 }))).toEqual([]);
    expect(hudNotice(facts({ drawsLeft: 2 }), facts({ myWind: 0, dealerRel: 0, drawsLeft: 56 }))).toEqual(['compass']);
    expect(hudNotice(facts(), facts({ round: 1 }))).toEqual(['compass']);
    expect(hudNotice(facts({ drawsLeft: 11 }), facts({ drawsLeft: 10 }))).toEqual(['wall']);
  });

  it('says them in both languages', () => {
    const en = (k: string, p?: Record<string, unknown>) => translate('en', k, p);
    const zh = (k: string, p?: Record<string, unknown>) => translate('zh-TW', k, p);
    expect(compassSentence(en, { round: 0, myWind: 1, dealerRel: 3 })).toBe('East round, you are South, the dealer is on your left');
    expect(compassSentence(en, { round: 1, myWind: 0, dealerRel: 0 })).toBe('South round, you are East and the dealer');
    expect(compassSentence(zh, { round: 0, myWind: 1, dealerRel: 3 })).toBe('東風圈，你是南家，莊家是你的上家');
    expect(compassSentence(zh, { round: 1, myWind: 0, dealerRel: 0 })).toBe('南風圈，你是東家，也是莊家');
    expect(wallSentence(en, 17)).toBe('17 tiles left in the wall');
    expect(wallSentence(en, 1)).toBe('The last tile in the wall');
    expect(wallSentence(zh, 17)).toBe('牌牆剩 17 張');
    expect(wallSentence(zh, 1)).toBe('牌牆剩最後 1 張');
  });
});

describe("the HUD's round chip", () => {
  it('names the round wind in words, with the dealer streak, in both languages', async () => {
    const { roundSentence } = await import('./hudSpeech');
    const en = (k: string, p?: Record<string, unknown>) => translate('en', k, p);
    const zh = (k: string, p?: Record<string, unknown>) => translate('zh-TW', k, p);
    expect(roundSentence(en, 0, 3, 0)).toBe('East round, hand 3');
    expect(roundSentence(en, 1, 3, 2)).toBe('South round, hand 3, the dealer has kept the deal 2 times');
    expect(roundSentence(zh, 1, 3, 2)).toBe('南風圈，第 3 局，莊家連2');
  });
});
