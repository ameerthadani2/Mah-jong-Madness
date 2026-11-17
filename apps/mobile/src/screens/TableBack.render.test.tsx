import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { DEFAULT_RULES, legalActions, viewToState, type Action } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders, pressHardwareBack } from '../test/providers';

/**
 * Android's Back key at the table, and the match-over card's own Back to home: mid-match Back asks first (the leave
 * sheet), and once the match is over there is nothing to keep, so both leave at once. The match is one hand long so a
 * test reaches its end; the deal comes from a fixed random sequence (as in TablePlay.render.test.tsx).
 */
jest.setTimeout(60_000);

let session: Session | null = null;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 17, 9) });
  let state = 20261117;
  jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      buf[i] = (state >>> 0) & 0xff;
    }
    return buf;
  }) as never);
});
afterEach(() => {
  session?.close();
  session = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const RULES = { ...DEFAULT_RULES, handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 0 };

async function renderTable() {
  session = createLocalSession('Mei', 'panda', RULES);
  session.host!.start();
  const calls = { setSession: jest.fn(), reset: jest.fn(), setActiveSession: jest.fn() };
  await render(
    <FakeProviders app={{ session, ...calls, screen: { name: 'table' } }}>
      <TableScreen />
    </FakeProviders>,
  );
  return calls;
}

const client = () => session!.client;
function myActions(): Action[] {
  const view = client().state.view;
  const seat = client().state.seat ?? 0;
  return view && view.phase !== 'ended' ? legalActions(viewToState(view), seat) : [];
}
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}
async function back() {
  await act(async () => pressHardwareBack());
}

/** Play the one hand through the screen, discarding the first tile and passing every claim, until the match is over. */
async function playToMatchEnd() {
  for (let i = 0; i < 2000 && !client().state.matchOver; i++) {
    const a = myActions();
    if (a.some((x) => x.type === 'pass')) await fireEvent.press(screen.getByTestId('claim-pass'));
    else if (a.some((x) => x.type === 'discard')) {
      const tile = within(screen.getByTestId('hand-discard')).getAllByRole('button')[0];
      await fireEvent.press(tile);
      await fireEvent.press(tile);
    }
    await wait(700);
  }
  if (!client().state.matchOver) throw new Error('the match never ended');
  await wait(10);
}

const leftNothing = (calls: Awaited<ReturnType<typeof renderTable>>) => {
  expect(calls.setSession).not.toHaveBeenCalled();
  expect(calls.setActiveSession).not.toHaveBeenCalled();
  expect(calls.reset).not.toHaveBeenCalled();
};
const leftAndForgot = (calls: Awaited<ReturnType<typeof renderTable>>) => {
  expect(calls.setSession).toHaveBeenCalledWith(null, { keepSeat: false });
  expect(calls.setActiveSession).toHaveBeenCalledWith(null);
  expect(calls.reset).toHaveBeenCalledWith({ name: 'home' });
};

describe("Android's Back key at the table", () => {
  it('mid-match, opens the leave sheet and leaves nothing yet', async () => {
    const calls = await renderTable();
    await screen.findByRole('button', { name: 'Leave table' });
    expect(screen.queryByText('Leave the table?')).toBeNull();
    await back();
    expect(screen.getByText('Leave the table?')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Abandon table' })).toBeOnTheScreen();
    leftNothing(calls);
    // Keep playing closes it again, and the table goes on.
    await fireEvent.press(screen.getByText('Keep playing'));
    expect(screen.queryByText('Leave the table?')).toBeNull();
    leftNothing(calls);
  });

  it('once the match is over, leaves at once and forgets the finished table', async () => {
    const calls = await renderTable();
    await playToMatchEnd();
    expect(screen.getByTestId('match-over')).toBeOnTheScreen();
    await back();
    expect(screen.queryByText('Leave the table?')).toBeNull();
    leftAndForgot(calls);
  });
});

describe('the match-over card', () => {
  it('shows the final standings in place of the last result sheet, and its Back to home leaves at once', async () => {
    const calls = await renderTable();
    await playToMatchEnd();
    const card = screen.getByTestId('match-over');
    expect(within(card).getByText('Match over')).toBeOnTheScreen();
    expect(screen.queryByTestId('result-sheet')).toBeNull();
    leftNothing(calls);
    await fireEvent.press(within(card).getByRole('button', { name: 'Back to home' }));
    expect(screen.queryByText('Leave the table?')).toBeNull();
    leftAndForgot(calls);
  });
});
