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
  /**
   * My own move: the table client's own clock for it (`TableClient.ownClock`), which the leaves count instead of
   * `deadline` against the wall clock. It is the clock the audit holds the table to: the turn clock, then the bank
   * (without waiting for the table to say the bank has started), on the client's own clock.
   */
  own?: OwnClockReader | null;
}

/** What the leaves read my own clock from: the table client (`ownClock`, `clockNow`). */
export interface OwnClockReader {
  ownClock(): { turnEnd: number; bankEnd: number } | null;
  clockNow(): number;
}

export const NO_CLOCK: TurnClock = { deadline: null, total: 1, bank: false };

/**
 * Where a turn clock stands: whole seconds left (null: nobody is on the clock), whether the bank runs, the seconds
 * in the period it is in (for the ring), and the period itself (its end: a new end is a new period).
 */
export interface TurnCountdown {
  left: number | null;
  bank: boolean;
  total: number;
  period: number | null;
}

/**
 * The countdown of `clock` at `wallNow` (the device's wall clock, for a deadline). My own move counts the table
 * client's own clock: the turn clock until it ends, then the bank to its end, whose length is the ring's total. With
 * no own clock to read (the client cannot place one), the deadline against the wall clock, as for another seat.
 */
export function turnCountdown(clock: TurnClock | null, wallNow: number): TurnCountdown {
  if (!clock) return { left: null, bank: false, total: 1, period: null };
  const o = clock.own ? clock.own.ownClock() : null;
  if (clock.own && o) {
    const now = clock.own.clockNow();
    if (now < o.turnEnd) return { left: Math.ceil((o.turnEnd - now) / 1000), bank: false, total: clock.total, period: o.turnEnd };
    return { left: Math.max(0, Math.ceil((o.bankEnd - now) / 1000)), bank: o.bankEnd > o.turnEnd, total: Math.max(1, Math.round((o.bankEnd - o.turnEnd) / 1000)), period: o.bankEnd };
  }
  return { left: clock.deadline === null ? null : Math.max(0, Math.ceil((clock.deadline - wallNow) / 1000)), bank: clock.bank, total: clock.total, period: clock.deadline };
}

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
