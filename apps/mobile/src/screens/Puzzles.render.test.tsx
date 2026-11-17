import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PuzzleRushScreen } from './PuzzleScreens';
import { DrillScreen } from './DrillScreen';
import { discardPuzzle, type DiscardPuzzle } from '@mjm/engine';
import { rushPuzzleAt } from '../logic/rush';
import { tileName } from '../logic/puzzle';
import { FakeProviders } from '../test/providers';
import { DEFAULT_PROGRESS, type Progress } from '../storage';
import { canUse, consume, EMPTY_WALLET, type Wallet } from '../monetisation/wallet';
import type { AppState } from '../app-state';

/**
 * Puzzle Rush offline (no server session: the run is seeded on the device and unranked). The run's seed is
 * `rush-` and four random bytes; the test fixes those bytes so the first puzzle is one answered by a single tap.
 */
const hex = (b: number) => b.toString(16).padStart(2, '0').repeat(4);
const BYTE = Array.from({ length: 256 }, (_, b) => b).find((b) => rushPuzzleAt(`rush-${hex(b)}`, 0).type === 'discard')!;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => buf.fill(BYTE)) as never);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function renderRush(app: Partial<AppState> = {}) {
  const calls = { back: jest.fn(), go: jest.fn(), setWallet: jest.fn<(w: Wallet) => void>(), setProgress: jest.fn<(p: Progress | ((p: Progress) => Progress)) => void>() };
  await render(
    <FakeProviders app={{ ...calls, screen: { name: 'rush' }, ...app }}>
      <PuzzleRushScreen />
    </FakeProviders>,
  );
  await act(async () => undefined);
  return calls;
}

/** The tap targets of a discard puzzle's hand, by the names the screen gives its tiles. */
// (The screen names tiles in the player's language, English here: src/components/locale.test.ts keeps a fixed locale
// out of the UI's own tileName calls.)
const PLAYER_LOCALE = 'en' as const;
const handButtons = (p: DiscardPuzzle) => p.hand.map((k) => screen.getAllByRole('button', { name: tileName(k, PLAYER_LOCALE) })[0]);

/** Answer the puzzle on screen with its first tile (right or wrong, the run has started). */
async function answerOnce() {
  await fireEvent.press(handButtons(rushPuzzleAt(`rush-${hex(BYTE)}`, 0) as DiscardPuzzle)[0]);
}

describe('Puzzle Rush', () => {
  it('opening it and backing out at once costs nothing', async () => {
    expect(canUse(EMPTY_WALLET, 'rush').ok).toBe(true);
    const calls = await renderRush();
    expect(screen.getByText(/^Puzzle 1 · /)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(calls.back).toHaveBeenCalled();
    expect(calls.setWallet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rush-leave-sheet')).toBeNull();
  });

  it('spends the free run at the first answer, then asks before leaving and records the run it spent', async () => {
    const calls = await renderRush();
    await answerOnce();
    expect(calls.setWallet).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(calls.back).not.toHaveBeenCalled();
    expect(screen.getByText('End this run?')).toBeOnTheScreen();
    const runs = calls.setProgress.mock.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: 'End run' }));
    expect(calls.back).toHaveBeenCalled();
    // The run is recorded once, as today's run.
    const recordRun = calls.setProgress.mock.calls.slice(runs).map(([f]) => (typeof f === 'function' ? f(DEFAULT_PROGRESS) : f));
    expect(recordRun.some((p) => p.rushRuns === DEFAULT_PROGRESS.rushRuns + 1)).toBe(true);
  });

  it('"Keep going" closes the question and the run goes on', async () => {
    const calls = await renderRush();
    await answerOnce();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.press(screen.getByText('Keep going'));
    expect(screen.queryByText('End this run?')).toBeNull();
    expect(calls.back).not.toHaveBeenCalled();
  });

  it('counts its three minutes down, and ends the run when they are gone', async () => {
    await renderRush();
    expect(screen.getByTestId('rush-clock')).toHaveProp('accessibilityLabel', 'Time left: 3 min 0 s');
    await act(async () => {
      jest.advanceTimersByTime(61_000);
    });
    expect(screen.getByTestId('rush-clock')).toHaveProp('accessibilityLabel', 'Time left: 1 min 59 s');
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    expect(screen.getByText('Time is up. Puzzles get harder the further you go.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Play again' })).toBeOnTheScreen();
  });

  it('once the free run is used, offers the Coach plans or the daily puzzle instead', async () => {
    const used = consume(EMPTY_WALLET, 'rush');
    expect(canUse(used, 'rush').ok).toBe(false);
    const calls = await renderRush({ wallet: used });
    expect(screen.getByText('Daily run used')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'See Coach plans' }));
    expect(calls.go).toHaveBeenLastCalledWith({ name: 'shop', focus: 'gold' });
    await fireEvent.press(screen.getByRole('button', { name: 'Daily puzzle instead' }));
    expect(calls.go).toHaveBeenLastCalledWith({ name: 'daily' });
  });

  it('keeps the player’s record and a tip under the puzzle', async () => {
    await renderRush();
    expect(screen.getByTestId('puzzle-foot')).toBeOnTheScreen();
  });
});

describe('a drill', () => {
  it('switching difficulty mounts a fresh, unanswered puzzle', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.25);
    const setProgress = jest.fn();
    await render(
      <FakeProviders app={{ setProgress, screen: { name: 'drill', kind: 'discard' } }}>
        <DrillScreen kind="discard" />
      </FakeProviders>,
    );
    expect(screen.getByRole('button', { name: 'Medium' })).toBeSelected();
    expect(screen.getByTestId('puzzle-foot')).toBeOnTheScreen();
    // The run id comes from Math.random (0.25 is "9" in base 36); the seed names the difficulty.
    const medium = discardPuzzle('discard-9-d2-0', 2);
    const hard = discardPuzzle('discard-9-d3-0', 3);
    await fireEvent.press(handButtons(medium)[0]);
    expect(setProgress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('puzzle-answer')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Hard' }));
    expect(screen.getByRole('button', { name: 'Hard' })).toBeSelected();
    // A fresh puzzle, nothing picked: no verdict is shown, and a tap answers it.
    expect(screen.queryByTestId('puzzle-answer')).toBeNull();
    await fireEvent.press(handButtons(hard)[0]);
    expect(setProgress).toHaveBeenCalledTimes(2);
  });
});
