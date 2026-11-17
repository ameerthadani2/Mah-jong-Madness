import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { claimPuzzle, claimQuestion, defencePuzzle, defenceQuestion, discardPuzzle, puzzleQuestion, valuePuzzle, valueQuestion, waitsPuzzle, type AnyPuzzle, type Kind, type PuzzleAnswerInput } from '@mjm/engine';
import { PuzzleView, type PuzzleResult } from '../PuzzleView';
import { claimButtons, tileName, type Judged } from '../../logic/puzzle';
import { FakeProviders } from '../../test/providers';

/**
 * The claim, defence and value puzzle views as a player meets them: what each shows before the answer, what a right
 * and a wrong answer report, and what each says once answered. Puzzles come from fixed seeds through the engine.
 */
const DEFENCE = defencePuzzle('render-defence', 2);
const CLAIM = claimPuzzle('render-claim', 2);
const VALUE = valuePuzzle('render-value', 2);

async function show(puzzle: AnyPuzzle) {
  const onResult = jest.fn<(r: PuzzleResult) => void>();
  const onNext = jest.fn();
  await render(
    <FakeProviders>
      <PuzzleView puzzle={puzzle} onResult={onResult} onNext={onNext} />
    </FakeProviders>,
  );
  return { onResult, onNext };
}

/** The first on-screen button for a tile kind. */
const tile = (k: Kind) => screen.getAllByRole('button', { name: tileName(k, 'en') })[0];

describe('the defence puzzle view', () => {
  const safe = DEFENCE.answer;
  const risky = DEFENCE.options.find((o) => !o.accepted && o.shanten === DEFENCE.bestShanten)?.kind ?? DEFENCE.hand.find((k) => !DEFENCE.answers.includes(k))!;

  it('shows the threat and the hand, and says nothing about the answer before it is given', async () => {
    await show(DEFENCE);
    expect(screen.getByText('Someone looks close to winning. Keep your shape, but which discard is safest?')).toBeOnTheScreen();
    expect(screen.getByTestId('defence-threat')).toBeOnTheScreen();
    expect(screen.queryByTestId('defence-verdicts')).toBeNull();
    expect(screen.queryByText('Safe choice!')).toBeNull();
  });

  it('a safe discard is right and lists how often each tile wins for the threat', async () => {
    const { onResult, onNext } = await show(DEFENCE);
    await fireEvent.press(tile(safe));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0]).toMatchObject({ correct: true, type: 'defence', difficulty: 2, answer: safe });
    expect(screen.getByText('Safe choice!')).toBeOnTheScreen();
    expect(within(screen.getByTestId('defence-verdicts')).getAllByText(/ of their possible hands$/).length).toBeGreaterThan(0);
    // A second tap changes nothing: one answer per puzzle.
    await fireEvent.press(tile(risky));
    expect(onResult).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(onNext).toHaveBeenCalled();
  });

  it('a riskier discard is wrong and names the safest tile', async () => {
    const { onResult } = await show(DEFENCE);
    await fireEvent.press(tile(risky));
    expect(onResult.mock.calls[0][0]).toMatchObject({ correct: false, answer: risky });
    expect(screen.getByText('There is a safer tile.')).toBeOnTheScreen();
    expect(screen.getByText(`Safest: ${tileName(safe, 'en')}`)).toBeOnTheScreen();
  });
});

describe('the claim puzzle view', () => {
  const buttons = claimButtons(CLAIM, 'en');
  const right = buttons.find((b) => CLAIM.answers.includes(b.id))!;
  const wrong = buttons.find((b) => !CLAIM.answers.includes(b.id))!;

  it('offers one button per legal response, including Pass', async () => {
    await show(CLAIM);
    for (const b of buttons) expect(screen.getByTestId(`claim-${b.id}`)).toBeOnTheScreen();
    expect(screen.getByTestId('claim-pass')).toBeOnTheScreen();
    expect(screen.queryByText('Fine')).toBeNull();
  });

  it('the coach’s call is right, and every button then says whether it was fine', async () => {
    const { onResult } = await show(CLAIM);
    await fireEvent.press(screen.getByTestId(`claim-${right.id}`));
    expect(onResult.mock.calls[0][0]).toMatchObject({ correct: true, type: 'claim', answer: right.id });
    expect(screen.getByText('Good call!')).toBeOnTheScreen();
    expect(screen.getAllByText('Fine')).toHaveLength(CLAIM.answers.length);
    expect(screen.getAllByText('Worse')).toHaveLength(buttons.length - CLAIM.answers.length);
  });

  it('another call is wrong and names the best one', async () => {
    const { onResult } = await show(CLAIM);
    await fireEvent.press(screen.getByTestId(`claim-${wrong.id}`));
    expect(onResult.mock.calls[0][0]).toMatchObject({ correct: false, answer: wrong.id });
    expect(screen.getByText('The coach would do something else.')).toBeOnTheScreen();
    expect(screen.getByText(/^Best: /)).toBeOnTheScreen();
  });
});

describe('the value puzzle view', () => {
  const best = VALUE.answer;
  const rival = VALUE.rival;

  it('shows the winds and the hand, and no projections before the answer', async () => {
    await show(VALUE);
    expect(screen.getByText('Several discards leave you ready. Which one is worth the most?')).toBeOnTheScreen();
    expect(screen.getByText(`Seat: ${tileName(VALUE.seatWind, 'en')}`)).toBeOnTheScreen();
    expect(screen.queryByText('What each discard is worth')).toBeNull();
  });

  it('the discard worth the most is right, and each ready discard shows what it is worth', async () => {
    const { onResult } = await show(VALUE);
    await fireEvent.press(tile(best));
    expect(onResult.mock.calls[0][0]).toMatchObject({ correct: true, type: 'value', answer: best });
    expect(screen.getByText('Worth the most!')).toBeOnTheScreen();
    expect(screen.getByText('What each discard is worth')).toBeOnTheScreen();
    expect(screen.getByText(`Discard ${tileName(best, 'en')}`)).toBeOnTheScreen();
    expect(screen.getByText(`Discard ${tileName(rival, 'en')}`)).toBeOnTheScreen();
  });

  it('the tempting rival is wrong', async () => {
    const { onResult } = await show(VALUE);
    await fireEvent.press(tile(rival));
    expect(onResult.mock.calls[0][0]).toMatchObject({ correct: false, answer: rival });
    expect(screen.getByText('Another discard is worth more.')).toBeOnTheScreen();
  });
});

/** A verdict the test releases when it chooses, as the game server's would arrive. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/**
 * A ranked puzzle: the view gets the question the server served and a judge standing in for the server. Before the
 * answer the screen holds nothing that gives it away; the feedback comes from the puzzle the verdict reveals.
 */
describe('a ranked puzzle served as its question', () => {
  async function showRanked(puzzle: AnyPuzzle) {
    const verdict = deferred<Judged | null>();
    const judge = jest.fn((_a: PuzzleAnswerInput) => verdict.promise);
    const onResult = jest.fn<(r: PuzzleResult) => void>();
    await render(
      <FakeProviders>
        <PuzzleView question={puzzleQuestion(puzzle, 2)} judge={judge} onResult={onResult} onNext={jest.fn()} />
      </FakeProviders>,
    );
    return { verdict, judge, onResult };
  }

  it('types a question so a view cannot read an answer from it', () => {
    // @ts-expect-error a defence question carries no answers
    expect(defenceQuestion(DEFENCE).answers).toBeUndefined();
    // @ts-expect-error a value question carries no rival
    expect(valueQuestion(VALUE).rival).toBeUndefined();
    // @ts-expect-error a claim question's options carry no verdict
    expect(claimQuestion(CLAIM).options[0].accepted).toBeUndefined();
  });

  it('defence: sends the tile, says it is checking, takes no second answer, then shows what the revealed puzzle says', async () => {
    const risky = DEFENCE.hand.find((k) => !DEFENCE.answers.includes(k))!;
    const { verdict, judge, onResult } = await showRanked(DEFENCE);
    await fireEvent.press(tile(risky));
    expect(judge).toHaveBeenCalledWith(risky);
    expect(screen.getByTestId('puzzle-checking')).toBeOnTheScreen();
    expect(screen.queryByTestId('puzzle-answer')).toBeNull();
    await fireEvent.press(tile(DEFENCE.answer));
    expect(judge).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    await act(async () => verdict.resolve({ correct: false, puzzle: DEFENCE }));
    expect(onResult.mock.calls[0][0]).toMatchObject({ correct: false, type: 'defence', difficulty: 2, answer: risky });
    expect(screen.queryByTestId('puzzle-checking')).toBeNull();
    expect(screen.getByText(`Safest: ${tileName(DEFENCE.answer, 'en')}`)).toBeOnTheScreen();
    expect(screen.getByTestId('defence-verdicts')).toBeOnTheScreen();
  });

  it('claim: the buttons come from the question; the verdict marks each one from the revealed puzzle', async () => {
    const buttons = claimButtons(CLAIM, 'en');
    const right = buttons.find((b) => CLAIM.answers.includes(b.id))!;
    const { verdict, judge } = await showRanked(CLAIM);
    for (const b of buttons) expect(screen.getByTestId(`claim-${b.id}`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`claim-${right.id}`));
    expect(judge).toHaveBeenCalledWith(right.id);
    expect(screen.queryByText('Fine')).toBeNull();
    await act(async () => verdict.resolve({ correct: true, puzzle: CLAIM }));
    expect(screen.getByText('Good call!')).toBeOnTheScreen();
    expect(screen.getAllByText('Fine')).toHaveLength(CLAIM.answers.length);
  });

  it('value: the server’s verdict is the one shown, with the projections it reveals', async () => {
    const v = await showRanked(VALUE);
    await fireEvent.press(tile(VALUE.answer));
    expect(screen.queryByText('What each discard is worth')).toBeNull();
    await act(async () => v.verdict.resolve({ correct: true, puzzle: VALUE }));
    expect(screen.getByText('Worth the most!')).toBeOnTheScreen();
    expect(screen.getByText('What each discard is worth')).toBeOnTheScreen();
  });

  it('discard: the hand and the status come from the question, the feedback from the revealed puzzle', async () => {
    const DISCARD = discardPuzzle('render-discard', 2);
    const d = await showRanked(DISCARD);
    await fireEvent.press(tile(DISCARD.best));
    expect(d.judge).toHaveBeenCalledWith(DISCARD.best);
    await act(async () => d.verdict.resolve({ correct: true, puzzle: DISCARD }));
    expect(screen.getByTestId('puzzle-answer')).toBeOnTheScreen();
    expect(d.onResult.mock.calls[0][0]).toMatchObject({ correct: true, type: 'discard', difficulty: 2, answer: DISCARD.best });
  });

  it('waits: the candidates come from the question, the winning tiles from the revealed puzzle', async () => {
    const WAITS = waitsPuzzle('render-waits', 2);
    const w = await showRanked(WAITS);
    for (const k of WAITS.answers) await fireEvent.press(screen.getAllByRole('button', { name: tileName(k, 'en') }).at(-1)!);
    await fireEvent.press(screen.getByRole('button', { name: 'Check' }));
    expect([...(w.judge.mock.calls[0][0] as Kind[])].sort((a, b) => a - b)).toEqual([...WAITS.answers].sort((a, b) => a - b));
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    await act(async () => w.verdict.resolve({ correct: true, puzzle: WAITS }));
    expect(w.onResult).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('puzzle-answer')).toBeOnTheScreen();
  });

  it('shows no feedback when the answer could not be judged (the screen says what happened)', async () => {
    const { verdict, onResult } = await showRanked(DEFENCE);
    await fireEvent.press(tile(DEFENCE.answer));
    await act(async () => verdict.resolve(null));
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.queryByTestId('puzzle-answer')).toBeNull();
  });

  it("ignores a verdict on another theme's puzzle", async () => {
    const { verdict, onResult } = await showRanked(DEFENCE);
    await fireEvent.press(tile(DEFENCE.answer));
    await act(async () => verdict.resolve({ correct: true, puzzle: VALUE }));
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.queryByTestId('puzzle-answer')).toBeNull();
  });
});
