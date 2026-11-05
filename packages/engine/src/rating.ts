/**
 * Elo-style puzzle rating. A player and every puzzle carry a rating; solving a
 * puzzle is a win against it, missing one a loss. Pure functions only, so the
 * app can store the number wherever it likes and tests can pin exact values.
 */
import type { PuzzleDifficulty, PuzzleType } from './puzzles';

/** Where a new player starts (the same as a difficulty-1 discard puzzle). */
export const DEFAULT_PUZZLE_RATING = 1000;
/** Ratings never fall below this floor, so a bad run cannot bury a beginner. */
export const MIN_PUZZLE_RATING = 100;

/** Base puzzle rating per difficulty. */
export const PUZZLE_DIFFICULTY_RATING: Record<PuzzleDifficulty, number> = { 1: 1000, 2: 1200, 3: 1400 };

/**
 * Offsets per theme, from how much reading each needs on top of tile efficiency:
 * waits and claims add one idea, defence needs the table, value needs 台 counting too.
 */
export const PUZZLE_TYPE_OFFSET: Record<PuzzleType, number> = { discard: 0, waits: 50, claim: 50, defence: 100, value: 150 };

/** Expected score (0..1) of a rated `ratingA` against `ratingB`: 1 / (1 + 10^((B − A) / 400)). */
export function expected(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * The player's new rating after one puzzle: `player + k × (score − expected)`, where the score
 * is 1 for solved and 0 for missed. Rounded to a whole number and kept at or above
 * `MIN_PUZZLE_RATING`.
 */
export function updateRating(player: number, puzzleRating: number, solved: boolean, k = 32): number {
  const next = player + k * ((solved ? 1 : 0) - expected(player, puzzleRating));
  return Math.max(MIN_PUZZLE_RATING, Math.round(next));
}

/** The rating a puzzle of this theme and difficulty plays at. */
export function puzzleRatingFor(type: PuzzleType, difficulty: PuzzleDifficulty): number {
  return PUZZLE_DIFFICULTY_RATING[difficulty] + PUZZLE_TYPE_OFFSET[type];
}

/** Points per solved puzzle in a rush. */
export const RUSH_POINTS_PER_PUZZLE = 100;
/** Largest pace bonus per solved puzzle. */
export const RUSH_MAX_PACE_BONUS = 50;

/**
 * Puzzle Rush score for `solved` puzzles in `seconds` of total play: 100 per puzzle plus a pace
 * bonus per puzzle that is 50 when the average is 5 seconds or less, falls linearly, and is 0
 * from a 30-second average. Invalid input (negative, fractional solved, not finite) scores 0.
 */
export function rushScore(solved: number, seconds: number): number {
  if (!Number.isInteger(solved) || solved <= 0 || !Number.isFinite(seconds) || seconds < 0) return 0;
  const average = seconds / solved;
  const pace = Math.min(1, Math.max(0, (30 - average) / 25));
  return solved * (RUSH_POINTS_PER_PUZZLE + Math.round(RUSH_MAX_PACE_BONUS * pace));
}
