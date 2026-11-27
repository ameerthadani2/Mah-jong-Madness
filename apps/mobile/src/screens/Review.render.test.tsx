import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_RULES, legalActions, viewToState } from '@mjm/engine';
import { ReviewScreen } from './ReviewScreen';
import { createLocalSession, type Session } from '../game/session';
import { FakeProviders, sessionClient } from '../test/providers';
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

async function renderReview(app: Partial<AppState>, opts: { signedIn?: boolean } = {}) {
  const calls = { back: jest.fn(), go: jest.fn(), setWallet: jest.fn<(w: Wallet) => void>(), setProgress: jest.fn<(p: Progress | ((p: Progress) => Progress)) => void>() };
  const auth = opts.signedIn ? { status: 'guest' as const, client: sessionClient('u-1'), user: { id: 'u-1' } as never } : {};
  await render(
    <FakeProviders app={{ ...calls, screen: { name: 'review' }, ...app }} auth={auth}>
      <ReviewScreen />
    </FakeProviders>,
  );
  return calls;
}

/** The game server's review meter as this screen sees it (`POST /api/reviews`): its answer, or no answer at all. */
function serveReviews(answer: { status: number; body: unknown } | 'down') {
  const asked: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (!String(input).endsWith('/api/reviews')) return Promise.resolve(new Response('{}', { status: 404 }));
    asked.push(JSON.parse(String(init?.body ?? '{}')).hand);
    if (answer === 'down') return Promise.reject(new TypeError('Network request failed'));
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
  });
  return asked;
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

  it('signed in, asks the server before opening a new hand, and follows its count on this phone', async () => {
    const s = await playedHand();
    const audit = s.client.state.lastAudit!;
    const asked = serveReviews({ status: 200, body: { counted: true, unlimited: false, used: 1, limit: 1, resetsAt: '2026-11-18T00:00:00.000Z' } });
    const calls = await renderReview({ session: s }, { signedIn: true });
    expect(await screen.findByText(/^accuracy over \d+ decisions$/)).toBeOnTheScreen();
    expect(asked).toEqual([`${audit.matchId}:${audit.handNumber}`]);
    // The phone's own count follows the server's: today's free review is gone here too.
    const followed = calls.setWallet.mock.calls.at(-1)![0];
    expect(canUse(followed, 'reviews').ok).toBe(false);
  });

  it('signed in, a phone whose storage was cleared still finds the day’s review used: the server’s count decides', async () => {
    const s = await playedHand();
    serveReviews({ status: 403, body: { error: 'review_daily_limit', message: 'used', used: 1, limit: 1, resetsAt: '2026-11-18T00:00:00.000Z' } });
    // A fresh wallet: nothing counted on this phone.
    const calls = await renderReview({ session: s, wallet: EMPTY_WALLET }, { signedIn: true });
    expect(await screen.findByText('Daily review used')).toBeOnTheScreen();
    expect(screen.getByText(/counted by your account on every phone you sign in to/)).toBeOnTheScreen();
    // 09:00 UTC on 17 November: the next free review comes at the next midnight UTC, in this phone's time.
    expect(screen.getByText(/^Your next free review comes (today|tomorrow) at \d\d:\d\d, your time\.$/)).toBeOnTheScreen();
    expect(screen.queryByText(/^accuracy over/)).toBeNull();
    expect(canUse(calls.setWallet.mock.calls.at(-1)![0], 'reviews').ok).toBe(false);
  });

  it('signed in but the server cannot be reached: this phone counts the free review, as offline', async () => {
    const s = await playedHand();
    serveReviews('down');
    const calls = await renderReview({ session: s }, { signedIn: true });
    expect(await screen.findByText(/^accuracy over \d+ decisions$/, {}, { timeout: 15_000 })).toBeOnTheScreen();
    expect(canUse(calls.setWallet.mock.calls.at(-1)![0], 'reviews').ok).toBe(false);
  });

  it('says there is nothing to review before a hand is finished, and spends nothing', async () => {
    const calls = await renderReview({ session: null });
    expect(screen.getByText('Nothing to review yet. Finish a hand first.')).toBeOnTheScreen();
    expect(calls.setProgress).not.toHaveBeenCalled();
  });
});
