import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ENGINE_REASON_KEYS, LESSONS } from '../src/index';

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
    expect(readFileSync(join(__dirname, '../src/puzzles.ts'), 'utf8')).not.toContain('向聽');
  });

  it('keeps the lesson on counting exact: the formula, the five-slot limit and what 0 and -1 mean', () => {
    const steps = strings(LESSONS).map(([, s]) => s);
    expect(steps.some((s) => s.includes('離聽牌還差幾張 = 10 − 2 × 面子數 − 搭子數 − 有眼再減 1'))).toBe(true);
    expect(steps.some((s) => s.includes('tiles from ready = 10 − 2 × sets − 搭子 − 1 if you have a 眼'))).toBe(true);
    expect(steps.some((s) => s.includes('面子和搭子加起來最多只算五個') && s.includes('0 就是聽牌，−1 就是胡了'))).toBe(true);
  });
});
