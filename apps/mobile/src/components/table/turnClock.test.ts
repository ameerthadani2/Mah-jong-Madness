import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { secondsLeft } from '../../game/useTable';
import { clockUrgent, timerFraction, type TurnClock } from './turnClock';

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
