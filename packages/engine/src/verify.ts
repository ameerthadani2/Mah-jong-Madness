/**
 * Server-side checking of puzzle answers: the rules the app applies on the device, in one place
 * the game server can run too. The server regenerates a puzzle from the same inputs the app used
 * (the daily puzzle's local date key, a Puzzle Rush run's seed and index), judges the answer with
 * the same accepted sets, and moves the rating exactly as the app does. Nothing here trusts a
 * client's own "correct".
 *
 * The app keeps its own copies of these rules (apps/mobile/src/logic/puzzle.ts `checkPuzzleAnswer`
 * and `puzzleDifficultyOf`, rush.ts `rushDifficulty` and `rushPuzzleAt`, rating.ts `rateAnswer`,
 * PuzzleScreens.tsx `RUSH_SECONDS` and `RUSH_STRIKES`); test/verify.test.ts pins both to the same
 * results, and the app can switch to these exports.
 */
import { NUM_PLAY_KINDS, type Kind } from './tiles';
import {
  checkClaimAnswer,
  checkDefenceAnswer,
  checkDiscardAnswer,
  checkValueAnswer,
  checkWaitsAnswer,
  dailyPuzzle,
  PUZZLE_TYPES,
  rushPuzzle,
  type AnyPuzzle,
  type DiscardPuzzle,
  type PuzzleDifficulty,
  type PuzzleType,
} from './puzzles';
import { DEFAULT_PUZZLE_RATING, MIN_PUZZLE_RATING, puzzleRatingFor, updateRating } from './rating';

/** A stored rating above this is treated as damage (the hardest puzzle plays at 1550); a rating never rises past it. */
export const MAX_PUZZLE_RATING = 4000;
/** A Puzzle Rush run lasts this many seconds. */
export const RUSH_SECONDS = 180;
/** A Puzzle Rush run ends at this many wrong answers. */
export const RUSH_STRIKES = 3;

/**
 * An answer as it travels: a tile kind (discard, defence and value puzzles), a set of tile kinds
 * (waits) or a claim option id (claim: 'pass', 'hu', 'pong', 'kong' or 'chi:<kind>-<kind>').
 */
export type PuzzleAnswerInput = Kind | readonly Kind[] | string;

const isKind = (v: unknown): v is Kind => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < NUM_PLAY_KINDS;
const CLAIM_ID = /^(pass|hu|pong|kong|chi:\d{1,2}-\d{1,2})$/;

/**
 * Whether `v` has one of the answer shapes at all: a playable tile kind, a list of at most 34
 * distinct playable kinds, or a claim option id. Anything else cannot be judged (a server refuses
 * it as malformed); a well-formed answer of another theme's shape is simply wrong.
 */
export function isPuzzleAnswerInput(v: unknown): v is PuzzleAnswerInput {
  if (isKind(v)) return true;
  if (Array.isArray(v)) return v.length <= NUM_PLAY_KINDS && v.every(isKind) && new Set(v).size === v.length;
  return typeof v === 'string' && CLAIM_ID.test(v);
}

/** Judges an answer with the theme's own checker, as the app does; an answer of the wrong shape is wrong. */
export function judgePuzzleAnswer(p: AnyPuzzle, answer: PuzzleAnswerInput): boolean {
  switch (p.type) {
    case 'discard':
      return typeof answer === 'number' && checkDiscardAnswer(p, answer);
    case 'waits':
      return Array.isArray(answer) && checkWaitsAnswer(p, [...(answer as readonly Kind[])]);
    case 'defence':
      return typeof answer === 'number' && checkDefenceAnswer(p, answer);
    case 'claim':
      return typeof answer === 'string' && checkClaimAnswer(p, answer);
    case 'value':
      return typeof answer === 'number' && checkValueAnswer(p, answer);
  }
}

/** The puzzle's difficulty: its own field when it has one, else `fallback` (discard and waits puzzles carry none). */
export function puzzleDifficulty(p: AnyPuzzle, fallback: PuzzleDifficulty): PuzzleDifficulty {
  return 'difficulty' in p ? p.difficulty : fallback;
}

/**
 * The player's rating after one answer, exactly as the app applies it: a missing or damaged
 * rating (not a number from 100 to 4000) counts as the default, the stored value is rounded,
 * the Elo step runs against the puzzle's own rating and the result never passes 4000.
 */
export function ratePuzzleAnswer(before: number | null | undefined, type: PuzzleType, difficulty: PuzzleDifficulty, solved: boolean): { rating: number; delta: number } {
  const start = typeof before === 'number' && Number.isFinite(before) && before >= MIN_PUZZLE_RATING && before <= MAX_PUZZLE_RATING ? Math.round(before) : DEFAULT_PUZZLE_RATING;
  const rating = Math.min(MAX_PUZZLE_RATING, updateRating(start, puzzleRatingFor(type, difficulty), solved));
  return { rating, delta: rating - start };
}

// ---------------------------------------------------------------------------------------------
// The daily puzzle

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The date a daily puzzle key (`YYYY-MM-DD`, the player's local calendar date) stands for, as the
 * UTC midnight the app seeds the puzzle from; null for a key that is not a real date.
 */
export function dateOfDailyKey(key: unknown): Date | null {
  if (typeof key !== 'string') return null;
  const m = DATE_KEY.exec(key);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** The `YYYY-MM-DD` key of a moment's UTC calendar date. */
export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The daily puzzle the app shows on the local date `key` (null for a key that is not a date). */
export function dailyPuzzleForKey(key: string): DiscardPuzzle | null {
  const date = dateOfDailyKey(key);
  return date ? dailyPuzzle(date) : null;
}

/** The daily puzzle's difficulty for its (UTC-seeded) date, as `dailyPuzzle` picks it: weekends 3, even weekdays 2, odd 1. */
export function dailyPuzzleDifficulty(date: Date): PuzzleDifficulty {
  const day = date.getUTCDay();
  return day === 0 || day === 6 ? 3 : day % 2 === 0 ? 2 : 1;
}

// ---------------------------------------------------------------------------------------------
// Puzzle Rush

/** Difficulty of the `index`-th puzzle of a run (as the engine ramps it): 1 for the first five, 2 up to the 15th, then 3. */
export function rushDifficultyAt(index: number): PuzzleDifficulty {
  return index < 5 ? 1 : index < 15 ? 2 : 3;
}

/** The `index`-th puzzle of a run as the app's Rush plays it: all five themes in rotation, seeded by the run. */
export function rushRunPuzzle(runSeed: string, index: number): AnyPuzzle {
  return rushPuzzle(runSeed, index, PUZZLE_TYPES);
}

/** One judged answer of a run. */
export interface RushVerdict {
  index: number;
  type: PuzzleType;
  difficulty: PuzzleDifficulty;
  correct: boolean;
}

/** The verdict on the `index`-th answer of a run. */
export function judgeRushAnswer(runSeed: string, index: number, answer: PuzzleAnswerInput): RushVerdict {
  const p = rushRunPuzzle(runSeed, index);
  return { index, type: p.type, difficulty: puzzleDifficulty(p, rushDifficultyAt(index)), correct: judgePuzzleAnswer(p, answer) };
}

/**
 * Judges a run's answers in order with the app's rule: every answer counts until the third
 * wrong one, which ends the run (answers after it are not judged).
 */
export function judgeRushRun(runSeed: string, answers: readonly PuzzleAnswerInput[]): { verdicts: RushVerdict[]; solved: number; wrong: number } {
  const verdicts: RushVerdict[] = [];
  let wrong = 0;
  for (let i = 0; i < answers.length && wrong < RUSH_STRIKES; i++) {
    const v = judgeRushAnswer(runSeed, i, answers[i]);
    verdicts.push(v);
    if (!v.correct) wrong++;
  }
  return { verdicts, solved: verdicts.length - wrong, wrong };
}
