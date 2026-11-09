/**
 * The turn clock as data the table passes down once per turn (not once per second): the deadline, the length
 * of the period it ends (the turn, or the time bank) and whether it is the time bank. The leaf components in
 * ./ClockParts.tsx and TableParts' seat timer count it down themselves.
 */
export interface TurnClock {
  /** ms epoch the current period ends, or null when nobody is on the clock. */
  deadline: number | null;
  /** Seconds in the current period (the turn, or the time bank), for the ring's fraction. */
  total: number;
  /** The player is using their time bank. */
  bank: boolean;
}

export const NO_CLOCK: TurnClock = { deadline: null, total: 1, bank: false };

/** The timer ring's fraction (0..1) for `left` seconds of the period. */
export function timerFraction(left: number | null, clock: TurnClock): number | null {
  return left === null ? null : left / Math.max(1, clock.total);
}

/** Red clock: in the time bank, or five seconds or fewer left. */
export function clockUrgent(left: number | null, clock: TurnClock): boolean {
  return clock.bank || (left !== null && left <= 5);
}
