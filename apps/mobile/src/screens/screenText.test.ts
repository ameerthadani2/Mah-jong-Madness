/**
 * Checks over the source of the screens away from the table: results and errors are spoken, reading text is
 * not cut short, and buttons that repeat on a screen name what they act on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kindFromCode, kindsFromString } from '@mjm/engine';
import { tileListText } from '../logic/puzzle';
import { translator } from '../logic/translator.fixture';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('results and errors away from the table are spoken by a screen reader', () => {
  it('a live line is a live region on Android and the web, and an announcement on iOS', () => {
    const live = read('components/Live.tsx');
    expect(live).toMatch(/accessibilityLiveRegion=\{assertive \? 'assertive' : 'polite'\}/);
    expect(live).toMatch(/useAnnounce\(message\)/);
    expect(live).toMatch(/accessibilityRole: 'alert'/);
  });

  it('every puzzle theme puts its verdict and explanation in the answer region', () => {
    expect(read('components/puzzles/PuzzleParts.tsx')).toMatch(/export function Answer[\s\S]*?<Live message=\{spoken\} testID="puzzle-answer"/);
    // Best discard and waits live in PuzzleView; defence, claim and value in their own files.
    expect(read('components/PuzzleView.tsx').match(/<Answer spoken=/g)).toHaveLength(2);
    for (const f of ['Defence', 'Claim', 'Value']) expect(read(`components/puzzles/${f}PuzzleView.tsx`), f).toMatch(/<Answer spoken=\{\[t\(answered \? /);
    // Nothing shows a verdict outside that region.
    for (const f of ['components/PuzzleView.tsx', 'components/puzzles/DefencePuzzleView.tsx', 'components/puzzles/ClaimPuzzleView.tsx', 'components/puzzles/ValuePuzzleView.tsx']) {
      const code = read(f);
      expect(code.match(/<Verdict /g)?.length, f).toBe(code.match(/<Answer spoken=/g)?.length);
    }
  });

  it('Puzzle Rush names its score and its strikes', () => {
    const rush = read('screens/PuzzleScreens.tsx');
    expect(rush).toMatch(/accessibilityLabel=\{t\('learn\.rush\.solved', \{ count: score \}\)\}/);
    expect(rush).toMatch(/accessibilityLabel=\{t\('learn\.rush\.strikes', \{ n: strikes, max: RUSH_STRIKES \}\)\} accessibilityLiveRegion="polite"/);
    expect(translator('en')('learn.rush.strikes', { n: 1, max: 3 })).toBe('Strikes: 1 of 3');
    expect(translator('en')('learn.rush.solved', { count: 3 })).toBe('3 solved');
    expect(translator('zh-TW')('learn.rush.solved', { count: 3 })).toBe('已解 3 題');
  });

  it('the Shop, the Clubs screens, the Account card and the age gate speak what they report', () => {
    expect(read('screens/ShopScreen.tsx')).toMatch(/<Live message=\{msg\.text\}/);
    expect(read('screens/ClubsScreen.tsx')).toMatch(/<Live message=\{error\} assertive/);
    expect(read('screens/ClubsScreen.tsx')).toMatch(/<Live message=\{messages\.notice\}/);
    expect(read('screens/AccountCard.tsx')).toMatch(/<Live message=\{notice\}/);
    expect(read('screens/AccountCard.tsx')).toMatch(/<Live message=\{friendlyError\(auth\.error, t\)\} assertive/);
    expect(read('components/AgeGate.tsx')).toMatch(/<Live message=\{t\('legal\.age\.invalid'\)\} assertive/);
  });
});

describe('reading text on Learn', () => {
  const learn = read('screens/LearnScreen.tsx');

  it('shows every lesson and practice blurb whole: the card grows instead of cutting the sentence', () => {
    expect(learn).not.toMatch(/numberOfLines/);
  });

  it('names what each Start, Review and practice button opens', () => {
    expect(learn).toMatch(/accessibilityLabel=\{t\('learn\.cardButton', \{ action: t\(done \? 'learn\.review' : 'learn\.start'\), title: lessonTitle\(l, locale\) \}\)\}/);
    expect(learn).toMatch(/accessibilityLabel=\{t\('learn\.cardButton', \{ action: cta, title \}\)\}/);
    expect(translator('en')('learn.cardButton', { action: 'Train', title: 'Find the waits' })).toBe('Train: Find the waits');
    expect(read('screens/ClubsScreen.tsx')).toMatch(/accessibilityLabel=\{t\('clubs\.openNamed', \{ name: c\.name \}\)\}/);
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
    expect(read('components/PuzzleView.tsx')).not.toMatch(/kindsToString/);
  });
});
