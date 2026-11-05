import { describe, expect, it } from 'vitest';
import { DEFAULT_PUZZLE_RATING, expected, MIN_PUZZLE_RATING, PUZZLE_TYPES, puzzleRatingFor, rushScore, updateRating } from '../src/index';

describe('puzzle rating', () => {
  it('expected score follows the Elo curve', () => {
    expect(expected(1000, 1000)).toBe(0.5);
    expect(expected(1200, 1000)).toBeCloseTo(0.759747, 5);
    expect(expected(1000, 1400)).toBeCloseTo(1 / 11, 10);
    expect(expected(1000, 1400) + expected(1400, 1000)).toBeCloseTo(1, 12);
  });

  it('updates by k × (score − expected), rounded', () => {
    expect(updateRating(1000, 1000, true)).toBe(1016);
    expect(updateRating(1000, 1000, false)).toBe(984);
    expect(updateRating(1000, 1400, true)).toBe(1029);
    expect(updateRating(1400, 1000, false)).toBe(1371);
    expect(updateRating(1000, 1000, true, 16)).toBe(1008);
    expect(updateRating(1500, 1500, true, 0)).toBe(1500);
  });

  it('never drops below the floor', () => {
    expect(updateRating(MIN_PUZZLE_RATING, 3000, false)).toBe(MIN_PUZZLE_RATING);
    expect(updateRating(110, 110, false)).toBe(MIN_PUZZLE_RATING);
  });

  it('rates puzzles by difficulty plus a theme offset', () => {
    expect(puzzleRatingFor('discard', 1)).toBe(DEFAULT_PUZZLE_RATING);
    expect(puzzleRatingFor('discard', 2)).toBe(1200);
    expect(puzzleRatingFor('discard', 3)).toBe(1400);
    expect(puzzleRatingFor('waits', 1)).toBe(1050);
    expect(puzzleRatingFor('claim', 2)).toBe(1250);
    expect(puzzleRatingFor('defence', 2)).toBe(1300);
    expect(puzzleRatingFor('value', 3)).toBe(1550);
    for (const t of PUZZLE_TYPES) expect(puzzleRatingFor(t, 1)).toBeLessThan(puzzleRatingFor(t, 2));
  });

  it('scores a rush by puzzles solved and pace', () => {
    expect(rushScore(0, 10)).toBe(0);
    expect(rushScore(10, 50)).toBe(1500);
    expect(rushScore(10, 20)).toBe(1500);
    expect(rushScore(10, 300)).toBe(1000);
    expect(rushScore(10, 900)).toBe(1000);
    expect(rushScore(4, 70)).toBe(500);
    expect(rushScore(1, 0)).toBe(150);
    expect(rushScore(3, -1)).toBe(0);
    expect(rushScore(2.5, 10)).toBe(0);
    expect(rushScore(3, Number.NaN)).toBe(0);
    expect(rushScore(3, Infinity)).toBe(0);
    // More solved in the same time never scores less.
    expect(rushScore(11, 120)).toBeGreaterThan(rushScore(10, 120));
  });
});
