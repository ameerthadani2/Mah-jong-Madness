import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen } from '@testing-library/react-native';
import { LeaderboardScreen } from './LeaderboardScreen';
import type { Board } from '../api/puzzles';
import { FakeProviders, sessionClient } from '../test/providers';

const ME = 'u-mei';
const RATING: Board = {
  board: 'rating',
  scope: 'global',
  club: null,
  minRated: 20,
  rows: [
    { rank: 1, userId: 'u-hua', displayName: 'Ah Hua', avatar: null, value: 1820, rated: 64 },
    { rank: 2, userId: ME, displayName: 'Mei', avatar: null, value: 1655, rated: 31 },
    { rank: 3, userId: 'u-wang', displayName: 'Old Wang', avatar: null, value: 1540, rated: 22 },
  ],
  me: { rank: 2, userId: ME, displayName: 'Mei', avatar: null, value: 1655, rated: 31 },
};

/** The game server as this screen sees it: the player's settings, their clubs and the board asked for. */
function serveBoards(o: { visible: boolean }) {
  const respond = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  jest.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith('/api/me')) return respond({ id: ME, leaderboardVisible: o.visible });
    if (url.includes(`/api/users/${ME}/clubs`)) return respond([]);
    if (url.includes('/leaderboard')) return respond(RATING);
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function renderBoards(auth: Parameters<typeof FakeProviders>[0]['auth']) {
  await render(
    <FakeProviders app={{ screen: { name: 'leaderboards' } }} auth={auth}>
      <LeaderboardScreen board="rating" />
    </FakeProviders>,
  );
}

describe('the leaderboard screen', () => {
  it('says when the game server cannot be reached, and offers to try again', async () => {
    await renderBoards({ ensure: async () => false });
    expect(await screen.findByText("Can't reach the game server")).toBeOnTheScreen();
    expect(screen.getByText('Leaderboards need a connection. Check your connection and try again.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it("lists the board in rank order with the player's own row marked", async () => {
    serveBoards({ visible: true });
    await renderBoards({ status: 'guest', user: { id: ME, displayName: 'Mei', kind: 'guest' }, ensure: async () => true, client: sessionClient(ME) });
    const rows = await screen.findAllByRole('text', { name: /^Rank \d/ });
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
      'Rank 1, Ah Hua, rating 1820, 64 rated answers',
      'Rank 2, you (Mei), rating 1655, 31 rated answers',
      'Rank 3, Old Wang, rating 1540, 22 rated answers',
    ]);
    expect(screen.getAllByText('You')).toHaveLength(1);
    expect(screen.queryByText('You are hidden from leaderboards')).toBeNull();
  });

  it('tells a player who hid themselves that nobody else sees them', async () => {
    serveBoards({ visible: false });
    await renderBoards({ status: 'guest', user: { id: ME, displayName: 'Mei', kind: 'guest' }, ensure: async () => true, client: sessionClient(ME) });
    expect(await screen.findByText('You are hidden from leaderboards')).toBeOnTheScreen();
    expect(screen.getByText('Other players do not see you on any board. Only you see your own place.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Change in Settings' })).toBeOnTheScreen();
  });
});
