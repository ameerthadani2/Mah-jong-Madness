/**
 * The saved table's record as the real app provider writes it (src/app-state.tsx, game/persist.ts): a save still waiting
 * when the table screen goes, or when the app goes to the background, is written then, not dropped, so Home's Resume
 * restores what reached the phone in the moment before; and a table the saved slot gave up is not written back into it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render } from '@testing-library/react-native';
import { AppState as AppLifecycle } from 'react-native';
import { AppProvider, useApp, type AppState } from './app-state';
import type { Session } from './game/session';
import { SAVE_DELAY_MS } from './game/persist';

const URL = 'wss://game.example/ws';

/** An online table whose client's record says how many changes it has seen (`seen`). */
function table(room: string) {
  const listeners = new Set<(s: unknown) => void>();
  let seen = 0;
  const state = { matchId: `m-${room}`, matchOver: false, ceremony: 'idle', kicked: false, heldElsewhere: false, token: 'tok', seat: 0, view: null, lastResult: null, audits: [] };
  const client = { state, serialize: () => ({ version: 1, sentSeq: 0, seen, state: { ...state } }), redHands: () => [] };
  const session = {
    mode: 'online',
    roomCode: room,
    serverUrl: URL,
    client,
    status: 'connected',
    attempt: 0,
    lostReason: null,
    onChange: (cb: (s: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onStatus: () => () => undefined,
    retryNow: () => undefined,
    reconnect: () => false,
    close: jest.fn(),
  } as unknown as Session;
  return {
    session,
    /** Something reaches the phone: the client's record changes. */
    change() {
      seen++;
      for (const l of listeners) l(state);
    },
  };
}

/** The real provider, with the app state it hands out (`app()`: the latest). */
async function provider() {
  let latest: AppState | null = null;
  function Probe() {
    latest = useApp();
    return null;
  }
  await render(
    <AppProvider>
      <Probe />
    </AppProvider>,
  );
  for (let i = 0; i < 20 && !latest!.loaded; i++) await act(async () => undefined);
  return () => latest!;
}

const seenIn = (s: AppState['activeSession']) => (s?.kind === 'online' ? (s.client as unknown as { seen: number }).seen : null);
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => undefined);
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('the saved table is written before the table screen goes', () => {
  it('a save still waiting when the table screen goes is written, so Resume restores the latest record', async () => {
    const app = await provider();
    const t = table('R1');
    await act(async () => app().setSession(t.session));
    await act(async () => void jest.advanceTimersByTime(SAVE_DELAY_MS));
    expect(seenIn(app().activeSession)).toBe(0);
    // Evidence reaches the phone, and the player steps away to Home 0.1 s later (the seat kept).
    await act(async () => t.change());
    await act(async () => void jest.advanceTimersByTime(100));
    await act(async () => app().setSession(null, { keepSeat: true }));
    expect(seenIn(app().activeSession)).toBe(1);
    await settle();
    expect(JSON.parse((await AsyncStorage.getItem('mjm.activeSession'))!).client.seen).toBe(1);
  });

  it('…and when the app goes to the background', async () => {
    const app = await provider();
    const t = table('R2');
    const listen = AppLifecycle.addEventListener as unknown as jest.Mock;
    listen.mockClear();
    await act(async () => app().setSession(t.session));
    await act(async () => void jest.advanceTimersByTime(SAVE_DELAY_MS));
    await act(async () => t.change());
    const handler = listen.mock.calls.find((c) => c[0] === 'change')?.[1] as ((s: string) => void) | undefined;
    expect(handler).toBeDefined();
    await act(async () => handler!('background'));
    expect(seenIn(app().activeSession)).toBe(1);
  });

  it('a table the saved slot gave up is not written back into it when its screen goes; the archive holds its latest record', async () => {
    const app = await provider();
    const t = table('R3');
    await act(async () => app().setSession(t.session));
    await act(async () => void jest.advanceTimersByTime(SAVE_DELAY_MS));
    await act(async () => t.change());
    // The exit sheet: the table is closed, then given up (src/screens/TableScreen.tsx `exit`).
    await act(async () => {
      app().setSession(null);
      app().setActiveSession(null);
    });
    await act(async () => void jest.advanceTimersByTime(5 * SAVE_DELAY_MS));
    expect(app().activeSession).toBeNull();
    await settle();
    expect(await AsyncStorage.getItem('mjm.activeSession')).toBeNull();
    const archive = JSON.parse((await AsyncStorage.getItem('mjm.tableArchive'))!) as Array<{ roomCode: string; client: { seen: number } }>;
    expect(archive.map((e) => [e.roomCode, e.client.seen])).toEqual([['R3', 1]]);
  });

  it('a new table left from its lobby before its first save, while the slot held another: neither stays in the slot', async () => {
    const app = await provider();
    const old = table('R4');
    await act(async () => app().setSession(old.session));
    await act(async () => void jest.advanceTimersByTime(SAVE_DELAY_MS));
    await act(async () => app().setSession(null, { keepSeat: true }));
    expect(seenIn(app().activeSession)).toBe(0);
    // Another table is opened, and left from its lobby (src/screens/LobbyScreen.tsx `leave`) 0.1 s later.
    const next = table('R5');
    await act(async () => app().setSession(next.session));
    await act(async () => void jest.advanceTimersByTime(100));
    await act(async () => {
      app().setSession(null);
      app().setActiveSession(null);
    });
    await act(async () => void jest.advanceTimersByTime(5 * SAVE_DELAY_MS));
    expect(app().activeSession).toBeNull();
  });
});
