import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import type { PlayerView } from '@mjm/engine';
import { SeatBadge } from './TableParts';
import type { SeatReaction } from './SeatMotion';

// The shipped build has no animated portrait clips yet; give the bot in seat 0 ('shades') one of each so the clip the
// plate plays shows which mood the seat is in.
jest.mock('./portraits/images', () => ({
  PORTRAIT_IMAGES: {},
  PORTRAIT_CLIPS: { shades: { idle: 101, win: 102, lose: 103 } },
}));
// expo-image's native view, as a plain view that keeps the clip it was given.
jest.mock('expo-image', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Image: (props: object) => createElement(View, { ...props, testID: 'portrait-clip' }) };
});

const player = { seat: 0, hand: [], melds: [], flowers: [], discards: [] } as unknown as PlayerView;
const info = { name: '阿明', connected: true, isBot: true } as never;
const badge = (reaction?: SeatReaction) => <SeatBadge seat={0} info={info} player={player} dealerSeat={0} isTurn={false} score={0} viewerSeat={0} reaction={reaction} />;
const clip = (): unknown => (screen.getByTestId('portrait-clip').props as { source: unknown }).source;

describe("a seat's portrait reacts to a win or a deal-in", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('plays the win clip for a fresh win, then goes back to idle after a few seconds', async () => {
    const { rerender } = await render(badge());
    expect(clip()).toBe(101);
    await rerender(badge({ kind: 'win', key: 1, at: Date.now() }));
    expect(clip()).toBe(102);
    await act(async () => void jest.advanceTimersByTime(3300));
    expect(clip()).toBe(101);
  });

  it('plays the lose clip for a deal-in, and nothing for a pong', async () => {
    const { rerender } = await render(badge({ kind: 'pong', key: 1, at: Date.now() }));
    expect(clip()).toBe(101);
    await rerender(badge({ kind: 'dealin', key: 2, at: Date.now() }));
    expect(clip()).toBe(103);
  });

  it('keeps its usual face for a reaction that is already history when the plate mounts (a rotation)', async () => {
    await render(badge({ kind: 'win', key: 1, at: Date.now() - 5000 }));
    expect(clip()).toBe(101);
  });

  it('goes back to idle on time when the table re-renders with the same reaction (a new object, the same key)', async () => {
    const at = Date.now();
    const { rerender } = await render(badge());
    await rerender(badge({ kind: 'win', key: 1, at }));
    expect(clip()).toBe(102);
    await act(async () => void jest.advanceTimersByTime(1000));
    // The parent renders again: the reaction is a fresh object for the same event, now too old to play again.
    await rerender(badge({ kind: 'win', key: 1, at }));
    expect(clip()).toBe(102);
    await act(async () => void jest.advanceTimersByTime(2300));
    expect(clip()).toBe(101);
  });
});
