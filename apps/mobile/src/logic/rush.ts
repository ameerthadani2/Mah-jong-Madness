import { PUZZLE_TYPES, rushDifficultyAt, rushRunPuzzle, type AnyPuzzle, type PuzzleDifficulty } from '@mjm/engine';
import { nextFreeRushAt } from '../monetisation/wallet';
import type { TextKey } from './puzzle';

export type RushOutcomeKind = 'best' | 'matched' | 'over';

/** How a run ended, as a kind: the screen shows `puzzles.rush.outcome.<kind>`. */
export interface RushOutcome {
  kind: RushOutcomeKind;
}

/**
 * How a finished Puzzle Rush run compares with the best score from before the run
 * started. Pass the best captured at run start: the saved best is updated as soon as
 * the run ends, so comparing against it would never report a new best.
 */
export function rushOutcome(prevBest: number, score: number): RushOutcome {
  if (score > 0 && score > prevBest) return { kind: 'best' };
  if (score > 0 && score === prevBest) return { kind: 'matched' };
  return { kind: 'over' };
}

/** Puzzle Rush rotates every theme. */
export const RUSH_TYPES = PUZZLE_TYPES;

/** Difficulty of the `index`-th puzzle of a run (as the engine ramps it): 1 for the first five, 2 up to the 15th, then 3. The engine's `rushDifficultyAt`, as the server applies it. */
export const rushDifficulty: (index: number) => PuzzleDifficulty = rushDifficultyAt;

/** The `index`-th puzzle of a run: all five themes in rotation, seeded by the run. The engine's `rushRunPuzzle`, which the server regenerates to judge a run. */
export const rushPuzzleAt: (runSeed: string, index: number) => AnyPuzzle = rushRunPuzzle;

/** A run's length in seconds and the wrong answers that end it: the engine's, as the server scores a run. */
export { RUSH_SECONDS, RUSH_STRIKES } from '@mjm/engine';

/**
 * When the next free run comes, as the Rush screen says it once the free run is used: the next
 * midnight UTC (when the server's meter refills), in the player's local time, today or tomorrow.
 */
export function nextFreeRushText(now: Date): TextKey {
  const at = nextFreeRushAt(now);
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return { key: sameDay ? 'puzzles.rush.nextFreeToday' : 'puzzles.rush.nextFreeTomorrow', params: { time } };
}
