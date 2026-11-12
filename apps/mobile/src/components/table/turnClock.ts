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

/**
 * What a screen reader is told about the player's clock. The chip that shows the seconds is never a live
 * region (it changes every second, and a reader would speak each one over the tile names the player is
 * listening to). Instead two things are said, once each: that five seconds are left, and that the time
 * bank has started, with the seconds it started with. The notice keeps the seconds of the moment it was
 * made, so its text does not change while the clock runs on.
 */
export interface ClockNotice {
  kind: 'low' | 'bank';
  /** Seconds left when the notice was made. */
  seconds: number;
  /** The period it belongs to: a new deadline is a new period. */
  deadline: number;
}

/** The notice after one more tick of the clock: the same object for as long as nothing new is to be said. */
export function nextClockNotice(prev: ClockNotice | null, left: number | null, clock: TurnClock): ClockNotice | null {
  if (left === null || clock.deadline === null) return null;
  const kind = clock.bank ? 'bank' : left <= 5 ? 'low' : null;
  if (kind === null) return null;
  if (prev && prev.kind === kind && prev.deadline === clock.deadline) return prev;
  return { kind, seconds: left, deadline: clock.deadline };
}

/** The sentence for a notice (table.json). */
export function clockNoticeMessage(n: ClockNotice): { key: string; params: { s: number } } {
  return { key: n.kind === 'bank' ? 'table.a11y.clockBank' : 'table.a11y.clockLow', params: { s: n.seconds } };
}
