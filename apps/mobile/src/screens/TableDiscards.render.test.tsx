import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Dimensions, Platform } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { DEFAULT_RULES, legalActions, viewToState, type Action } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';
import { displayScale, DisplayScaleProvider } from '../display/DisplayScale';
import { DiscardsSheet, discardsOrder, discardsTile } from '../components/table/DiscardsSheet';
import { setLocalePreference } from '../i18n';

/**
 * Every discard is one tap away: on a small phone the portrait felt keeps only each pond's newest rows behind a "+N" chip
 * (display/portraitFit.ts), and a tap on an opponent's seat opens the table's discards, a modal sheet with that seat first
 * and each seat's whole pond, as the rendered table screen draws them (an offline table with three bots, fake timers and a
 * fixed deal, as in TableCoach.render.test.tsx).
 */
jest.setTimeout(60_000);

const realWindow = Dimensions.get('window');
const realOS = Platform.OS;
function setWindow(width: number, height: number) {
  const dims = { width, height, scale: 2, fontScale: 1 };
  Dimensions.set({ window: dims, screen: dims });
}

let session: Session | null = null;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 19, 9) });
  let state = 20261120;
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
  (Platform as { OS: typeof Platform.OS }).OS = realOS;
  setLocalePreference('auto');
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
const view = () => client().state.view!;
function myActions(): Action[] {
  const v = client().state.view;
  const seat = client().state.seat ?? 0;
  return v && v.phase !== 'ended' ? legalActions(viewToState(v), seat) : [];
}
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}
/** Plays on (passing every claim, discarding the first tile of my hand) until it is my turn and the left seat has `n` discards. */
async function untilLeftHas(n: number) {
  for (let i = 0; i < 600; i++) {
    const a = myActions();
    const left = view().players[(client().state.seat! + 3) % 4].discards.length;
    if (a.some((x) => x.type === 'discard')) {
      if (left >= n) return;
      const tile = within(screen.getByTestId('hand-discard')).getAllByRole('button')[0];
      await fireEvent.press(tile);
      await fireEvent.press(tile);
    } else if (a.some((x) => x.type === 'pass')) await fireEvent.press(screen.getByTestId('claim-pass'));
    await wait(300);
  }
  throw new Error(`the left seat never reached ${n} discards (${view().phase}, ${view().players.map((p) => p.discards.length).join(" ")})`);
}
/** The felt and the opponents' plates report their sizes, as onLayout does on a device. */
async function measure(felt: number) {
  const layout = (height: number, width = 80) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  await fireEvent(screen.getByTestId('plate-seat-1'), 'layout', layout(73));
  await fireEvent(screen.getByTestId('plate-seat-3'), 'layout', layout(73));
  await fireEvent(screen.getByTestId('plate-seat-2'), 'layout', layout(40, 120));
  await fireEvent(screen.getByTestId('felt-portrait'), 'layout', layout(felt));
}

describe('the table’s discards, one tap away', () => {
  it('opens from a seat whose pond keeps only its newest row, with that seat first and every one of its discards', async () => {
    await renderTable(360, 640, 1.5);
    await untilLeftHas(6);
    // The felt of a 360x640 phone at Extra-large tiles: the left seat keeps one row of its pond, behind the chip.
    await measure(158);
    const left = view().players[(client().state.seat! + 3) % 4];
    const pond = screen.getByTestId('pond-seat-3');
    expect(within(pond).getByTestId('pond-earlier')).toBeOnTheScreen();
    expect(within(pond).getAllByTestId(/^tile-/).length).toBeLessThan(left.discards.length);
    // The seat is one button: its name, relation, score and discards for a screen reader, and what a tap does.
    const seat = screen.getByTestId('seat-press-3');
    expect(seat.props.accessibilityRole).toBe('button');
    expect(seat.props.accessibilityLabel).toMatch(new RegExp(`, Left, score [+-]\\d+, ${left.discards.length} discards$`));
    expect(seat.props.accessibilityHint).toBe('Shows every discard and set at the table');
    await fireEvent.press(seat);
    const sheet = screen.getByTestId('discards-sheet');
    // A dialog on a phone (on the web the Modal is, below), named for what it holds.
    expect(sheet.props.role).toBe('dialog');
    expect(sheet.props['aria-label']).toBe('Every discard at the table');
    const sections = within(sheet).getAllByTestId(/^discards-seat-/);
    expect(sections.map((s) => s.props.testID)).toEqual(['discards-seat-3', 'discards-seat-1', 'discards-seat-2', 'discards-seat-0']);
    // Every discard of the left seat, in the order played (the chip's earlier ones too).
    const tiles = within(screen.getByTestId('discards-pond-3')).getAllByTestId(/^tile-/);
    expect(tiles).toHaveLength(left.discards.length);
    expect(within(sheet).queryByTestId('pond-earlier')).toBeNull();
    // Each seat says whose it is and how many.
    expect(within(sections[0]).getByText(/· Left 上家$/)).toBeOnTheScreen();
    expect(within(sections[0]).getByText(`${left.discards.length} discards`)).toBeOnTheScreen();
    await fireEvent.press(within(sheet).getByRole('button', { name: 'Close the discards' }));
    expect(screen.queryByTestId('discards-sheet')).toBeNull();
  });

  it('opens from the across and the right seats too, each first', async () => {
    await renderTable(390, 844);
    await untilLeftHas(1);
    for (const r of [2, 1] as const) {
      await fireEvent.press(screen.getByTestId(`seat-press-${r}`));
      expect(within(screen.getByTestId('discards-sheet')).getAllByTestId(/^discards-seat-/)[0].props.testID).toBe(`discards-seat-${r}`);
      await fireEvent.press(screen.getByTestId('discards-sheet-close'));
    }
  });

  it('is named on the web, where the Modal is the dialog, in the reader’s language', async () => {
    await renderTable(390, 844);
    await untilLeftHas(1);
    const v = view();
    (Platform as { OS: typeof Platform.OS }).OS = 'web';
    setLocalePreference('zh-TW');
    await render(<DiscardsSheet visible first={2} view={v} mySeat={client().state.seat!} seatName={(s) => `玩家${s}`} onClose={() => undefined} />);
    type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
    const find = (n: Node): Node | null => {
      if (n && typeof n === 'object' && n.type === 'Modal') return n;
      for (const c of n?.children ?? []) {
        const hit = typeof c === 'object' && c ? find(c as Node) : null;
        if (hit) return hit;
      }
      return null;
    };
    expect(find(screen.root as unknown as Node)?.props?.['aria-label']).toBe('牌桌上的全部棄牌');
    expect(screen.getByRole('header', { name: '棄牌' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '關閉棄牌' })).toBeOnTheScreen();
  });
});

describe('the sheet’s order and size', () => {
  it('lists the seat tapped first, then right, across, left and me', () => {
    expect(discardsOrder(3)).toEqual([3, 1, 2, 0]);
    expect(discardsOrder(2)).toEqual([2, 1, 3, 0]);
    expect(discardsOrder(null)).toEqual([1, 2, 3, 0]);
  });

  it('draws the reader’s tile size, but at least six tiles a row', () => {
    expect(discardsTile(258, 1)).toEqual({ tile: 20, perRow: 11 });
    expect(discardsTile(258, 1.5)).toEqual({ tile: 30, perRow: 8 });
    expect(discardsTile(120, 1.5).perRow).toBeGreaterThanOrEqual(6);
  });
});
