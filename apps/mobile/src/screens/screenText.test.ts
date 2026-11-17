/**
 * The sentences the screens away from the table speak and show: Puzzle Rush's score, strikes and clock, the names
 * of repeated buttons, and tiles listed in a puzzle explanation. The screens using them are rendered (*.render.test.tsx).
 */
import { describe, expect, it } from 'vitest';
import { kindFromCode, kindsFromString } from '@mjm/engine';
import { tileListText } from '../logic/puzzle';
import { translator } from '../logic/translator.fixture';

describe('results and errors away from the table are spoken by a screen reader', () => {
  // A live line being a polite region, an assertive alert for errors and an announcement on iOS is rendered in
  // src/components/SharedA11y.render.test.tsx.
  // Every puzzle theme's verdict and explanation shown in the answer region and nowhere else, spoken on iOS with the
  // tiles named in the reader's language: src/components/puzzles/PuzzleViews.render.test.tsx.
  it('Puzzle Rush has the sentences for its score, strikes and clock in both languages', () => {
    // The screen naming them (and the strikes as they change) is rendered in src/screens/Puzzles.render.test.tsx.
    expect(translator('en')('learn.rush.timeLeft', { minutes: 2, seconds: 45 })).toBe('Time left: 2 min 45 s');
    expect(translator('en')('learn.rush.strikes', { n: 1, max: 3 })).toBe('Strikes: 1 of 3');
    expect(translator('en')('learn.rush.solved', { count: 3 })).toBe('3 solved');
    expect(translator('zh-TW')('learn.rush.solved', { count: 3 })).toBe('已解 3 題');
  });
  // The Shop's purchase line, a club screen's error and notice, and the age gate's error are rendered as live lines in
  // src/screens/Shop.render.test.tsx, src/screens/Clubs.render.test.tsx and src/components/AgeGate.render.test.tsx.
});

describe('reading text on Learn', () => {
  // Every blurb shown whole, and each Start, Review and practice button named after what it opens, are rendered in
  // src/screens/Learn.render.test.tsx (and each club's Open button, named after the club, in Clubs.render.test.tsx).
  // What stays here is the sentence both languages build those names from.
  it('names a button by its action and its title', () => {
    expect(translator('en')('learn.cardButton', { action: 'Train', title: 'Find the waits' })).toBe('Train: Find the waits');
    expect(translator('zh-TW')('learn.cardButton', { action: '練習', title: '找聽牌' })).toMatch(/練習.*找聽牌/);
  });
});

describe('tiles listed in a puzzle explanation', () => {
  const kinds = kindsFromString('6789m 5789p 1456789s N F B');

  it('are named in the reader\'s language, grouped by suit', () => {
    expect(tileListText(kinds, 'en')).toBe('6, 7, 8, 9 Characters; 5, 7, 8, 9 Dots; 1, 4, 5, 6, 7, 8, 9 Bamboo; North Wind, Green Dragon, White Dragon');
    expect(tileListText(kinds, 'zh-TW')).toBe('六、七、八、九萬；五、七、八、九筒；一、四、五、六、七、八、九條；北、發、白');
    expect(tileListText([kindFromCode('E')], 'en')).toBe('East Wind');
    expect(tileListText([kindFromCode('5m'), kindFromCode('5m')], 'zh-TW')).toBe('五萬');
    expect(tileListText([], 'en')).toBe('');
  });

  it('never fall back to the m / p / s codes', () => {
    expect(tileListText(kinds, 'en')).not.toMatch(/\d[mps]\b/);
    // A puzzle's spoken answer never using them is rendered in src/components/puzzles/PuzzleViews.render.test.tsx.
  });
});
