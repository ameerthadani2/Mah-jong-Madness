/**
 * Feedback rules for the table, pure so they are tested: which haptic a table event earns, when a turn
 * timeout discarded for the player, and which score a seat plate shows while the result is held back.
 */

export type Haptic = 'claim' | 'win' | 'dealin';

/** A claim (吃 碰 槓) or a 胡 called by the player buzzes; other seats' calls do not. */
export function callHaptic(events: ReadonlyArray<{ type: string; seat?: number; call?: string }>, mySeat: number): Haptic | null {
  for (const e of events) if (e.type === 'call' && e.seat === mySeat) return e.call === 'hu' || e.call === 'selfdraw' ? 'win' : 'claim';
  return null;
}

/** The end of a hand: the player won, or dealt in to someone's 胡. */
export function resultHaptic(result: { type: 'win' | 'draw'; wins: ReadonlyArray<{ seat: number; fromSeat?: number; selfDrawn?: boolean }> } | null | undefined, mySeat: number): Haptic | null {
  if (!result || result.type !== 'win') return null;
  if (result.wins.some((w) => w.seat === mySeat)) return 'win';
  if (result.wins.some((w) => !w.selfDrawn && w.fromSeat === mySeat)) return 'dealin';
  return null;
}

export interface PondCount {
  hand: number;
  count: number;
}

/**
 * The player's pond grew by one tile in the same hand without them sending a discard: the turn clock ran out
 * and the table discarded for them.
 */
export function autoDiscarded(prev: PondCount | null, next: PondCount, sentByMe: boolean): boolean {
  return !!prev && prev.hand === next.hand && next.count === prev.count + 1 && !sentByMe;
}

/**
 * A seat plate's score: during the hold after a hand (call-out, winner's reveal) it still shows the score from
 * before the hand, and changes only once the result sheet has rolled the deltas up.
 */
export function plateScore(score: number, delta: number | undefined, holding: boolean): number {
  return holding && delta !== undefined ? score - delta : score;
}
