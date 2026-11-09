/**
 * Source checks for the puzzle screens (they render React Native, which these tests do not load); the
 * behaviour itself is driven in the web build by the puzzle probe and e2e.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en/puzzles.json';
import zh from '../i18n/locales/zh-TW/puzzles.json';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('drill difficulty switch', () => {
  it('mounts a fresh, unanswered puzzle: the seed names the difficulty', () => {
    const src = read('DrillScreen.tsx');
    expect(src).toMatch(/return `\$\{kind\}-\$\{runId\}-d\$\{difficulty\}-\$\{n\}`/);
    expect(src).toMatch(/const seed = drillSeed\(kind, runId, difficulty, n\)/);
  });
});

describe('leaving Puzzle Rush mid-run', () => {
  const src = read('PuzzleScreens.tsx');
  it('does not spend the free run when the screen merely opens', () => {
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*if \(allowance\.ok && allowance\.limit !== null\) app\.setWallet\(consume/);
    expect(src).toMatch(/if \(!answeredOnce\) onStart\(\)/);
  });

  it('asks first, then records the run it spent', () => {
    expect(src).toMatch(/onBack=\{back\}/);
    expect(src).toMatch(/answeredOnce && !over \? setAskLeave\(true\)/);
    expect(src).toMatch(/const leaveRun = \(\) => \{\s*setAskLeave\(false\);\s*record\(\);/);
    expect(en.rush.leaveTitle).toBeTruthy();
    expect(zh.rush.leaveTitle).toBeTruthy();
  });
});

describe('tall puzzle screens', () => {
  it('fill the space under the puzzle with the player’s record and a tip', () => {
    expect(read('PuzzleScreens.tsx').match(/<PuzzleFoot/g)?.length).toBeGreaterThanOrEqual(2);
    expect(read('DrillScreen.tsx')).toMatch(/<PuzzleFoot \/>/);
  });
});
