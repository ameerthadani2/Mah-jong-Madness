/**
 * My own clock at the table: the HUD chip, the clock-tick sound and the screen reader's notices count the table
 * client's own clock (`TableClient.ownClock`) for my move. When the turn clock ends the bank runs on, with no state
 * from the table to say it has started (a server that holds that state back no longer leaves the player at 0 s), and
 * a wrong wall clock on the phone does not move it.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { ClockAnnouncer, ClockTicker, HudClock } from './ClockParts';
import type { OwnClockReader, TurnClock } from './turnClock';

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

/**
 * A table client whose own clock reads `at` (moved on with the fake timers): the turn clock ends 15 s in, the bank
 * 29.5 s after that. The deadline the last state gave is the turn's end, and the wall clock is a minute off.
 */
function table() {
  jest.useFakeTimers();
  const t = { at: 100_000 };
  const own: OwnClockReader = { ownClock: () => ({ turnEnd: 115_000, bankEnd: 144_500 }), clockNow: () => t.at };
  const clock: TurnClock = { deadline: Date.now() - 60_000 + 15_000, total: 15, bank: false, own };
  const pass = async (ms: number) => {
    for (let left = ms; left > 0; left -= 250) {
      t.at += 250;
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
    }
  };
  return { clock, pass };
}

describe('my own clock at the table (TurnClock.own)', () => {
  it('the HUD chip counts the turn clock, then shows the bank once the turn clock ends, with no new state from the table', async () => {
    const { clock, pass } = table();
    await render(<HudClock clock={clock} />);
    expect(screen.getByTestId('hud-clock')).toHaveTextContent('15s');
    await pass(10_000);
    expect(screen.getByTestId('hud-clock')).toHaveTextContent('5s');
    await pass(5_000);
    // 15 s in: the bank, 29.5 s of it, though the clock handed down still says the turn clock (bank: false).
    expect(screen.getByTestId('hud-clock')).toHaveTextContent('bank 30s');
    expect(screen.getByLabelText('Your time bank: 30 seconds left')).toBeTruthy();
    await pass(10_000);
    expect(screen.getByTestId('hud-clock')).toHaveTextContent('bank 20s');
  });

  it('the tick sounds in the last five seconds of the turn clock and again in the last five of the bank', async () => {
    const { clock, pass } = table();
    const tick = jest.fn();
    await render(<ClockTicker clock={clock} myMove onTick={tick} />);
    await pass(9_000);
    expect(tick).not.toHaveBeenCalled();
    await pass(6_000);
    expect(tick).toHaveBeenCalledTimes(5);
    await pass(20_000);
    expect(tick).toHaveBeenCalledTimes(5);
    await pass(9_500);
    expect(tick).toHaveBeenCalledTimes(10);
  });

  it('a screen reader is told once that the bank has started, when the turn clock ends', async () => {
    const { clock, pass } = table();
    await render(<ClockAnnouncer clock={clock} myMove />);
    await pass(16_000);
    expect(screen.getByTestId('clock-notice')).toHaveTextContent('Your time bank has started: 30 seconds');
  });
});
