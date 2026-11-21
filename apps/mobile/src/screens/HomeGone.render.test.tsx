import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { HomeScreen } from './HomeScreen';
import { DEFAULT_PROFILE, type ActiveSession } from '../storage';
import { FakeProviders } from '../test/providers';

/**
 * Home's Resume card for an online table the game server no longer has. The join is replaced by one the test answers
 * (the server's "Room not found or full", or another refusal), and the online guard lets the player straight in (its own
 * rules are tested in src/legal). A gone table is not offered again: its record leaves the saved-table slot (the app
 * keeps it a while, src/app-state.tsx) and Home says why the card went.
 */
const mockJoin: { answer: unknown } = { answer: null };
jest.mock('../game/session', () => ({
  ...jest.requireActual<object>('../game/session'),
  createOnlineSession: async () => {
    throw mockJoin.answer;
  },
}));
jest.mock('../legal/useOnlineGuard', () => ({
  useOnlineGuard: () => ({ entry: 'ok', gate: { loaded: true, status: 'allowed', record: { birthYear: 1990 }, sendToServer: async () => 'sent' } }),
}));

const SAVED: ActiveSession = { kind: 'online', signalUrl: 'wss://game.example/ws', roomCode: 'ABC123', token: 't', name: 'Mei', avatar: 'panda', savedAt: 0 };

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
});

async function resumeAnswered(answer: unknown) {
  mockJoin.answer = answer;
  const setActiveSession = jest.fn();
  await render(
    <FakeProviders app={{ activeSession: SAVED, profile: { ...DEFAULT_PROFILE, name: 'Mei' }, setActiveSession }}>
      <HomeScreen />
    </FakeProviders>,
  );
  await fireEvent.press(await screen.findByRole('button', { name: 'Resume' }));
  await act(async () => undefined);
  return { setActiveSession };
}

describe("Home's Resume card for a table the game server no longer has", () => {
  it('goes, and says why: the saved table leaves the slot', async () => {
    const calls = await resumeAnswered(Object.assign(new Error('Room not found or full'), { code: 'room_unavailable' }));
    expect(calls.setActiveSession).toHaveBeenCalledWith(null);
    expect(screen.queryByText('Table in progress')).toBeNull();
    expect(screen.getByText('This table is over or no longer exists.')).toBeOnTheScreen();
  });

  it('control: any other refusal leaves the card offered, with the reason on it', async () => {
    const calls = await resumeAnswered(Object.assign(new Error('Table is full.'), { code: 'full' }));
    expect(calls.setActiveSession).not.toHaveBeenCalled();
    expect(screen.getByText('Table in progress')).toBeOnTheScreen();
    expect(screen.queryByText('This table is over or no longer exists.')).toBeNull();
  });
});
