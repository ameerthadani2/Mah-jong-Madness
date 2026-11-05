/**
 * The player's puzzle rating as the app stores it. The Elo maths lives in the engine
 * (`updateRating`, `puzzleRatingFor`, `rushScore`); this module applies it to saved
 * progress, keeps a short history for the trend and repairs old or damaged saves.
 * Pure TypeScript: no React Native, so it is unit-tested directly.
 */
import { DEFAULT_PUZZLE_RATING, MIN_PUZZLE_RATING, PUZZLE_TYPES, puzzleRatingFor, rushScore, updateRating, type PuzzleDifficulty, type PuzzleType } from '@mjm/engine';

export { DEFAULT_PUZZLE_RATING, MIN_PUZZLE_RATING } from '@mjm/engine';

/** How many answered puzzles the history keeps (newest last). */
export const RATING_HISTORY_MAX = 30;
/** A stored rating above this is treated as damage (the hardest puzzle plays at 1550). */
export const MAX_PUZZLE_RATING = 4000;

/** One answered puzzle: the rating after it and how much it moved. */
export interface RatingEntry {
  rating: number;
  delta: number;
  type: PuzzleType;
  difficulty: PuzzleDifficulty;
  solved: boolean;
  /** Epoch milliseconds. */
  at: number;
}

/** The fields of saved progress this module owns. */
export interface RatingState {
  puzzleRating: number;
  ratingHistory: RatingEntry[];
}

const isDifficulty = (d: unknown): d is PuzzleDifficulty => d === 1 || d === 2 || d === 3;
const isType = (t: unknown): t is PuzzleType => (PUZZLE_TYPES as readonly unknown[]).includes(t);
const isRating = (r: unknown): r is number => typeof r === 'number' && Number.isFinite(r) && r >= MIN_PUZZLE_RATING && r <= MAX_PUZZLE_RATING;

/**
 * Progress after answering one puzzle: the rating moves by `updateRating` against the
 * puzzle's own rating, and the answer joins the (capped) history. Deterministic: the
 * same state and answer always give the same result.
 */
export function rateAnswer<T extends RatingState>(state: T, type: PuzzleType, difficulty: PuzzleDifficulty, solved: boolean, at: number): T {
  const before = isRating(state.puzzleRating) ? Math.round(state.puzzleRating) : DEFAULT_PUZZLE_RATING;
  const rating = Math.min(MAX_PUZZLE_RATING, updateRating(before, puzzleRatingFor(type, difficulty), solved));
  const entry: RatingEntry = { rating, delta: rating - before, type, difficulty, solved, at };
  const history = [...(Array.isArray(state.ratingHistory) ? state.ratingHistory : []), entry].slice(-RATING_HISTORY_MAX);
  return { ...state, puzzleRating: rating, ratingHistory: history };
}

/** Net change over the last `n` answers (0 with no history): the chip's trend. */
export function ratingTrend(history: readonly RatingEntry[], n = 10): number {
  return history.slice(-n).reduce((sum, e) => sum + e.delta, 0);
}

/** A rating change with its sign, as the pill shows it: "+16", "-9", "0". */
export function formatRatingChange(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** The movement of the most recent answer, or null before the first. */
export function lastRatingChange(history: readonly RatingEntry[]): number | null {
  return history.length > 0 ? history[history.length - 1].delta : null;
}

function cleanEntry(e: unknown): RatingEntry | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as Partial<RatingEntry>;
  if (!isRating(r.rating) || typeof r.delta !== 'number' || !Number.isFinite(r.delta) || !isType(r.type) || !isDifficulty(r.difficulty) || typeof r.solved !== 'boolean') return null;
  return { rating: Math.round(r.rating), delta: Math.round(r.delta), type: r.type, difficulty: r.difficulty, solved: r.solved, at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 };
}

/** The fields this module adds to saved progress. */
export type PuzzleProgressFields = RatingState & Pick<RushRecord, 'rushBestScore'>;

/**
 * Saved progress from before the rating existed (or damaged by hand) reads with the
 * defaults: a missing or out-of-range rating is 1000, a missing history is empty,
 * history entries that do not parse are dropped and a missing best Rush score is 0.
 */
export function migratePuzzleProgress<T extends object>(p: T): Omit<T, keyof PuzzleProgressFields> & PuzzleProgressFields {
  const raw = p as Partial<Record<keyof PuzzleProgressFields, unknown>>;
  const puzzleRating = isRating(raw.puzzleRating) ? Math.round(raw.puzzleRating) : DEFAULT_PUZZLE_RATING;
  const ratingHistory = Array.isArray(raw.ratingHistory) ? raw.ratingHistory.map(cleanEntry).filter((e): e is RatingEntry => e !== null).slice(-RATING_HISTORY_MAX) : [];
  const rushBestScore = typeof raw.rushBestScore === 'number' && Number.isFinite(raw.rushBestScore) && raw.rushBestScore > 0 ? Math.round(raw.rushBestScore) : 0;
  return { ...p, puzzleRating, ratingHistory, rushBestScore };
}

/** The fields of saved progress a finished Puzzle Rush run updates. */
export interface RushRecord {
  rushRuns: number;
  /** Most puzzles solved in one run. */
  rushBest: number;
  /** Highest `rushScore` of one run. */
  rushBestScore: number;
}

/** Progress after a finished run of `solved` puzzles in `seconds` of play, plus the run's score. */
export function recordRush<T extends RushRecord>(p: T, solved: number, seconds: number): { progress: T; score: number } {
  const score = rushScore(solved, seconds);
  const best = typeof p.rushBestScore === 'number' && Number.isFinite(p.rushBestScore) ? p.rushBestScore : 0;
  return { progress: { ...p, rushRuns: p.rushRuns + 1, rushBest: Math.max(p.rushBest, solved), rushBestScore: Math.max(best, score) }, score };
}
