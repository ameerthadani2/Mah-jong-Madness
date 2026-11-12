import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, engineReasonTranslations, kindFromCode, kindOf, matchSnapshot, newGame, reviewHand, type Action, type ReviewedMove } from '@mjm/engine';
import { I18n } from 'i18n-js';
import { en as enLocale, zhTW } from '../i18n/locales';
import { reviewAction, reviewReasonParams, tileNames } from './reviewText';

/** The app's translator with the engine's reason templates under 'engine.', as src/i18n builds it. */
function appT(locale: 'en' | 'zh-TW') {
  const i18n = new I18n({ en: { ...enLocale, engine: engineReasonTranslations('en') }, 'zh-TW': { ...zhTW, engine: engineReasonTranslations('zh-TW') } });
  i18n.enableFallback = false;
  i18n.missingBehavior = 'error';
  i18n.locale = locale;
  return (key: string, params?: Record<string, unknown>) => i18n.t(key, params);
}

const HAN = /[\u4E00-\u9FFF]/;
const tileOf = (code: string) => (kindFromCode(code) * 4) as Parameters<typeof kindOf>[0];

describe('hand review text', () => {
  // The params the engine sends with a discard reason (packages/engine/src/review.ts): codes, and Chinese names.
  const params = { actual: '2s', best: 'S', actualName: '二條', bestName: '南', shantenActual: 6, shantenBest: 5, acceptanceActual: 10, acceptanceBest: 20 };

  it('names the tiles of a reason in English for a player reading English', () => {
    const t = appT('en');
    const text = t('engine.review.discard.worseShanten', reviewReasonParams('review.discard.worseShanten', params, 'en', t));
    expect(text).toBe('2 Bamboo leaves you 6 from ready; South Wind would leave you 5.');
    expect(text).not.toMatch(HAN);
  });

  it('keeps the Chinese names in Traditional Chinese', () => {
    const t = appT('zh-TW');
    const text = t('engine.review.discard.worseShanten', reviewReasonParams('review.discard.worseShanten', params, 'zh-TW', t));
    expect(text).toContain('二條');
    expect(text).toContain('南');
  });

  it('names what the coach would do instead of a kong', () => {
    const en = appT('en');
    expect(reviewReasonParams('review.turn.kongNotBest', { best: '5m' }, 'en', en).best).toBe('Discard 5 Characters');
    expect(reviewReasonParams('review.turn.kongNotBest', { best: 'hu' }, 'en', en).best).toBe('Win');
    const zh = appT('zh-TW');
    expect(reviewReasonParams('review.turn.kongNotBest', { best: '5m' }, 'zh-TW', zh).best).toContain('五萬');
  });

  it('leaves params without tiles alone', () => {
    const t = appT('en');
    expect(reviewReasonParams('review.call.worseShanten', { shantenBest: 1, shantenActual: 2 }, 'en', t)).toEqual({ shantenBest: 1, shantenActual: 2 });
  });

  it('describes each move with tile names in the reader\'s language', () => {
    const en = appT('en');
    const say = (a: ReviewedMove['actual'] | null, locale: 'en' | 'zh-TW', t = en) => {
      const m = reviewAction(a, locale);
      return t(m.key, m.params);
    };
    const discard = { type: 'discard', tile: tileOf('S') } as Action;
    expect(say(discard, 'en')).toBe('Discard South Wind');
    expect(say(discard, 'zh-TW', appT('zh-TW'))).toContain('南');
    const chi = { type: 'chi', tiles: [tileOf('4p'), tileOf('6p')] } as Action;
    expect(say(chi, 'en')).toBe('Chi 4 Dots, 6 Dots');
    expect(say(chi, 'en')).not.toMatch(HAN);
    expect(say(null, 'en')).toBe('—');
    expect(tileNames([kindFromCode('4p'), kindFromCode('6p')], 'zh-TW')).toBe('四筒、六筒');
  });

  it('a whole reviewed hand reads without a Chinese tile name in English', () => {
    // Bots play three hands to the end; seat 0's review must name every tile in English, in reasons and in moves.
    const t = appT('en');
    let lines = 0;
    for (const seed of ['review-text-1', 'review-text-2', 'review-text-3']) {
      const start = newGame(seed);
      let s = start;
      let guard = 0;
      while (s.phase !== 'ended' && guard++ < 3000) {
        for (let seat = 0; seat < 4; seat++) {
          const a = chooseAction(s, seat, { seed: `r${seat}` });
          if (a) {
            s = applyAction(s, seat, a);
            break;
          }
        }
      }
      for (const move of reviewHand(matchSnapshot(start), start.seed, start.rules, s.actionLog, 0).moves) {
        const line = t(`engine.${move.reasonKey}`, reviewReasonParams(move.reasonKey, move.reasonParams, 'en', t));
        // 門清 is a rule term the English copy keeps; tile names are not.
        expect(line.replace(/門清/g, ''), `${move.reasonKey}: ${line}`).not.toMatch(HAN);
        for (const a of [move.actual, move.best]) {
          const m = reviewAction(a, 'en');
          expect(t(m.key, m.params)).not.toMatch(HAN);
        }
        lines++;
      }
    }
    expect(lines).toBeGreaterThan(20);
  });
});
