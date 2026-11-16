import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { HomeScreen } from './HomeScreen';
import { DEFAULT_PROFILE, type ActiveSession } from '../storage';
import { FakeProviders } from '../test/providers';

/** A saved offline match against the bots, on its third hand. */
const SAVED: ActiveSession = { kind: 'local', host: { snapshot: { handNumber: 2 } } as never, token: 't', name: 'Mei', avatar: 'panda', savedAt: 0 };

beforeEach(async () => {
  // A returning adult player: the age gate is answered (src/legal/useAgeGate.ts reads it from storage).
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
});

async function renderHome() {
  const setActiveSession = jest.fn();
  const setSession = jest.fn();
  await render(
    <FakeProviders app={{ activeSession: SAVED, profile: { ...DEFAULT_PROFILE, name: 'Mei' }, setActiveSession, setSession }}>
      <HomeScreen />
    </FakeProviders>,
  );
  return { setActiveSession, setSession };
}

describe("Home's resume card", () => {
  it('offers the saved table back', async () => {
    await renderHome();
    expect(await screen.findByText('Table in progress')).toBeOnTheScreen();
    expect(screen.getByText('Offline match vs bots · hand 3')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeOnTheScreen();
  });

  it('"Abandon table" asks first, and gives nothing up yet', async () => {
    const calls = await renderHome();
    await fireEvent.press(await screen.findByRole('button', { name: 'Abandon table' }));
    expect(screen.getByText('Abandon this table?')).toBeOnTheScreen();
    expect(screen.getByText('This deletes your saved match against the bots. You will not be able to resume it.')).toBeOnTheScreen();
    expect(calls.setActiveSession).not.toHaveBeenCalled();
  });

  it('cancelling keeps the table', async () => {
    const calls = await renderHome();
    await fireEvent.press(await screen.findByRole('button', { name: 'Abandon table' }));
    await fireEvent.press(screen.getByText('Keep my table'));
    expect(screen.queryByText('Abandon this table?')).toBeNull();
    expect(calls.setActiveSession).not.toHaveBeenCalled();
    expect(screen.getByText('Table in progress')).toBeOnTheScreen();
  });

  it('confirming gives the table up, and the card goes', async () => {
    const calls = await renderHome();
    await fireEvent.press(await screen.findByRole('button', { name: 'Abandon table' }));
    // The sheet's own button carries the same words as the card's; the sheet's is the last one.
    const buttons = screen.getAllByRole('button', { name: 'Abandon table' });
    await fireEvent.press(buttons[buttons.length - 1]);
    expect(calls.setActiveSession).toHaveBeenCalledWith(null);
    expect(screen.queryByText('Table in progress')).toBeNull();
  });
});
