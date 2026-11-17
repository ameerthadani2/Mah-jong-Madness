import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_RULES } from '@mjm/engine';
import type { ClientState } from '@mjm/net';
import { LobbyScreen } from './LobbyScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';

/** An online table session as the lobby sees it: the client's state, and the requests it can send. */
function onlineSession(state: Partial<ClientState>, quickMatch = false) {
  const client = { state: { seats: [], seat: null, view: null, lastError: null, ...state } as unknown as ClientState, requestBot: jest.fn(), requestStart: jest.fn() };
  return {
    client,
    roomCode: 'ABCD',
    mode: 'online',
    transportKind: 'websocket',
    status: 'connected',
    attempt: 0,
    lostReason: null,
    quickMatch,
    onChange: () => () => undefined,
    onStatus: () => () => undefined,
    retryNow: () => undefined,
    reconnect: () => false,
    close: () => undefined,
  } as unknown as Session & { client: typeof client };
}
const seat = (n: number, name: string, isBot = false) => ({ seat: n, name, isBot, peerId: isBot ? null : `p${n}`, connected: true });
const seated = { seat: 0, seats: [seat(0, 'Mei'), seat(1, 'Lin')] } as unknown as Partial<ClientState>;

let local: Session | null = null;
afterEach(() => {
  local?.close();
  local = null;
});

async function renderLobby(session: Session) {
  const calls = { setSession: jest.fn(), setActiveSession: jest.fn(), reset: jest.fn(), go: jest.fn() };
  await render(
    <FakeProviders app={{ session, ...calls, screen: { name: 'lobby' } }}>
      <LobbyScreen />
    </FakeProviders>,
  );
  return calls;
}

describe('the lobby', () => {
  it('shows only the reason and Back when the table refused the seat', async () => {
    const calls = await renderLobby(onlineSession({ seat: null, lastError: 'Table is full', lastErrorCode: 'table_full' } as Partial<ClientState>));
    expect(screen.getByTestId('lobby-no-seat')).toHaveTextContent(/Table is full\./);
    for (const control of ['Share', 'Add bot', 'Start match', 'Start (bots fill empty seats)']) expect(screen.queryByRole('button', { name: control })).toBeNull();
    expect(screen.queryByText('ABCD')).toBeNull();
    // Both ways back (the header's arrow and the card's button) leave the table, as Android's Back key does.
    const [header, card] = screen.getAllByRole('button', { name: 'Back' });
    expect(card).toBeOnTheScreen();
    await fireEvent.press(header);
    expect(calls.setSession.mock.calls[0][0]).toBeNull();
    expect(calls.setActiveSession).toHaveBeenCalledWith(null);
    expect(calls.reset).toHaveBeenCalledWith({ name: 'home' });
  });

  it('says it is joining while the table has not answered yet', async () => {
    await renderLobby(onlineSession({ seat: null }));
    expect(screen.getByText('Taking your seat…')).toBeOnTheScreen();
  });

  it('at a seated online table, shares the code and lets any seated player add a bot or start', async () => {
    const s = onlineSession(seated);
    await renderLobby(s);
    expect(screen.getByText('ABCD')).toBeOnTheScreen();
    expect(screen.getByText('Server table')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add bot' }));
    expect(s.client.requestBot).toHaveBeenCalledTimes(1);
    // Two people seated: the match starts with them.
    await fireEvent.press(screen.getByRole('button', { name: 'Start match' }));
    expect(s.client.requestStart).toHaveBeenCalledTimes(1);
  });

  it('at a quick-match table, has no code to share and starts by itself', async () => {
    await renderLobby(onlineSession(seated, true));
    expect(screen.getByTestId('lobby-quick')).toBeOnTheScreen();
    expect(screen.queryByText('ABCD')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add bot' })).toBeNull();
    expect(screen.getByText(/^Quick match: the table starts by itself/)).toBeOnTheScreen();
  });

  it('at a table on this device, adds a bot, which the player may remove again', async () => {
    local = createLocalSession('Mei', 'panda', DEFAULT_RULES);
    await renderLobby(local);
    expect(screen.getByText('On this device')).toBeOnTheScreen();
    const before = local.client.state.seats.filter((s) => s.isBot).length;
    await fireEvent.press(screen.getByRole('button', { name: 'Add bot' }));
    expect(local.client.state.seats.filter((s) => s.isBot).length).toBe(before + 1);
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(local.client.state.seats.filter((s) => s.isBot).length).toBe(before);
  });
});
