import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_RULES, legalActions, viewToState } from '@mjm/engine';
import { ReviewScreen } from './ReviewScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders } from '../test/providers';
import { DEFAULT_PROGRESS, type Progress } from '../storage';
import { canUse, consume, EMPTY_WALLET, type Wallet } from '../monetisation/wallet';
import type { AppState } from '../app-state';

/**
 * The review of a hand that was really played: an offline table with three bots on fake timers, the player taking the
 * first legal move each turn, from a fixed random sequence (as packages/net/test/support.ts seededDeals) so every run
 * reviews the same hand.
 */
let session: Session | null = null;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 17, 9) });
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
afterEach(() => {
  session?.close();
  session = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
jest.setTimeout(60_000);

/** Play one hand to its end. */
async function playedHand(): Promise<Session> {
  const s = createLocalSession('Mei', 'panda', DEFAULT_RULES);
  session = s;
  s.host!.start();
  for (let i = 0; i < 3000 && !s.client.state.lastResult; i++) {
    const view = s.client.state.view;
    if (view && view.phase !== 'ended') {
      const a = legalActions(viewToState(view), s.client.state.seat ?? 0);
      const move = a.find((x) => x.type === 'pass') ?? a.find((x) => x.type === 'discard');
      if (move) s.client.act(move);
    }
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
  }
  expect(s.client.state.lastAudit).toBeTruthy();
  return s;
}

async function renderReview(app: Partial<AppState>) {
  const calls = { back: jest.fn(), go: jest.fn(), setWallet: jest.fn<(w: Wallet) => void>(), setProgress: jest.fn<(p: Progress | ((p: Progress) => Progress)) => void>() };
  await render(
    <FakeProviders app={{ ...calls, screen: { name: 'review' }, ...app }}>
      <ReviewScreen />
    </FakeProviders>,
  );
  return calls;
}
const progressAfter = (setProgress: jest.Mock<(p: Progress | ((p: Progress) => Progress)) => void>, from: Progress) =>
  setProgress.mock.calls.reduce<Progress>((p, [f]) => (typeof f === 'function' ? f(p) : f), from);

describe('the hand review', () => {
  it('grades each of my decisions, keeps the hand as reviewed and spends the free review', async () => {
    const s = await playedHand();
    const calls = await renderReview({ session: s });
    expect(screen.getByText('Hand review')).toBeOnTheScreen();
    expect(screen.getByText(/^accuracy over \d+ decisions$/)).toBeOnTheScreen();
    expect(screen.getByText(/^Best \d+$/)).toBeOnTheScreen();
    expect(screen.getByText(/^Blunder \?\? \d+$/)).toBeOnTheScreen();
    expect(calls.setWallet).toHaveBeenCalledTimes(1);
    const audit = s.client.state.lastAudit!;
    const after = progressAfter(calls.setProgress, DEFAULT_PROGRESS);
    expect(after.reviewedHands).toEqual([`${audit.matchId}:${audit.handNumber}`]);
    expect(after.reviewAccuracies).toHaveLength(1);
  });

  it('opens a hand already reviewed again for free, even once the day’s review is used', async () => {
    const s = await playedHand();
    const audit = s.client.state.lastAudit!;
    const used = consume(EMPTY_WALLET, 'reviews');
    expect(canUse(used, 'reviews').ok).toBe(false);
    const calls = await renderReview({ session: s, wallet: used, progress: { ...DEFAULT_PROGRESS, reviewedHands: [`${audit.matchId}:${audit.handNumber}`] } });
    expect(screen.getByText(/^accuracy over \d+ decisions$/)).toBeOnTheScreen();
    expect(calls.setWallet).not.toHaveBeenCalled();
  });

  it('once the day’s review is used, offers The Four Winds Club for a new hand', async () => {
    const s = await playedHand();
    const calls = await renderReview({ session: s, wallet: consume(EMPTY_WALLET, 'reviews') });
    expect(screen.getByText('Daily review used')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'See plans' }));
    expect(calls.go).toHaveBeenCalledWith({ name: 'shop', focus: 'fourwinds' });
    expect(calls.setWallet).not.toHaveBeenCalled();
  });

  it('says there is nothing to review before a hand is finished, and spends nothing', async () => {
    const calls = await renderReview({ session: null });
    expect(screen.getByText('Nothing to review yet. Finish a hand first.')).toBeOnTheScreen();
    expect(calls.setProgress).not.toHaveBeenCalled();
  });
});
