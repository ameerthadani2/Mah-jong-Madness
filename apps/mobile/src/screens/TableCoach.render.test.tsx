import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { DEFAULT_RULES, legalActions, viewToState, type Action } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';
import { displayScale } from '../display/DisplayScale';
import { DisplayScaleProvider } from '../display/DisplayScale';

/**
 * The coach at the table, through the rendered screen on an offline table with three bots (fake timers, a fixed deal as
 * in TablePlay.render.test.tsx), in each place a layout gives it: above the hand on a landscape phone, under the felt
 * over its rail in portrait, in full under the right seat on a tablet. While the coach is on it is on screen, with its advice
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
  it('sits under the felt, over its rail, with the status over two lines of advice; my pond stays in the felt, and nothing scrolls', async () => {
    await renderTable(390, 844);
    await untilMyDiscard();
    const felt = screen.getByTestId('felt-portrait');
    expect(within(felt).queryByTestId('coach')).toBeNull();
    expect(within(felt).getByTestId('my-pond')).toBeOnTheScreen();
    expect(screen.queryByTestId('felt-scroll')).toBeNull();
    const slot = screen.getByTestId('coach-slot');
    expect(within(slot).getByTestId('coach-status')).toBeOnTheScreen();
    expect(within(slot).getByTestId('coach-advice').props.children).toMatch(/^Discard /);
    expect(within(slot).getByTestId('coach-advice').props.numberOfLines).toBe(2);
    // Drawn at least 44 px tall, so its press is the bar itself: no padding reaching over my pond or the claim strip.
    const face = StyleSheet.flatten(within(slot).getByTestId('coach-face').props.style);
    expect(face.height).toBeGreaterThanOrEqual(44);
    expect(StyleSheet.flatten(within(slot).getByTestId('coach').props.style ?? {}).marginBottom ?? 0).toBe(0);
  });
});

describe('the status line under the compass in portrait (360x640)', () => {
  it('keeps inside the centre column, so a long "X discarded Y" never runs over a side seat', async () => {
    await renderTable(360, 640);
    // The felt and the plates report their sizes (as onLayout does on a device): a felt with room for the status line.
    const layout = (height: number, width = 80) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
    await fireEvent(screen.getByTestId('plate-seat-1'), 'layout', layout(73));
    await fireEvent(screen.getByTestId('plate-seat-3'), 'layout', layout(73));
    await fireEvent(screen.getByTestId('plate-seat-2'), 'layout', layout(40, 120));
    await fireEvent(screen.getByTestId('felt-portrait'), 'layout', layout(420));
    // Play on (passing every claim, discarding the first tile) until another seat's move shows the status line.
    for (let i = 0; i < 400 && !screen.queryByTestId('table-status'); i++) {
      const a = myActions();
      if (a.some((x) => x.type === 'pass')) await fireEvent.press(screen.getByTestId('claim-pass'));
      else if (a.some((x) => x.type === 'discard')) {
        const tile = within(screen.getByTestId('hand-discard')).getAllByRole('button')[0];
        await fireEvent.press(tile);
        await fireEvent.press(tile);
      }
      await wait(300);
    }
    // A 360 px phone's centre column is about 128 px wide, narrower than the line's own 220 px cap.
    await fireEvent(screen.getByTestId('centre-col'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 128, height: 300 } } });
    expect(StyleSheet.flatten(screen.getByTestId('table-status').props.style).maxWidth).toBe(128);
  });
});

describe('the felt in portrait on a small phone (320x568)', () => {
  /** The width of my hand's first tile as drawn. */
  const handTile = () => {
    const tile = within(screen.getByTestId('hand-discard')).getAllByTestId(/^tile-/)[0];
    return StyleSheet.flatten(tile.props.style).width as number;
  };
  /** The felt reports its height and the opponents' plates theirs (as onLayout does on a device). */
  async function measure(felt: number) {
    const layout = (height: number, width = 80) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
    await fireEvent(screen.getByTestId('plate-seat-1'), 'layout', layout(73));
    await fireEvent(screen.getByTestId('plate-seat-3'), 'layout', layout(73));
    await fireEvent(screen.getByTestId('plate-seat-2'), 'layout', layout(40, 144));
    await fireEvent(screen.getByTestId('felt-portrait'), 'layout', layout(felt));
  }

  it('shows the coach two lines of advice without the status, under the felt', async () => {
    await renderTable(320, 568, 1.5);
    await untilMyDiscard();
    const slot = screen.getByTestId('coach-slot');
    expect(within(slot).queryByTestId('coach-status')).toBeNull();
    expect(within(slot).getByTestId('coach-advice').props.numberOfLines).toBe(2);
    expect(within(screen.getByTestId('felt-portrait')).queryByTestId('coach')).toBeNull();
  });

  it('when even the least of the felt does not fit, the hand steps down a size at a time to Normal, and stays there for the hand', async () => {
    await renderTable(320, 568, 1.5);
    await untilMyDiscard();
    const big = handTile();
    // Room for the seats: the hand keeps its size.
    await measure(400);
    expect(handTile()).toBe(big);
    // Too short for the plates and a row each: a size down.
    await measure(60);
    const smaller = handTile();
    expect(smaller).toBeLessThan(big);
    // Still short at the new size: another step, down to Normal and no further.
    await measure(58);
    expect(handTile()).toBeLessThan(smaller);
    await measure(56);
    await measure(54);
    const normal = handTile();
    await measure(52);
    expect(handTile()).toBe(normal);
    // Room again later in the hand: the hand stays at the smaller size (it never jumps back mid-hand).
    await measure(400);
    expect(handTile()).toBe(normal);
  });

  it('at Normal tiles the hand keeps its size, whatever the felt measures', async () => {
    await renderTable(320, 568, 1);
    await untilMyDiscard();
    const size = handTile();
    await measure(30);
    expect(handTile()).toBe(size);
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
