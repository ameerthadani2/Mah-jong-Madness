import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { claimPuzzle, discardAnalysis, discardPuzzle, ENGINE_REASON_KEYS, kindInfo, LESSONS, valuePuzzle, type PuzzleDifficulty } from '../src/index';

/** The puzzles' source: puzzles.ts and the files its themes are in. */
const puzzleSource = () => ['puzzles', 'puzzletable', 'puzzlediscard', 'puzzledefence', 'puzzleclaim', 'puzzlevalue'].map((f) => readFileSync(join(__dirname, `../src/${f}.ts`), 'utf8')).join('\n');

/** Every string inside a value, with its path. */
function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe('plain Taiwanese wording', () => {
  // Taiwanese players do not say 向聽 (a Japanese riichi term): the lessons, hints and reviews say 差 N 張聽牌,
  // 離聽牌還差幾張, and in English "tiles from ready".
  it('never shows 向聽 in a lesson, a hint or a review reason, in either language', () => {
    const found = [...strings(LESSONS, 'LESSONS'), ...strings(ENGINE_REASON_KEYS, 'reasons')].filter(([, s]) => s.includes('向聽'));
    expect(found).toEqual([]);
  });

  it('never writes 向聽 into a puzzle explanation', () => {
    expect(puzzleSource()).not.toContain('向聽');
  });

  it('keeps the lesson on counting exact: the formula, the five-slot limit and what 0 and -1 mean', () => {
    const steps = strings(LESSONS).map(([, s]) => s);
    expect(steps.some((s) => s.includes('離聽牌還差幾張 = 10 − 2 × 組數 − 搭子數 − 有眼再減 1'))).toBe(true);
    expect(steps.some((s) => s.includes('tiles from ready = 10 − 2 × sets − partial sets (搭子) − 1 if you have a 眼'))).toBe(true);
    expect(steps.some((s) => s.includes('組數是已經湊好的順子和刻子') && s.includes('組數和搭子加起來最多只算五個') && s.includes('0 就是聽牌，−1 就是胡了'))).toBe(true);
  });

  // 面子 is a riichi word, and 湊面子 reads as "saving face": a set is 順子 or 刻子, or 一組 (the showcase review of 20 November).
  it('never says 面子, in a lesson, a hint, a review reason or a puzzle explanation', () => {
    const found = [...strings(LESSONS, 'LESSONS'), ...strings(ENGINE_REASON_KEYS, 'reasons')].filter(([, s]) => s.includes('面子'));
    expect(found).toEqual([]);
    expect(puzzleSource()).not.toContain('面子');
  });

  // Unit 21's language check: riichi words left in the teaching text (振聽, 筋牌, 老頭牌, 捨牌, 牌河), 單吊 beside 單騎, and claim
  // lines that said 吃碰 when one claim was on offer. The puzzles' Chinese names the claim, and a number and its unit have a
  // space between, as the coach and the lessons write them.
  it('uses no riichi word in a lesson, a hint, a review reason or a puzzle explanation, and names the claim on offer', () => {
    const zh = [...strings(LESSONS, 'LESSONS'), ...strings(ENGINE_REASON_KEYS, 'reasons')].filter(([k]) => /Zh$|zh-TW/.test(k));
    expect(zh.filter(([, s]) => /振聽|筋牌|老頭牌|捨牌|牌河|單吊/.test(s))).toEqual([]);
    const src = puzzleSource();
    for (const word of ['振聽', '筋牌', '老頭牌', '捨牌', '牌河', '單吊', '吃碰後', '和不吃不碰一樣', '這是值得的']) expect(src, word).not.toContain(word);
    const claims = Array.from({ length: 60 }, (_, i) => claimPuzzle(`wording-c-${i}`, (1 + (i % 3)) as PuzzleDifficulty));
    for (const p of claims) {
      expect(p.explanationZh, p.seed).not.toMatch(/吃碰後|不吃不碰一樣/);
      expect(p.explanationZh, p.seed).not.toMatch(/(\d)[台張]/);
    }
    const values = Array.from({ length: 30 }, (_, i) => valuePuzzle(`wording-v-${i}`, (1 + (i % 3)) as PuzzleDifficulty));
    for (const p of values) expect(p.explanationZh, p.seed).not.toMatch(/(\d)[台張]/);
  });

  it('says a match is 一將 of 四圈 (16 莊), never 十六圈 or 圈莊', () => {
    const steps = strings(LESSONS).map(([, s]) => s);
    expect(steps.filter((s) => /十六圈|圈莊/.test(s))).toEqual([]);
    expect(steps.some((s) => s.includes('一將四圈'))).toBe(true);
  });
});

describe('English for an English reader', () => {
  it('names one suited tile in the singular: 1 Character, 1 Dot, 1 Bamboo', () => {
    // Before 18 November 2026: "1 Characters", "1 Dots".
    expect([kindInfo(0).nameEn, kindInfo(9).nameEn, kindInfo(18).nameEn]).toEqual(['1 Character', '1 Dot', '1 Bamboo']);
    for (let k = 0; k < 27; k++) expect(kindInfo(k).nameEn).toBe(`${(k % 9) + 1} ${['Character', 'Dot', 'Bamboo'][Math.floor(k / 9)]}`);
  });

  it('glosses 搭子 the first time a lesson uses it in English, as a partial set', () => {
    const gloss = /partial sets? \(搭子\)/;
    const unglossed: string[] = [];
    for (const lesson of LESSONS) {
      // In the order the lesson is read; Chinese fields end in Zh.
      const english = strings(lesson).filter(([path, text]) => !/Zh$/.test(path) && text.includes('搭子'));
      if (english.length > 0 && !gloss.test(english[0][1])) unglossed.push(`${lesson.id} ${english[0][0]}`);
    }
    expect(unglossed).toEqual([]);
  });

  it('glosses 搭子 in a puzzle explanation that names one', () => {
    const weak = discardAnalysis([0, 2, 3, 3, 4, 4, 5, 10, 14, 16, 21, 22, 25, 25, 25, 33, 33]);
    expect(weak.reasonKey).toBe('puzzle.discard.weakerTaatsu');
    expect(weak.explanation).toMatch(/^Break the weaker partial set \(搭子\)\. 1 Character and 3 Character wait only on 2 Character/);
    expect(weak.explanationZh).toMatch(/^拆比較弱的搭子。/);
    for (let i = 0; i < 120; i++) {
      const p = discardPuzzle(`gloss-${i}`, 3);
      if (p.explanation.includes('搭子')) expect(p.explanation).toMatch(/partial set \(搭子\)/);
    }
  });
});
