import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { dailyPuzzle, type Kind } from '@mjm/engine';
import { DailyPuzzleScreen } from './PuzzleScreens';
import { tileName } from '../logic/puzzle';
import { localDayAsUtc } from '../logic/dates';
import { puzzlesApi } from '../api/puzzles';
import { FakeProviders, sessionClient } from '../test/providers';
import { DEFAULT_PROGRESS, todayKey, type Progress } from '../storage';
import type { AppState } from '../app-state';

/**
 * The daily puzzle, on a fixed day: answered offline (kept on the device, unranked), already played today, and with a
 * session, where opening it starts the server's clock and the answer is judged and timed there (the puzzle API is
 * replaced by stand-ins that answer as the server does).
 */
const DAY = new Date(2026, 10, 17, 9, 0, 0);
const TODAY = todayKey(DAY);
const puzzle = dailyPuzzle(localDayAsUtc(DAY));

beforeEach(() => {
  jest.useFakeTimers({ now: DAY });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function renderDaily(app: Partial<AppState> = {}, signedIn = false) {
  let progress: Progress = app.progress ?? DEFAULT_PROGRESS;
  const calls = {
    back: jest.fn(),
    go: jest.fn(),
    setProgress: jest.fn((p: Progress | ((p: Progress) => Progress)) => {
      progress = typeof p === 'function' ? p(progress) : p;
    }),
  };
  await render(
    <FakeProviders app={{ ...calls, screen: { name: 'daily' }, ...app }} auth={signedIn ? { status: 'guest', client: sessionClient('u-1'), user: { id: 'u-1' } as never } : {}}>
      <DailyPuzzleScreen />
    </FakeProviders>,
  );
  await act(async () => undefined);
  return { ...calls, progress: () => progress };
}

/** The first on-screen button for a tile of the hand. */
const tile = (k: Kind) => screen.getAllByRole('button', { name: tileName(k, 'en') })[0];
const wrong = puzzle.hand.find((k) => !puzzle.answers.includes(k))!;

describe('the daily puzzle', () => {
  it("shows today's puzzle with the streak, the player's record and a tip", async () => {
    await renderDaily({ progress: { ...DEFAULT_PROGRESS, drillsPlayed: 4, drillsCorrect: 3 } });
    expect(screen.getByText('Daily puzzle')).toBeOnTheScreen();
    expect(screen.getByText('0-day streak')).toBeOnTheScreen();
    expect(tile(puzzle.best)).toBeOnTheScreen();
    const foot = screen.getByTestId('puzzle-foot');
    expect(within(foot).getByLabelText('Drill accuracy: 75%')).toBeOnTheScreen();
    expect(within(foot).getByText(/^Tip: /)).toBeOnTheScreen();
    expect(within(foot).getByText(/Everyone gets the same puzzle on the same date/)).toBeOnTheScreen();
  });

  it('offline, a right answer is recorded for today, counts toward the streak and the drills, and says it is not ranked', async () => {
    const calls = await renderDaily();
    await fireEvent.press(tile(puzzle.best));
    await act(async () => undefined);
    expect(calls.progress().dailySolved[TODAY]).toBe('correct');
    expect(calls.progress()).toMatchObject({ drillsPlayed: 1, drillsCorrect: 1 });
    expect(screen.getByTestId('puzzle-answer')).toBeOnTheScreen();
    expect(within(screen.getByTestId('daily-server-note')).getByText(/Not ranked: the game server cannot be reached/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('daily-leaderboard'));
    expect(calls.go).toHaveBeenCalledWith({ name: 'leaderboards', board: 'daily' });
  });

  it('a wrong answer is recorded as attempted, and only the first answer of the day counts', async () => {
    const calls = await renderDaily();
    await fireEvent.press(tile(wrong));
    await act(async () => undefined);
    expect(calls.progress().dailySolved[TODAY]).toBe('wrong');
    expect(calls.progress()).toMatchObject({ drillsPlayed: 1, drillsCorrect: 0 });
  });

  it('once played today, offers Puzzle Rush and the leaderboard in place of the puzzle', async () => {
    const calls = await renderDaily({ progress: { ...DEFAULT_PROGRESS, dailySolved: { [TODAY]: 'correct' }, dailyStreak: 3, dailyLastDate: TODAY } });
    expect(screen.getByText('Already played today')).toBeOnTheScreen();
    expect(screen.getByText('Solved today')).toBeOnTheScreen();
    expect(screen.getByText('3-day streak')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: tileName(puzzle.best, 'en') })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Puzzle Rush' }));
    expect(calls.go).toHaveBeenCalledWith({ name: 'rush' });
    await fireEvent.press(screen.getByTestId('daily-leaderboard'));
    expect(calls.go).toHaveBeenCalledWith({ name: 'leaderboards', board: 'daily' });
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(calls.back).toHaveBeenCalled();
  });

  it('with a session, opening it starts the server clock and the answer is ranked and timed by the server', async () => {
    const start = jest.spyOn(puzzlesApi, 'startDaily').mockResolvedValue({ attemptId: 'att-1', startedAt: DAY.getTime() } as never);
    const finish = jest.spyOn(puzzlesApi, 'finishDaily').mockResolvedValue({ ranked: true, correct: true, seconds: 12, rating: 1520 } as never);
    await renderDaily({}, true);
    expect(start).toHaveBeenCalledWith(expect.anything(), TODAY);
    await fireEvent.press(tile(puzzle.best));
    await act(async () => undefined);
    expect(finish).toHaveBeenCalledWith(expect.anything(), 'att-1', expect.anything());
    expect(screen.getByText('Ranked')).toBeOnTheScreen();
    expect(screen.getByText('Time 12 s')).toBeOnTheScreen();
    expect(screen.queryByTestId('daily-server-note')).toBeNull();
  });

  it("with a session, shows the server's verdict when it differs from the device's", async () => {
    jest.spyOn(puzzlesApi, 'startDaily').mockResolvedValue({ attemptId: 'att-2', startedAt: DAY.getTime() } as never);
    jest.spyOn(puzzlesApi, 'finishDaily').mockResolvedValue({ ranked: true, correct: false, seconds: 9, rating: 1480 } as never);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await renderDaily({}, true);
    await fireEvent.press(tile(puzzle.best));
    await act(async () => undefined);
    expect(within(screen.getByTestId('daily-server-verdict')).getByText('The game server counted your answer as wrong.')).toBeOnTheScreen();
  });
});
