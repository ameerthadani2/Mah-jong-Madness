import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { QueueStatus } from '@mjm/net';
import { QuickMatchScreen } from './QuickMatchScreen';
import { FakeProviders } from '../test/providers';
import type { AuthClient } from '../auth/client';
import type { Session } from '../game/session';

/**
 * Quick match: the search the server runs is replaced by one the test drives (statuses, a match, a refusal), and the
 * online guard lets the player straight in (its own rules are tested in src/legal). The rest is the screen's own code:
 * what it shows and speaks while waiting, how it takes the player to the table, and what a refusal leaves on screen.
 */
type Search = { session: Promise<Session>; cancel: jest.Mock; opts: Record<string, unknown>; resolve(s: Session): void; reject(e: unknown): void };
const mockSearches: Search[] = [];
jest.mock('../game/session', () => ({
  ...jest.requireActual<object>('../game/session'),
  startQuickMatch: (opts: Record<string, unknown>) => {
    let resolve!: (s: Session) => void;
    let reject!: (e: unknown) => void;
    const session = new Promise<Session>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const search: Search = { session, cancel: jest.fn(), opts, resolve, reject };
    mockSearches.push(search);
    return search;
  },
}));
jest.mock('../legal/useOnlineGuard', () => ({
  useOnlineGuard: () => ({ entry: 'ok', gate: { record: { birthYear: 1990 }, sendToServer: async () => 'sent' } }),
}));

const status = (humans: number, waitedMs: number): QueueStatus => ({ t: 'queue_status', position: 1, waitedMs, humans, fillMs: 20_000 });
const fakeSession = () => ({ close: jest.fn(), mode: 'online', quickMatch: true }) as unknown as Session & { close: jest.Mock };

let ensureSession: jest.Mock<() => Promise<void>>;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 17, 9) });
  mockSearches.length = 0;
  ensureSession = jest.fn(async () => undefined);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function renderQuickMatch() {
  const calls = { back: jest.fn(), go: jest.fn(), reset: jest.fn(), setSession: jest.fn() };
  const client = { snapshot: () => ({ status: 'guest', userId: 'u-1', hasSession: true, banned: false }), subscribe: () => () => undefined, ensureSession } as unknown as AuthClient;
  const view = await render(
    <FakeProviders app={{ ...calls, screen: { name: 'quickmatch' } }} auth={{ status: 'guest', client, user: { id: 'u-1' } as never }}>
      <QuickMatchScreen />
    </FakeProviders>,
  );
  await act(async () => undefined);
  return { ...calls, unmount: view.unmount };
}
const live = () => screen.getByTestId('quickmatch-live').props.accessibilityLabel as string;
const search = () => mockSearches[mockSearches.length - 1];
const step = async (fn: () => void) => {
  await act(async () => fn());
};

describe('quick match', () => {
  it('searches at once, speaks the players found and counts the wait between statuses', async () => {
    await renderQuickMatch();
    expect(ensureSession).toHaveBeenCalled();
    expect(mockSearches).toHaveLength(1);
    expect(search().opts).toMatchObject({ userId: 'u-1' });
    expect(screen.getByText('Connecting to the game server…')).toBeOnTheScreen();
    await step(() => (search().opts.onStatus as (s: QueueStatus) => void)(status(1, 0)));
    expect(screen.getByText('Finding players…')).toBeOnTheScreen();
    expect(live()).toBe('1 player found (you)');
    await step(() => (search().opts.onStatus as (s: QueueStatus) => void)(status(3, 4000)));
    expect(live()).toBe('3 players found');
    expect(screen.getByText('Waiting 4 s')).toBeOnTheScreen();
    await step(() => void jest.advanceTimersByTime(2000));
    expect(screen.getByText('Waiting 6 s')).toBeOnTheScreen();
    expect(screen.getByText('Bots fill empty seats after 20 seconds')).toBeOnTheScreen();
  });

  it('once matched, says so, holds Cancel, and takes the player to the table with Home behind it', async () => {
    const calls = await renderQuickMatch();
    await step(() => (search().opts.onMatched as () => void)());
    expect(live()).toBe('Table found! Taking your seat…');
    expect(screen.getByTestId('quickmatch-cancel')).toBeDisabled();
    const table = fakeSession();
    await step(() => search().resolve(table));
    expect(calls.setSession.mock.calls[0][0]).toBe(table);
    expect(calls.reset).toHaveBeenCalledWith({ name: 'home' });
    expect(calls.go).toHaveBeenCalledWith({ name: 'table' });
    expect(table.close).not.toHaveBeenCalled();
  });

  it('Cancel stops the search and goes back', async () => {
    const calls = await renderQuickMatch();
    await step(() => (search().opts.onStatus as (s: QueueStatus) => void)(status(2, 1000)));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(search().cancel).toHaveBeenCalled();
    // The server answers the cancel.
    await step(() => search().reject({ code: 'cancelled' }));
    expect(calls.back).toHaveBeenCalled();
    expect(calls.setSession).not.toHaveBeenCalled();
  });

  it('a table that arrives after the screen has gone is closed and given up, unless it was a seat being returned to', async () => {
    let r = await renderQuickMatch();
    const fresh = fakeSession();
    const first = search();
    // Back while the answer is on its way: the search is cancelled, and the table arrives anyway.
    await step(() => r.unmount());
    expect(first.cancel).toHaveBeenCalled();
    await step(() => first.resolve(fresh));
    expect(fresh.close).toHaveBeenCalledWith({ keepSeat: false });
    expect(r.setSession).not.toHaveBeenCalled();

    r = await renderQuickMatch();
    const back = fakeSession();
    const second = search();
    await step(() => (second.opts.onSeated as () => void)());
    expect(live()).toBe('You are still at a table. Taking you back…');
    await step(() => r.unmount());
    await step(() => second.resolve(back));
    expect(back.close).toHaveBeenCalledWith({ keepSeat: true });
  });

  it('a ban is final: it says so and offers only Back', async () => {
    const calls = await renderQuickMatch();
    await step(() => search().reject({ code: 'banned' }));
    expect(screen.getByTestId('quickmatch-error')).toHaveTextContent('This account has been banned from online play.');
    expect(screen.queryByTestId('quickmatch-retry')).toBeNull();
    expect(screen.getByTestId('quickmatch-cancel')).toHaveAccessibleName('Back');
    await fireEvent.press(screen.getByTestId('quickmatch-cancel'));
    expect(calls.back).toHaveBeenCalled();
  });

  it('too many tries offers Try again after a wait, which searches again', async () => {
    await renderQuickMatch();
    await step(() => search().reject({ code: 'rate_limited' }));
    expect(screen.getByTestId('quickmatch-error')).toHaveTextContent(/Too many tries in a row/);
    expect(screen.getByTestId('quickmatch-retry')).toBeDisabled();
    expect(screen.getByText('Try again in 5 s')).toBeOnTheScreen();
    await step(() => void jest.advanceTimersByTime(5000));
    expect(screen.getByTestId('quickmatch-retry')).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => undefined);
    expect(mockSearches).toHaveLength(2);
    expect(screen.queryByTestId('quickmatch-error')).toBeNull();
  });

  it('when no account can be made (the server is out of reach), says why and offers Try again', async () => {
    ensureSession.mockRejectedValueOnce(Object.assign(new Error('Network request failed'), { code: 'network' }));
    await renderQuickMatch();
    expect(mockSearches).toHaveLength(0);
    expect(screen.getByTestId('quickmatch-error')).toBeOnTheScreen();
    expect(screen.getByTestId('quickmatch-retry')).toBeEnabled();
  });
});
