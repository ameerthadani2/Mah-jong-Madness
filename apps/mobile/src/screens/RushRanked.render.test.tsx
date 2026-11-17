import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { discardPuzzle, type DiscardPuzzle } from '@mjm/engine';
import { PuzzleRushScreen } from './PuzzleScreens';
import { tileName } from '../logic/puzzle';
import { ApiError } from '../api/http';
import { puzzlesApi, type RushAnswerReply, type RushServed } from '../api/puzzles';
import { FakeProviders, sessionClient } from '../test/providers';
import type { Progress } from '../storage';
import type { Wallet } from '../monetisation/wallet';

/**
 * A ranked Puzzle Rush run with a session: the server serves the puzzles one at a time and each answer goes to it as
 * it is made (the puzzle API is replaced by stand-ins that answer as the server does). Every served puzzle here is a
 * discard puzzle, so one tap answers it.
 */
const served = (index: number): RushServed => ({ index, type: 'discard', puzzle: { ...discardPuzzle(`ranked-${index}`), seed: `run-1:${index}` } });
const handTile = (index: number, which: 'right' | 'wrong') => {
  const p = served(index).puzzle as DiscardPuzzle;
  const k = which === 'right' ? p.answers[0] : p.hand.find((x) => !p.answers.includes(x))!;
  return { kind: k, button: () => screen.getAllByRole('button', { name: tileName(k, 'en') })[0] };
};

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function renderRanked() {
  const calls = { back: jest.fn(), go: jest.fn(), setWallet: jest.fn<(w: Wallet) => void>(), setProgress: jest.fn<(p: Progress | ((p: Progress) => Progress)) => void>() };
  await render(
    <FakeProviders app={{ ...calls, screen: { name: 'rush' } }} auth={{ status: 'guest', client: sessionClient('u-1'), user: { id: 'u-1' } as never }}>
      <PuzzleRushScreen />
    </FakeProviders>,
  );
  await act(async () => undefined);
  return calls;
}

/** A reply the test releases when it chooses, to see the screen while the answer is on its way. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('ranked Puzzle Rush, one puzzle at a time from the server', () => {
  it('shows the puzzle the server sent, posts each answer as it is made and waits for the next puzzle', async () => {
    jest.spyOn(puzzlesApi, 'startRush').mockResolvedValue({ runId: 'run-1', startedAt: '', expiresAt: '', seconds: 180, strikes: 3, next: served(0) });
    const reply = deferred<RushAnswerReply>();
    const answer = jest.spyOn(puzzlesApi, 'answerRush').mockReturnValue(reply.promise);
    await renderRanked();
    expect(screen.getByText(/^Puzzle 1 · /)).toBeOnTheScreen();
    const first = handTile(0, 'right');
    await fireEvent.press(first.button());
    // The answer went to the server as it was made, for the puzzle it was served as.
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0].slice(1)).toEqual(['run-1', 0, first.kind]);
    // The screen moves on, and waits for the server's next puzzle with a short note.
    await act(async () => {
      jest.advanceTimersByTime(800);
    });
    expect(within(screen.getByTestId('rush-loading')).getByText('Getting the next puzzle from the game server…')).toBeOnTheScreen();
    await act(async () => reply.resolve({ index: 0, counted: true, correct: true, solved: 1, wrong: 0, done: false, next: served(1) }));
    expect(screen.queryByTestId('rush-loading')).toBeNull();
    expect(screen.getByText(/^Puzzle 2 · /)).toBeOnTheScreen();
    expect(handTile(1, 'right').button()).toBeOnTheScreen();
  });

  it('ends the run cleanly and says so when an answer cannot reach the server', async () => {
    jest.spyOn(puzzlesApi, 'startRush').mockResolvedValue({ runId: 'run-1', startedAt: '', expiresAt: '', seconds: 180, strikes: 3, next: served(0) });
    jest.spyOn(puzzlesApi, 'answerRush').mockRejectedValue(new ApiError('Could not reach the game server', 'puzzle_unreachable'));
    const finish = jest.spyOn(puzzlesApi, 'finishRush');
    const calls = await renderRanked();
    await fireEvent.press(handTile(0, 'right').button());
    await act(async () => undefined);
    expect(within(screen.getByTestId('rush-lost')).getByText('The connection to the game server was lost, so the run ended here. It is not ranked.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Play again' })).toBeOnTheScreen();
    // The run is over on the device: recorded there once, and nothing more is sent.
    expect(finish).not.toHaveBeenCalled();
    expect(calls.setProgress).toHaveBeenCalled();
    expect(screen.queryByTestId('rush-clock')).toBeOnTheScreen();
  });

  it('shows the score the server gave when its third strike ends the run, and does not finish it again', async () => {
    jest.spyOn(puzzlesApi, 'startRush').mockResolvedValue({ runId: 'run-1', startedAt: '', expiresAt: '', seconds: 180, strikes: 3, next: served(0) });
    const result = { runId: 'run-1', solved: 0, wrong: 3, seconds: 20, score: 0, ranked: true, answers: [], rating: { rating: 1000, change: 0, rated: 0 } };
    const replies = [0, 1, 2].map((i): RushAnswerReply => (i < 2 ? { index: i, counted: true, correct: false, solved: 0, wrong: i + 1, done: false, next: served(i + 1) } : { index: 2, counted: true, correct: false, solved: 0, wrong: 3, done: true, next: null, result }));
    const answer = jest.spyOn(puzzlesApi, 'answerRush').mockImplementation(async (_ctx, _run, index) => replies[index]);
    const finish = jest.spyOn(puzzlesApi, 'finishRush');
    await renderRanked();
    for (const i of [0, 1, 2]) {
      await fireEvent.press(handTile(i, 'wrong').button());
      await act(async () => {
        jest.advanceTimersByTime(2700);
      });
    }
    expect(answer).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Three strikes. Puzzles get harder the further you go.')).toBeOnTheScreen();
    expect(screen.getByText('Ranked')).toBeOnTheScreen();
    expect(finish).not.toHaveBeenCalled();
  });
});
