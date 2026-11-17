import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { DEFAULT_RULES, legalActions, viewToState, type Action } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';
import { setLocalePreference } from '../i18n';

/**
 * The table played through the rendered screen: an offline table with three bots, on fake timers (the bots move every
 * 650 ms, and the turn clock runs on Date.now, which jest's fake timers move too). The deal comes from a fixed random
 * sequence, as in packages/net/test/support.ts (seededDeals), so every run sees the same hands.
 */
// A whole hand of bot moves runs in some of these tests; under coverage on a CI runner that takes a while.
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

const RULES = { ...DEFAULT_RULES, turnSeconds: 15, timeBankSeconds: 0 };

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
const mySeat = () => client().state.seat ?? 0;
/** What the rules let me do now, from the view I hold (the same as the screen offers). */
function myActions(): Action[] {
  const view = client().state.view;
  return view && view.phase !== 'ended' ? legalActions(viewToState(view), mySeat()) : [];
}
const myDiscardTurn = (a: Action[]) => a.some((x) => x.type === 'discard');
const myDiscards = () => client().state.view?.players[mySeat()].discards.length ?? 0;

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * Let the table play until `want` holds. On each of my own turns that is not the one wanted, discard the first legal
 * tile (or pass on a claim), as a quick player would, so the bots' clock never runs out on me.
 */
async function playUntil(want: (a: Action[]) => boolean, limit = 400) {
  for (let i = 0; i < limit; i++) {
    const a = myActions();
    if (want(a)) return a;
    // Through the screen, as the player would: the screen tells a move it sent from one the clock made.
    if (a.some((x) => x.type === 'pass')) await fireEvent.press(screen.getByTestId('claim-pass'));
    else if (myDiscardTurn(a)) {
      const tile = within(screen.getByTestId('hand-discard')).getAllByRole('button')[0];
      await fireEvent.press(tile);
      await fireEvent.press(tile);
    }
    await wait(700);
  }
  throw new Error('the table never reached the wanted moment');
}

describe('the seats', () => {
  afterEach(() => setLocalePreference('auto'));

  it('name each bot as a bot, in the sentence the language gives', async () => {
    setLocalePreference('zh-TW');
    await renderTable();
    const bots = client().state.seats.filter((s) => s.isBot);
    expect(bots).toHaveLength(3);
    // The host names a bot in English ("小美 (Bot)"); a Chinese table says 電腦 instead.
    for (const b of bots) {
      const base = b.name.replace(/ \(Bot\)$/, '');
      expect(screen.getAllByText(`${base}（電腦）`).length).toBeGreaterThan(0);
      expect(screen.queryAllByText(b.name)).toHaveLength(0);
    }
  });
});

describe('the shuffle, before the first deal', () => {
  it('asks before leaving, like the exit icon', async () => {
    // Not started: the table shows the shuffle while the deal is agreed.
    session = createLocalSession('Mei', 'panda', RULES);
    const calls = { setSession: jest.fn(), reset: jest.fn(), setActiveSession: jest.fn() };
    await render(
      <FakeProviders app={{ session, ...calls, screen: { name: 'table' } }}>
        <TableScreen />
      </FakeProviders>,
    );
    expect(screen.queryByTestId('hand-discard')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByText('Leave the table?')).toBeOnTheScreen();
    expect(calls.setSession).not.toHaveBeenCalled();
    expect(calls.reset).not.toHaveBeenCalled();
  });
});

describe('my own turn', () => {
  it('a first tap selects a tile and a second tap on it discards it', async () => {
    await renderTable();
    await playUntil(myDiscardTurn);
    expect(screen.getByText('Tap a tile, tap again to discard')).toBeOnTheScreen();
    const hand = screen.getByTestId('hand-discard');
    const first = within(hand).getAllByRole('button')[0];
    const name = first.props.accessibilityLabel as string;
    const before = myDiscards();
    await fireEvent.press(first);
    // Selected, not yet gone: the hand names it as selected and the Discard button offers it.
    expect(within(screen.getByTestId('hand-discard')).getByLabelText(`${name}, selected`)).toBeOnTheScreen();
    expect(screen.getByTestId('claim-discard')).toHaveProp('accessibilityLabel', `Discard: ${name}`);
    expect(myDiscards()).toBe(before);
    await fireEvent.press(within(screen.getByTestId('hand-discard')).getByLabelText(`${name}, selected`));
    await wait(10);
    expect(myDiscards()).toBe(before + 1);
    // My discard, not one the clock made for me.
    expect(screen.queryByTestId('auto-discard-notice')).toBeNull();
  });

  it('the Discard button discards the selected tile', async () => {
    await renderTable();
    await playUntil(myDiscardTurn);
    const before = myDiscards();
    await fireEvent.press(within(screen.getByTestId('hand-discard')).getAllByRole('button')[1]);
    await fireEvent.press(screen.getByTestId('claim-discard'));
    await wait(10);
    expect(myDiscards()).toBe(before + 1);
    expect(screen.queryByTestId('claim-discard')).toBeNull();
  });

  it('shows my clock, says when five seconds are left, and tells me when time ran out and a tile was discarded for me', async () => {
    await renderTable();
    await playUntil(myDiscardTurn);
    expect(screen.getByTestId('hud-clock').props.accessibilityLabel).toMatch(/^Your clock: 1[45] seconds left$/);
    // The ticking chip is never a live region (it would be read every second); the notices have a polite one of their own.
    expect(screen.getByTestId('hud-clock').props.accessibilityLiveRegion).toBeUndefined();
    expect(screen.getByTestId('clock-notice').props.accessibilityLiveRegion).toBe('polite');
    const before = myDiscards();
    await wait(10_000);
    expect(screen.getByTestId('clock-notice')).toHaveTextContent('5 seconds left');
    let waited = 10_000;
    while (myDiscards() === before && waited < 20_000) {
      await wait(500);
      waited += 500;
    }
    // Out of time at the turn's 15 seconds (the host checks its clocks every 400 ms), not before and not long after.
    expect(waited).toBeGreaterThan(14_000);
    expect(waited).toBeLessThanOrEqual(17_000);
    expect(myDiscards()).toBe(before + 1);
    expect(screen.getByTestId('auto-discard-notice')).toHaveTextContent(/^Time ran out: .+ was discarded for you\.$/);
  });
});

describe('a claim prompt', () => {
  it('offers each claim the rules allow with Pass, names the tiles, and Pass sends the table on', async () => {
    await renderTable();
    const offered = await playUntil((a) => a.some((x) => x.type === 'pong' || x.type === 'chi'));
    expect(screen.getByTestId('claim-pass')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Pass' })).toBeOnTheScreen();
    const pong = offered.find((x) => x.type === 'pong');
    if (pong) expect(screen.getByRole('button', { name: /^Pong: / })).toBeOnTheScreen();
    const chis = offered.filter((x) => x.type === 'chi');
    expect(screen.queryAllByRole('button', { name: /^Chow: / })).toHaveLength(chis.length);
    // In English each Chinese verb carries its gloss.
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    if (pong) expect(within(screen.getByRole('button', { name: /^Pong: / })).getByText('Pong')).toBeOnTheScreen();
    for (const b of screen.queryAllByRole('button', { name: /^Chow: / })) expect(within(b).getByText('Chow')).toBeOnTheScreen();
    // No tile can be thrown while a claim is up.
    expect(screen.queryByTestId('hand-discard')).toBeNull();
    await fireEvent.press(screen.getByTestId('claim-pass'));
    await wait(10);
    expect(screen.queryByTestId('claim-pass')).toBeNull();
  });

  it('a claim taken shows my new meld and asks me to discard', async () => {
    await renderTable();
    const offered = await playUntil((a) => a.some((x) => x.type === 'pong' || x.type === 'chi'));
    const melds = client().state.view!.players[mySeat()].melds.length;
    const claim = offered.find((x) => x.type === 'pong') ?? offered.find((x) => x.type === 'chi')!;
    await fireEvent.press(screen.getByRole('button', { name: claim.type === 'pong' ? /^Pong: / : /^Chow: / }));
    await wait(10);
    expect(client().state.view!.players[mySeat()].melds.length).toBe(melds + 1);
    expect(screen.getByTestId('hand-discard')).toBeOnTheScreen();
    // Taken by me, so no "made for you" notice.
    expect(screen.queryByTestId('auto-discard-notice')).toBeNull();
  });
});

describe('the end of a hand', () => {
  it('shows the result sheet, whose Leave asks first like the exit icon', async () => {
    const calls = await renderTable();
    await playUntil(() => client().state.lastResult !== null && client().state.lastResult !== undefined, 2000);
    // The call-out and the winner's hand are seen first; then the sheet.
    await wait(6_000);
    expect(screen.getByRole('button', { name: 'Next hand' })).toBeOnTheScreen();
    await fireEvent.press(within(screen.getByTestId('result-sheet')).getByRole('button', { name: 'Leave table' }));
    expect(screen.getByText('Leave the table?')).toBeOnTheScreen();
    expect(calls.setSession).not.toHaveBeenCalled();
    expect(calls.reset).not.toHaveBeenCalled();
  });
});
