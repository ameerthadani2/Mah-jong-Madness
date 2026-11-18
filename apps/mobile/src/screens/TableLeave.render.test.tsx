import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_RULES } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';

let session: Session | null = null;
// The bots move on timers (650 ms a move): fake ones keep the table still while the test looks at it, and none is
// left running after it.
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  session?.close();
  session = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function renderTable(quickMatch = false) {
  session = createLocalSession('Mei', 'panda', DEFAULT_RULES);
  // A quick-match table is an online one; the flag alone is what the exit sheet and the exit plan read.
  if (quickMatch) session = { ...session, mode: 'online', quickMatch: true };
  session.host!.start();
  const setSession = jest.fn();
  const setActiveSession = jest.fn();
  const reset = jest.fn();
  await render(
    <FakeProviders app={{ session, setSession, setActiveSession, reset, screen: { name: 'table' } }}>
      <TableScreen />
    </FakeProviders>,
  );
  return { setSession, setActiveSession, reset };
}

describe("the table's exit icon", () => {
  it('opens the leave sheet with three choices, and leaves nothing yet', async () => {
    const calls = await renderTable();
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave table' }));
    expect(screen.getByText('Leave the table?')).toBeOnTheScreen();
    // One "Keep playing": the scrim behind the sheet keeps playing on a tap but is no second button.
    expect(screen.getAllByRole('button', { name: 'Keep playing' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Back to Home' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Abandon table' })).toBeOnTheScreen();
    expect(calls.setSession).not.toHaveBeenCalled();
    expect(calls.setActiveSession).not.toHaveBeenCalled();
    expect(calls.reset).not.toHaveBeenCalled();
  });

  it('"Keep playing" closes the sheet and the table goes on', async () => {
    const calls = await renderTable();
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave table' }));
    await fireEvent.press(screen.getByText('Keep playing'));
    expect(screen.queryByText('Leave the table?')).toBeNull();
    expect(calls.setSession).not.toHaveBeenCalled();
    expect(calls.setActiveSession).not.toHaveBeenCalled();
    expect(calls.reset).not.toHaveBeenCalled();
  });

  it('"Back to Home" steps away and keeps the saved table for the resume card', async () => {
    const calls = await renderTable();
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave table' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Home' }));
    expect(calls.setSession).toHaveBeenCalledWith(null, { keepSeat: false });
    expect(calls.setActiveSession).not.toHaveBeenCalled();
    expect(calls.reset).toHaveBeenCalledWith({ name: 'home' });
  });

  it('only "Abandon table" forgets the table', async () => {
    const calls = await renderTable();
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave table' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Abandon table' }));
    expect(calls.setSession).toHaveBeenCalledWith(null, { keepSeat: false });
    expect(calls.setActiveSession).toHaveBeenCalledWith(null);
    expect(calls.reset).toHaveBeenCalledWith({ name: 'home' });
  });

  it('says the offline table waits while the player is away', async () => {
    await renderTable();
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave table' }));
    expect(screen.getByText('The table waits for you. You can come back from Home with Resume. Abandoning ends this match.')).toBeOnTheScreen();
  });

  it('at a quick-match table, says how long the table waits, and "Back to Home" keeps the seat', async () => {
    const calls = await renderTable(true);
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave table' }));
    expect(screen.getByText(/A quick-match table with no player left at it closes after two minutes\./)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Home' }));
    expect(calls.setSession).toHaveBeenCalledWith(null, { keepSeat: true });
    expect(calls.setActiveSession).not.toHaveBeenCalled();
    expect(calls.reset).toHaveBeenCalledWith({ name: 'home' });
  });
});
