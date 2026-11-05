export type RushOutcomeKind = 'best' | 'matched' | 'over';

export interface RushOutcome {
  kind: RushOutcomeKind;
  title: string;
}

/**
 * How a finished Puzzle Rush run compares with the best score from before the run
 * started. Pass the best captured at run start: the saved best is updated as soon as
 * the run ends, so comparing against it would never report a new best.
 */
export function rushOutcome(prevBest: number, score: number): RushOutcome {
  if (score > 0 && score > prevBest) return { kind: 'best', title: 'New personal best!' };
  if (score > 0 && score === prevBest) return { kind: 'matched', title: 'Matched your best' };
  return { kind: 'over', title: 'Run over' };
}
