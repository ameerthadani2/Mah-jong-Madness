/**
 * The server-side answer checks (src/verify.ts) give the app's results: the same puzzle from the
 * same inputs, the same accepted answers, the same rating steps and the same Rush rule.
 */
import { describe, expect, it } from 'vitest';
import {
  dailyPuzzle,
  dailyPuzzleDifficulty,
  dailyPuzzleForKey,
  dateOfDailyKey,
  DEFAULT_PUZZLE_RATING,
  isPuzzleAnswerInput,
  judgePuzzleAnswer,
  judgeRushRun,
  MAX_PUZZLE_RATING,
  puzzleRatingFor,
  ratePuzzleAnswer,
  RUSH_STRIKES,
  rushDifficultyAt,
  rushPuzzle,
  rushRunPuzzle,
  updateRating,
  utcDateKey,
  PUZZLE_TYPES,
  type AnyPuzzle,
  type PuzzleAnswerInput,
} from '../src/index';

/** A right answer for any theme. */
function rightAnswer(p: AnyPuzzle): PuzzleAnswerInput {
  switch (p.type) {
    case 'waits':
      return p.answers;
    case 'claim':
      return p.answers[0];
    default:
      return p.answers[0];
  }
}

/** A wrong answer for any theme. */
function wrongAnswer(p: AnyPuzzle): PuzzleAnswerInput {
  switch (p.type) {
    case 'waits':
      return p.answers.slice(1);
    case 'claim':
      return p.options.find((o) => !p.answers.includes(o.id))?.id ?? 'not-an-option';
    case 'discard':
      return p.hand.find((k) => !p.answers.includes(k))!;
    default:
      return p.hand.find((k) => !p.answers.includes(k))!;
  }
}

describe('daily puzzle keys', () => {
  it('reads a local date key as the UTC midnight the app seeds the puzzle from', () => {
    expect(dateOfDailyKey('2026-11-16')?.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    for (const bad of ['2026-02-30', '2026-13-01', '26-11-16', '2026-11-16T00', 20261116, null]) expect(dateOfDailyKey(bad)).toBeNull();
    expect(utcDateKey(Date.UTC(2026, 10, 16, 23, 59))).toBe('2026-11-16');
  });

  it('regenerates the same puzzle and difficulty the app shows for that day', () => {
    const date = new Date(Date.UTC(2026, 10, 14));
    expect(dailyPuzzleForKey('2026-11-14')).toEqual(dailyPuzzle(date));
    expect(dailyPuzzleDifficulty(date)).toBe(3); // a Saturday
    expect(dailyPuzzleDifficulty(new Date(Date.UTC(2026, 10, 17)))).toBe(2); // a Tuesday
    expect(dailyPuzzleDifficulty(new Date(Date.UTC(2026, 10, 16)))).toBe(1); // a Monday
  });

  it('accepts every accepted discard and nothing else', () => {
    const p = dailyPuzzleForKey('2026-11-16')!;
    for (const k of p.answers) expect(judgePuzzleAnswer(p, k)).toBe(true);
    for (const k of p.hand.filter((k) => !p.answers.includes(k))) expect(judgePuzzleAnswer(p, k)).toBe(false);
    expect(judgePuzzleAnswer(p, [p.answers[0]])).toBe(false);
    expect(judgePuzzleAnswer(p, 'pass')).toBe(false);
  });
});

describe('answer shapes', () => {
  it('takes a tile kind, a set of kinds or a claim id, and nothing else', () => {
    for (const ok of [0, 33, [], [1, 2, 3], 'pass', 'hu', 'pong', 'kong', 'chi:3-4']) expect(isPuzzleAnswerInput(ok)).toBe(true);
    for (const bad of [-1, 34, 1.5, '1', [1, 1], [40], 'chi:a-b', 'draw', null, { id: 'pass' }, true, Array.from({ length: 35 }, (_, i) => i)]) expect(isPuzzleAnswerInput(bad)).toBe(false);
  });
});

describe('Puzzle Rush', () => {
  it('plays the five themes in rotation with the app ramp', () => {
    const types = Array.from({ length: 10 }, (_, i) => rushRunPuzzle('rush-test', i).type);
    expect(types).toEqual([...PUZZLE_TYPES, ...PUZZLE_TYPES]);
    expect(rushRunPuzzle('rush-test', 7)).toEqual(rushPuzzle('rush-test', 7, PUZZLE_TYPES));
    expect([0, 4, 5, 14, 15, 40].map(rushDifficultyAt)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('judges each answer and stops at the third wrong one', () => {
    const seed = 'rush-judge';
    const answers: PuzzleAnswerInput[] = [];
    // right, wrong, right, wrong, right, wrong (the third strike), then answers that are never judged
    for (let i = 0; i < 6; i++) {
      const p = rushRunPuzzle(seed, i);
      answers.push(i % 2 === 0 ? rightAnswer(p) : wrongAnswer(p));
    }
    answers.push(rightAnswer(rushRunPuzzle(seed, 6)), rightAnswer(rushRunPuzzle(seed, 7)));
    const run = judgeRushRun(seed, answers);
    expect(run.verdicts.map((v) => v.correct)).toEqual([true, false, true, false, true, false]);
    expect([run.solved, run.wrong]).toEqual([3, RUSH_STRIKES]);
    expect(run.verdicts.map((v) => v.type)).toEqual(PUZZLE_TYPES.concat(PUZZLE_TYPES).slice(0, 6));
  });
});

describe('rating', () => {
  it('moves the rating as the app does, one answer at a time', () => {
    let app = DEFAULT_PUZZLE_RATING;
    let server: number | null = null;
    const steps: Array<[(typeof PUZZLE_TYPES)[number], 1 | 2 | 3, boolean]> = [
      ['discard', 1, true],
      ['defence', 1, false],
      ['value', 3, true],
      ['claim', 2, true],
      ['waits', 2, false],
    ];
    for (const [type, d, solved] of steps) {
      const next = Math.min(MAX_PUZZLE_RATING, updateRating(app, puzzleRatingFor(type, d), solved));
      const r = ratePuzzleAnswer(server, type, d, solved);
      expect(r).toEqual({ rating: next, delta: next - app });
      app = next;
      server = r.rating;
    }
    expect(server).toBe(1052);
  });

  it('treats a missing or damaged rating as the default and never passes the ceiling', () => {
    for (const bad of [null, undefined, NaN, 50, 5000]) expect(ratePuzzleAnswer(bad, 'discard', 1, true)).toEqual({ rating: 1016, delta: 16 });
    expect(ratePuzzleAnswer(1000.4, 'discard', 1, false)).toEqual({ rating: 984, delta: -16 });
    expect(ratePuzzleAnswer(MAX_PUZZLE_RATING, 'value', 3, true).rating).toBe(MAX_PUZZLE_RATING);
  });
});
