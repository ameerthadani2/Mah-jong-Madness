import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { secondsLeft } from '../../game/useTable';
import { clockNoticeMessage, clockUrgent, nextClockNotice, timerFraction, turnCountdown, type ClockNotice, type TurnClock } from './turnClock';
import { en, zhTW } from '../../i18n/locales';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('turn clock', () => {
  it('counts whole seconds down to zero and never below', () => {
    expect(secondsLeft(null, 0)).toBeNull();
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
  });

  it('gives the seat ring its fraction of the period and turns red in the bank or the last five seconds', () => {
    const turn: TurnClock = { deadline: 1, total: 15, bank: false };
    expect(timerFraction(15, turn)).toBe(1);
    expect(timerFraction(null, turn)).toBeNull();
    expect(clockUrgent(6, turn)).toBe(false);
    expect(clockUrgent(5, turn)).toBe(true);
    expect(clockUrgent(30, { ...turn, bank: true })).toBe(true);
  });

  it('keeps the per-second countdown out of the table screen, so only the clock leaves re-render', () => {
    const screen = read('../../screens/TableScreen.tsx');
    expect(screen).not.toMatch(/useCountdown\(|useTurnCountdown\(/);
    expect(screen).not.toMatch(/useClockTick\(/);
    // My own move is counted by the table client's own clock.
    expect(screen).toMatch(/myMove \? \{ own: session\.client \}/);
    // The leaves that do count down.
    expect(read('./ClockParts.tsx')).toMatch(/useTurnCountdown\(/);
    expect(read('../TableParts.tsx')).toMatch(/useTurnCountdown\(/);
  });
});

describe('my own clock (TurnClock.own: the table client’s own clock)', () => {
  /** A table client whose own clock ends the turn at 15 s and the bank at 44.5 s, read at `now` on its own clock. */
  const reader = (now: () => number, o: { turnEnd: number; bankEnd: number } | null = { turnEnd: 15_000, bankEnd: 44_500 }) => ({ ownClock: () => o, clockNow: now });

  it('counts the turn clock, then the bank to its end, whatever the deadline and the wall clock say', () => {
    let at = 0;
    const own: TurnClock = { deadline: 999_999_999, total: 15, bank: false, own: reader(() => at) };
    expect(turnCountdown(own, 0)).toEqual({ left: 15, bank: false, total: 15, period: 15_000 });
    at = 14_001;
    expect(turnCountdown(own, 0).left).toBe(1);
    // The turn clock is over: the bank runs, with no state from the table to say so; the ring's total is the bank.
    at = 15_000;
    expect(turnCountdown(own, 0)).toEqual({ left: 30, bank: true, total: 30, period: 44_500 });
    at = 44_000;
    expect(turnCountdown(own, 0)).toMatchObject({ left: 1, bank: true });
    at = 50_000;
    expect(turnCountdown(own, 0)).toMatchObject({ left: 0, bank: true });
  });

  it('with no bank, the turn clock alone; with nothing to read, the deadline against the wall clock', () => {
    const none: TurnClock = { deadline: 10_000, total: 4, bank: false, own: reader(() => 5_000, { turnEnd: 4_000, bankEnd: 4_000 }) };
    expect(turnCountdown(none, 0)).toMatchObject({ left: 0, bank: false });
    const blank: TurnClock = { deadline: 10_000, total: 15, bank: false, own: reader(() => 0, null) };
    expect(turnCountdown(blank, 1_000)).toEqual({ left: 9, bank: false, total: 15, period: 10_000 });
    expect(turnCountdown({ deadline: 10_000, total: 15, bank: true }, 4_000)).toEqual({ left: 6, bank: true, total: 15, period: 10_000 });
    expect(turnCountdown(null, 0)).toEqual({ left: null, bank: false, total: 1, period: null });
  });
});

describe('what a screen reader hears about the clock', () => {
  /** Run the clock down second by second and collect each new notice (what a live region would speak). */
  const spoken = (clock: TurnClock, from: number, prev: ClockNotice | null = null): { said: ClockNotice[]; last: ClockNotice | null } => {
    const said: ClockNotice[] = [];
    let notice = prev;
    for (let left = from; left >= 0; left--) {
      const next = nextClockNotice(notice, left, clock);
      if (next && next !== notice) said.push(next);
      notice = next;
    }
    return { said, last: notice };
  };

  it('says "5 seconds left" once on a move, not every second', () => {
    const turn: TurnClock = { deadline: 1_000_000, total: 15, bank: false };
    const { said } = spoken(turn, 15);
    expect(said).toEqual([{ kind: 'low', seconds: 5, deadline: 1_000_000 }]);
    expect(clockNoticeMessage(said[0])).toEqual({ key: 'table.a11y.clockLow', params: { s: 5 } });
  });

  it('says once that the time bank has started, with the seconds it started with, through all thirty of them', () => {
    const turn: TurnClock = { deadline: 1_000_000, total: 15, bank: false };
    const bank: TurnClock = { deadline: 1_030_000, total: 30, bank: true };
    const first = spoken(turn, 15);
    const second = spoken(bank, 30, first.last);
    expect(second.said).toEqual([{ kind: 'bank', seconds: 30, deadline: 1_030_000 }]);
    expect(clockNoticeMessage(second.said[0])).toEqual({ key: 'table.a11y.clockBank', params: { s: 30 } });
    // Two announcements for a whole move of 15 s and a 30 s bank, where the ticking chip made 35.
    expect(first.said.length + second.said.length).toBe(2);
  });

  it('starts afresh on the next move, and says nothing while nobody is on the clock', () => {
    const a = spoken({ deadline: 1_000_000, total: 15, bank: false }, 15);
    const b = spoken({ deadline: 2_000_000, total: 15, bank: false }, 15, a.last);
    expect(b.said).toEqual([{ kind: 'low', seconds: 5, deadline: 2_000_000 }]);
    expect(nextClockNotice(b.last, null, { deadline: null, total: 1, bank: false })).toBeNull();
    expect(nextClockNotice(null, 9, { deadline: 3_000_000, total: 15, bank: false })).toBeNull();
  });

  it('never makes a piece that follows the clock a live region: the notices have a region of their own', () => {
    // The ticking chip (named with the seconds left) not being a live region, and the notices' own polite region, are
    // rendered in src/screens/TablePlay.render.test.tsx ("shows my clock ..."). What stays here: the seat plates'
    // rings in TableParts.tsx follow the clock too, and none of them is a live region (a sweep over the file, since a
    // render shows only the seats on the clock at that moment).
    expect(read('../TableParts.tsx').match(/accessibilityLiveRegion/g) ?? []).toHaveLength(0);
  });

  it('has the sentences in both languages', () => {
    for (const locale of [en, zhTW]) {
      const a11y = (locale as { table: { a11y: Record<string, unknown> } }).table.a11y;
      for (const key of ['clockNow', 'clockBankNow', 'clockLow', 'clockBank']) expect(a11y[key], key).toMatch(/%\{s\}/);
    }
  });
});
