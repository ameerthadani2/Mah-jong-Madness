import { describe, expect, it } from 'vitest';
import { PUZZLE_TYPES, rushPuzzle } from '@mjm/engine';
import { en, zhTW } from '../i18n/locales';
import { rushDifficulty, rushOutcome, rushPuzzleAt, RUSH_TYPES } from './rush';

describe('rushOutcome', () => {
  it('reports a new personal best against the best from before the run', () => {
    expect(rushOutcome(500, 600)).toEqual({ kind: 'best' });
    expect(rushOutcome(0, 100).kind).toBe('best');
  });

  it('reports a matched best', () => {
    expect(rushOutcome(600, 600)).toEqual({ kind: 'matched' });
  });

  it('reports a plain finish below the best or with no score', () => {
    expect(rushOutcome(600, 500).kind).toBe('over');
    expect(rushOutcome(0, 0).kind).toBe('over');
  });

  it('would never report a best if compared with the already-updated best (why prevBest is captured at run start)', () => {
    const prevBest = 500;
    const score = 800;
    const savedAfterRun = Math.max(prevBest, score);
    expect(rushOutcome(savedAfterRun, score).kind).toBe('matched');
    expect(rushOutcome(prevBest, score).kind).toBe('best');
  });

  it('returns a kind only: the title is a locale key', () => {
    for (const r of [rushOutcome(1, 2), rushOutcome(2, 2), rushOutcome(3, 2)]) {
      expect(Object.keys(r)).toEqual(['kind']);
      const ns = (tree: unknown) => (tree as { puzzles: { rush: { outcome: Record<string, string> } } }).puzzles.rush.outcome[r.kind];
      expect(typeof ns(en)).toBe('string');
      expect(typeof ns(zhTW)).toBe('string');
    }
  });
});

describe('rush rotation', () => {
  it('rotates all five themes', () => {
    expect([...RUSH_TYPES].sort()).toEqual([...PUZZLE_TYPES].sort());
    const types = new Set(Array.from({ length: 10 }, (_, i) => rushPuzzleAt('rot', i).type));
    expect(types).toEqual(new Set(PUZZLE_TYPES));
  });

  it('is the engine rush with every theme, so a run replays', () => {
    for (let i = 0; i < 10; i++) expect(rushPuzzleAt('replay', i)).toEqual(rushPuzzle('replay', i, PUZZLE_TYPES));
  });

  it('ramps difficulty by index: under 5 is 1, under 15 is 2, then 3', () => {
    expect([0, 4, 5, 14, 15, 40].map(rushDifficulty)).toEqual([1, 1, 2, 2, 3, 3]);
    // The table themes carry their difficulty: it is the one the ramp gives.
    for (const i of [1, 3, 4, 6, 8, 9, 16, 18, 19]) {
      const p = rushPuzzleAt('ramp', i);
      if ('difficulty' in p) expect(p.difficulty).toBe(rushDifficulty(i));
    }
  });
});
