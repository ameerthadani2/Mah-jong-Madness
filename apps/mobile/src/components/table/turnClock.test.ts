import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { secondsLeft } from '../../game/useTable';
import { clockNoticeMessage, clockUrgent, nextClockNotice, timerFraction, type ClockNotice, type TurnClock } from './turnClock';
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
    expect(screen).not.toMatch(/useCountdown\(/);
    expect(screen).not.toMatch(/useClockTick\(/);
    // The leaves that do count down.
    expect(read('./ClockParts.tsx')).toMatch(/useCountdown\(/);
    expect(read('../TableParts.tsx')).toMatch(/useCountdown\(/);
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

  it('never makes the ticking chip a live region: the notices have a region of their own', () => {
    const parts = read('./ClockParts.tsx');
    const chip = parts.slice(parts.indexOf('export function HudClock'), parts.indexOf('export function ClockAnnouncer'));
    expect(chip).not.toContain('accessibilityLiveRegion');
    expect(chip).toContain("accessibilityLabel={t(clock.bank ? 'table.a11y.clockBankNow' : 'table.a11y.clockNow', { s: left })}");
    const announcer = parts.slice(parts.indexOf('export function ClockAnnouncer'), parts.indexOf('export function ClockTicker'));
    expect(announcer).toContain('accessibilityLiveRegion="polite"');
    expect(announcer).toContain('useAnnounce(');
    expect(read('../../screens/TableScreen.tsx')).toContain('<ClockAnnouncer clock={clock} myMove={myMove} />');
    // No other piece that follows the clock is a live region either.
    expect(read('../TableParts.tsx').match(/accessibilityLiveRegion/g) ?? []).toHaveLength(0);
  });

  it('has the sentences in both languages', () => {
    for (const locale of [en, zhTW]) {
      const a11y = (locale as { table: { a11y: Record<string, unknown> } }).table.a11y;
      for (const key of ['clockNow', 'clockBankNow', 'clockLow', 'clockBank']) expect(a11y[key], key).toMatch(/%\{s\}/);
    }
  });
});
