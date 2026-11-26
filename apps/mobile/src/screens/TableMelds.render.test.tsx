import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Dimensions } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { DEFAULT_RULES, type TableView } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';
import { DisplayScaleProvider } from '../display/DisplayScale';
import { DEFAULT_SETTINGS } from '../storage';
import { meldSizes, MeldsAndFlowers, MeldView } from '../components/TableParts';

/**
 * The table screen stands on a view whose sets are not what the engine keeps (a set that is not an object, one with no
 * tile list): the table client's intake refuses such a view (packages/net isPlayerView), and the screen's meld layout, its
 * meld tiles, the coach and the moves it offers do not throw if one gets through (an offline table with three bots, fake
 * timers and a fixed deal, as in TableDiscards.render.test.tsx).
 */
jest.setTimeout(60_000);

const realWindow = Dimensions.get('window');
let session: Session | null = null;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 26, 9) });
  let state = 20261126;
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
  Dimensions.set({ window: realWindow, screen: realWindow });
});

async function renderTable(width: number, height: number) {
  const dims = { width, height, scale: 2, fontScale: 1 };
  Dimensions.set({ window: dims, screen: dims });
  session = createLocalSession('Mei', 'panda', { ...DEFAULT_RULES, turnSeconds: 15, timeBankSeconds: 0 });
  session.host!.start();
  await render(
    <FakeProviders app={{ session, screen: { name: 'table' }, settings: { ...DEFAULT_SETTINGS, coach: true } }}>
      <DisplayScaleProvider>
        <TableScreen />
      </DisplayScaleProvider>
    </FakeProviders>,
  );
  for (let i = 0; i < 20 && !session.client.state.view; i++) await act(async () => void jest.advanceTimersByTime(250));
}

/** The client shows `view` as if it had taken it in (past the intake, which refuses it). */
async function show(view: TableView) {
  await act(async () => (session!.client as unknown as { update(p: { view: TableView }): void }).update({ view }));
}

describe('a set that is not one', () => {
  it('is drawn as nothing by the sets row and the set itself, and counts no tiles in the felt’s layout', async () => {
    const pong = { type: 'pong', tiles: [8, 9, 10], concealed: false, from: 1, claimed: 8 };
    const player = { melds: [0, pong, { x: 1 }, null], flowers: 'x', discards: [], handCount: 13 } as never;
    await render(
      <FakeProviders>
        <MeldsAndFlowers player={player} />
        <MeldView meld={{ x: 1 } as never} />
      </FakeProviders>,
    );
    expect(screen.getAllByTestId(/^tile-/)).toHaveLength(3);
    expect(meldSizes([0, pong, { tiles: 'x' }, null])).toEqual([0, 3, 0, 0]);
    expect(meldSizes('x')).toEqual([]);
  });
});

describe('a view whose sets the engine does not keep', () => {
  it.each([
    [360, 640],
    [844, 390],
  ])('at %ix%i the felt, the sets and my moves stand, and the table screen does not throw', async (w, h) => {
    await renderTable(w, h);
    const v = session!.client.state.view!;
    expect(v).not.toBeNull();
    const mine = session!.client.state.seat ?? 0;
    const bad = [0, { x: 1 }, { type: 'pong', tiles: 'x', concealed: false }, null] as unknown as TableView['players'][number]['melds'];
    await show({ ...v, players: v.players.map((p, i) => ({ ...p, melds: [...p.melds, ...bad], ...(i === (mine + 2) % 4 ? { flowers: 'x' as unknown as number[] } : {}) })) });
    // The felt and every opponent's seat are still drawn.
    expect(screen.getByTestId(w < h ? 'felt-portrait' : 'felt-centre')).toBeOnTheScreen();
    expect(screen.getAllByTestId(/^(plate|side)-seat-\d$/).length).toBeGreaterThanOrEqual(2);
  });
});
