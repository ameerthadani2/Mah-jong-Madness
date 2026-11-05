import { describe, expect, it } from 'vitest';
import { puzzleRatingFor, rushScore, updateRating, type PuzzleType } from '@mjm/engine';
import { DEFAULT_PUZZLE_RATING, formatRatingChange, lastRatingChange, MIN_PUZZLE_RATING, migratePuzzleProgress, RATING_HISTORY_MAX, rateAnswer, ratingTrend, recordRush, type RatingState } from './rating';

const fresh = (): RatingState => ({ puzzleRating: DEFAULT_PUZZLE_RATING, ratingHistory: [] });

describe('rateAnswer', () => {
  it('moves the rating up on a solve and down on a miss', () => {
    const up = rateAnswer(fresh(), 'discard', 2, true, 1);
    const down = rateAnswer(fresh(), 'discard', 2, false, 1);
    expect(up.puzzleRating).toBeGreaterThan(DEFAULT_PUZZLE_RATING);
    expect(down.puzzleRating).toBeLessThan(DEFAULT_PUZZLE_RATING);
  });

  it('uses the engine: updateRating against puzzleRatingFor(type, difficulty)', () => {
    for (const type of ['discard', 'waits', 'defence', 'claim', 'value'] as PuzzleType[]) {
      for (const d of [1, 2, 3] as const) {
        expect(rateAnswer(fresh(), type, d, true, 0).puzzleRating).toBe(updateRating(1000, puzzleRatingFor(type, d), true));
        expect(rateAnswer(fresh(), type, d, false, 0).puzzleRating).toBe(updateRating(1000, puzzleRatingFor(type, d), false));
      }
    }
  });

  it('gains more for a harder puzzle and loses more on an easier one', () => {
    expect(rateAnswer(fresh(), 'value', 3, true, 0).puzzleRating).toBeGreaterThan(rateAnswer(fresh(), 'discard', 1, true, 0).puzzleRating);
    expect(rateAnswer(fresh(), 'discard', 1, false, 0).puzzleRating).toBeLessThan(rateAnswer(fresh(), 'value', 3, false, 0).puzzleRating);
  });

  it('is deterministic', () => {
    const run = () => {
      let s = fresh();
      for (let i = 0; i < 20; i++) s = rateAnswer(s, i % 2 ? 'claim' : 'defence', ((i % 3) + 1) as 1 | 2 | 3, i % 3 !== 0, i);
      return s;
    };
    expect(run()).toEqual(run());
  });

  it('stays bounded: each answer moves it by at most K = 32 and never below the floor', () => {
    let s: RatingState = { puzzleRating: MIN_PUZZLE_RATING + 5, ratingHistory: [] };
    for (let i = 0; i < 50; i++) {
      const next = rateAnswer(s, 'discard', 1, false, i);
      expect(Math.abs(next.puzzleRating - s.puzzleRating)).toBeLessThanOrEqual(32);
      expect(next.puzzleRating).toBeGreaterThanOrEqual(MIN_PUZZLE_RATING);
      s = next;
    }
    expect(s.puzzleRating).toBeLessThanOrEqual(MIN_PUZZLE_RATING + 5);
    expect(rateAnswer({ puzzleRating: MIN_PUZZLE_RATING, ratingHistory: [] }, 'discard', 1, false, 0).puzzleRating).toBe(MIN_PUZZLE_RATING);
    let hi = fresh();
    for (let i = 0; i < 500; i++) hi = rateAnswer(hi, 'value', 3, true, i);
    // Solving forever converges instead of running away: the expected score approaches 1.
    expect(hi.puzzleRating).toBeLessThan(3000);
  });

  it('records a capped history, newest last, with each delta', () => {
    let s = fresh();
    for (let i = 0; i < RATING_HISTORY_MAX + 5; i++) s = rateAnswer(s, 'waits', 2, i % 2 === 0, 1000 + i);
    expect(s.ratingHistory).toHaveLength(RATING_HISTORY_MAX);
    const last = s.ratingHistory[s.ratingHistory.length - 1];
    expect(last.at).toBe(1000 + RATING_HISTORY_MAX + 4);
    expect(last.rating).toBe(s.puzzleRating);
    expect(lastRatingChange(s.ratingHistory)).toBe(last.delta);
    for (let i = 1; i < s.ratingHistory.length; i++) expect(s.ratingHistory[i].rating - s.ratingHistory[i - 1].rating).toBe(s.ratingHistory[i].delta);
  });

  it('keeps the rest of the progress untouched', () => {
    const p = { ...fresh(), drillsPlayed: 4, lessonsDone: { a: true } };
    const next = rateAnswer(p, 'discard', 1, true, 0);
    expect(next.drillsPlayed).toBe(4);
    expect(next.lessonsDone).toEqual({ a: true });
    expect(p.ratingHistory).toEqual([]);
  });
});

describe('ratingTrend', () => {
  it('sums the last n deltas', () => {
    let s = fresh();
    s = rateAnswer(s, 'discard', 2, true, 0);
    s = rateAnswer(s, 'discard', 2, true, 1);
    expect(ratingTrend(s.ratingHistory)).toBe(s.puzzleRating - DEFAULT_PUZZLE_RATING);
    expect(ratingTrend(s.ratingHistory, 1)).toBe(s.ratingHistory[1].delta);
    expect(ratingTrend([])).toBe(0);
    expect(lastRatingChange([])).toBeNull();
  });
});

describe('formatRatingChange', () => {
  it('signs the change', () => {
    expect(formatRatingChange(16)).toBe('+16');
    expect(formatRatingChange(-9)).toBe('-9');
    expect(formatRatingChange(0)).toBe('0');
  });
});

describe('migratePuzzleProgress', () => {
  it('gives old progress the defaults', () => {
    const old = { drillsPlayed: 3, rushBest: 7, rushRuns: 2 };
    const m = migratePuzzleProgress(old);
    expect(m).toEqual({ drillsPlayed: 3, rushBest: 7, rushRuns: 2, puzzleRating: 1000, ratingHistory: [], rushBestScore: 0 });
  });

  it('repairs damaged values and drops entries that do not parse', () => {
    const good = { rating: 1016, delta: 16, type: 'defence', difficulty: 2, solved: true, at: 5 };
    const m = migratePuzzleProgress({ puzzleRating: 'lots', ratingHistory: [good, null, { rating: 1, delta: 0, type: 'x' }, { ...good, difficulty: 7 }], rushBestScore: -3 });
    expect(m.puzzleRating).toBe(1000);
    expect(m.ratingHistory).toEqual([good]);
    expect(m.rushBestScore).toBe(0);
    expect(migratePuzzleProgress({ puzzleRating: Infinity }).puzzleRating).toBe(1000);
    expect(migratePuzzleProgress({ puzzleRating: 99999 }).puzzleRating).toBe(1000);
    expect(migratePuzzleProgress({ ratingHistory: 'nope' }).ratingHistory).toEqual([]);
  });

  it('keeps a valid saved rating and history', () => {
    const saved = { puzzleRating: 1234, ratingHistory: [{ rating: 1234, delta: -9, type: 'value', difficulty: 3, solved: false, at: 9 }], rushBestScore: 850 };
    expect(migratePuzzleProgress(saved)).toEqual(saved);
  });
});

describe('recordRush', () => {
  const base = { rushRuns: 2, rushBest: 6, rushBestScore: 700, other: 'kept' };

  it('scores a run with rushScore and raises both bests', () => {
    const { progress, score } = recordRush(base, 9, 90);
    expect(score).toBe(rushScore(9, 90));
    expect(progress).toEqual({ rushRuns: 3, rushBest: 9, rushBestScore: Math.max(700, score), other: 'kept' });
  });

  it('never lowers a best', () => {
    const { progress, score } = recordRush(base, 1, 170);
    expect(score).toBe(rushScore(1, 170));
    expect(progress.rushBest).toBe(6);
    expect(progress.rushBestScore).toBe(700);
    expect(progress.rushRuns).toBe(3);
  });

  it('scores an empty run as 0', () => {
    expect(recordRush(base, 0, 180).score).toBe(0);
  });
});
