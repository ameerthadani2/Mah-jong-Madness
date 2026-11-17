import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { OnlineScreen } from './OnlineScreen';
import * as sessions from '../game/session';
import { FakeProviders } from '../test/providers';
import type { AppState } from '../app-state';
import type { AuthContextValue } from '../auth/AuthProvider';

// An adult who answered the age gate (the app keeps the answer once loaded, so every test here starts past it; the
// gate itself is rendered in components/AgeGate.render.test.tsx).
beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function renderOnline(app: Partial<AppState> = {}, auth: Partial<AuthContextValue> = {}) {
  const calls = { go: jest.fn(), setSession: jest.fn() };
  const ensure = jest.fn(async () => true);
  await render(
    <FakeProviders app={{ ...calls, screen: { name: 'online' }, ...app }} auth={{ status: 'guest', ensure, ...auth }}>
      <OnlineScreen />
    </FakeProviders>,
  );
  await act(async () => undefined);
  return { ...calls, ensure };
}

describe('the Online screen', () => {
  it('connects once the age gate is passed, and opens Quick match and Clubs', async () => {
    const { ensure, go } = await renderOnline();
    expect(await screen.findByRole('button', { name: 'Create table' })).toBeOnTheScreen();
    expect(ensure).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('online-quickmatch-button'));
    expect(go).toHaveBeenLastCalledWith({ name: 'quickmatch' });
    await fireEvent.press(screen.getByRole('button', { name: 'Clubs' }));
    expect(go).toHaveBeenLastCalledWith({ name: 'clubs' });
  });

  it('shows why a table link could not be followed', async () => {
    await renderOnline({ screen: { name: 'online', notice: 'The club closed this table.' } });
    expect(await screen.findByTestId('online-error')).toHaveTextContent(/The club closed this table\./);
  });

  it('joins only with a code of four characters or more, and says why a refused join did not seat the player', async () => {
    const create = jest.spyOn(sessions, 'createOnlineSession').mockRejectedValue(Object.assign(new Error('No such room'), { code: 'room_unavailable' }));
    const { go, setSession } = await renderOnline();
    const join = await screen.findByRole('button', { name: 'Join table' });
    await fireEvent.changeText(screen.getByPlaceholderText('ABC123'), 'ab');
    expect(screen.getByRole('button', { name: 'Join table' })).toBeDisabled();
    await fireEvent.changeText(screen.getByPlaceholderText('ABC123'), 'ab12');
    expect(join).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Join table' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ action: 'join', code: 'AB12' }));
    expect(await screen.findByTestId('online-error')).toHaveTextContent(/No open table with that code/);
    expect(setSession).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalledWith({ name: 'lobby' });
  });
});
