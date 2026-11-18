import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Dimensions } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { DEFAULT_RULES, legalActions, viewToState, type Action } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';
import { displayScale } from '../display/DisplayScale';
import { DisplayScaleProvider } from '../display/DisplayScale';

/**
 * The coach at the table, through the rendered screen on an offline table with three bots (fake timers, a fixed deal as
 * in TablePlay.render.test.tsx), in each place a layout gives it: above the hand on a landscape phone, pinned above my
 * pond in portrait, in full under the right seat on a tablet. While the coach is on it is on screen, with its advice
 * on my turn; its button says so; its bar opens the sheet with everything it says.
 */
jest.setTimeout(60_000);

const realWindow = Dimensions.get('window');
function setWindow(width: number, height: number) {
  const dims = { width, height, scale: 2, fontScale: 1 };
  Dimensions.set({ window: dims, screen: dims });
}

let session: Session | null = null;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 18, 9) });
  let state = 20261118;
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
afterEach(async () => {
  session?.close();
  session = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  Dimensions.set({ window: realWindow, screen: realWindow });
  await displayScale.set({ tileScale: 1, textScale: 1 });
});

const RULES = { ...DEFAULT_RULES, turnSeconds: 15, timeBankSeconds: 0 };

async function renderTable(width: number, height: number, tileScale: 1 | 1.5 = 1) {
  setWindow(width, height);
  await displayScale.set({ tileScale, textScale: 1 });
  session = createLocalSession('Mei', 'panda', RULES);
  session.host!.start();
  await render(
    <FakeProviders app={{ session, screen: { name: 'table' } }}>
      <DisplayScaleProvider>
        <TableScreen />
      </DisplayScaleProvider>
    </FakeProviders>,
  );
}

const client = () => session!.client;
function myActions(): Action[] {
  const view = client().state.view;
  const seat = client().state.seat ?? 0;
  return view && view.phase !== 'ended' ? legalActions(viewToState(view), seat) : [];
}
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}
/** Plays on (passing every claim) until it is my turn to discard. */
async function untilMyDiscard() {
  for (let i = 0; i < 400; i++) {
    const a = myActions();
    if (a.some((x) => x.type === 'discard')) return;
    if (a.some((x) => x.type === 'pass')) await fireEvent.press(screen.getByTestId('claim-pass'));
    await wait(700);
  }
  throw new Error('never my turn');
}
const coachButton = () => screen.getByRole('button', { name: 'Coach' });

describe('the coach on a landscape phone (667x375)', () => {
  it('sits in a bar above my hand with the tile to discard, and its button says it is on', async () => {
    await renderTable(667, 375);
    await untilMyDiscard();
    const slot = screen.getByTestId('coach-slot');
    const advice = within(slot).getByTestId('coach-advice');
    expect(advice.props.children).toMatch(/^Discard /);
    // Normal tiles: one line in a row of its own beside my plate (the felt keeps its height).
    expect(advice.props.numberOfLines).toBe(1);
    expect(coachButton().props.accessibilityState).toMatchObject({ selected: true });
    // Not in the felt's middle, where the ponds and the claim buttons can take every pixel.
    expect(within(screen.getByTestId('felt-centre')).queryByTestId('coach')).toBeNull();
  });

  it('opens the sheet with everything from its bar, and the sheet closes again', async () => {
    await renderTable(667, 375);
    await untilMyDiscard();
    await fireEvent.press(within(screen.getByTestId('coach-slot')).getByRole('button', { name: /^.+ Discard / }));
    const sheet = screen.getByTestId('coach-sheet');
    expect(within(sheet).getByTestId('coach-advice').props.children).toMatch(/^Discard /);
    await fireEvent.press(within(sheet).getByRole('button', { name: 'Close the advice' }));
    expect(screen.queryByTestId('coach-sheet')).toBeNull();
  });

  it('goes with its button and comes back with it: the button never shows it on while it is gone', async () => {
    await renderTable(667, 375);
    await untilMyDiscard();
    await fireEvent.press(coachButton());
    expect(screen.queryByTestId('coach')).toBeNull();
    expect(coachButton().props.accessibilityState).toMatchObject({ selected: false });
    await fireEvent.press(coachButton());
    expect(screen.getByTestId('coach')).toBeOnTheScreen();
    expect(coachButton().props.accessibilityState).toMatchObject({ selected: true });
  });

  it('at Extra-large tiles, sits beside my plate on two lines (the row the plate has of its own)', async () => {
    await renderTable(667, 375, 1.5);
    await untilMyDiscard();
    const advice = within(screen.getByTestId('coach-slot')).getByTestId('coach-advice');
    expect(advice.props.numberOfLines).toBe(2);
    expect(advice.props.children).toMatch(/^Discard /);
  });
});

describe('the coach in portrait (390x844)', () => {
  it('is pinned above my pond, outside the felt that scrolls, so it can never scroll out of view', async () => {
    await renderTable(390, 844);
    await untilMyDiscard();
    const felt = screen.getByTestId('felt-scroll');
    expect(within(felt).queryByTestId('coach')).toBeNull();
    expect(within(felt).queryByTestId('my-pond')).toBeNull();
    expect(screen.getByTestId('coach-status')).toBeOnTheScreen();
    expect(screen.getByTestId('coach-advice').props.children).toMatch(/^Discard /);
    expect(screen.getByTestId('my-pond')).toBeOnTheScreen();
  });
});

describe('the coach on a tablet (1024x768)', () => {
  it('shows everything under the right seat', async () => {
    await renderTable(1024, 768);
    await untilMyDiscard();
    const coach = screen.getByTestId('coach');
    expect(within(coach).getByText('Coach')).toBeOnTheScreen();
    expect(within(coach).getByTestId('coach-advice').props.children).toMatch(/^Discard /);
  });
});
