import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import { EMPTY_WALLET, canUse, consume, followServerReviews, type Wallet } from '../monetisation/wallet';
import { localReviewAllowance, needsServer, serverReviewAllowance } from './reviewMeter';
import type { PuzzleServer } from './puzzleSync';

const NOW = new Date(Date.UTC(2026, 10, 27, 9));
const FOURWINDS: Wallet = { ...EMPTY_WALLET, userId: 'u-1', entitlements: [{ entitlement: 'fourwinds.month', expiresAt: null }] };

/** A server whose review meter answers as the test says. */
function server(openReview: PuzzleServer['openReview']): PuzzleServer {
  return { openReview } as PuzzleServer;
}
const answered = (used: number) => server(async () => ({ counted: true, unlimited: false, used, limit: 1, resetsAt: '2026-11-28T00:00:00.000Z' }));

describe('the free hand-review meter', () => {
  it('asks the server only for a new hand of a free account with a session', () => {
    const s = answered(1);
    expect(needsServer(EMPTY_WALLET, false, s, 'm:0')).toBe(true);
    expect(needsServer(EMPTY_WALLET, true, s, 'm:0')).toBe(false);
    expect(needsServer(EMPTY_WALLET, false, null, 'm:0')).toBe(false);
    expect(needsServer(EMPTY_WALLET, false, s, null)).toBe(false);
    expect(needsServer(FOURWINDS, false, s, 'm:0')).toBe(false);
  });

  it('follows the server: a counted review spends this phone’s count, and the day’s limit closes it even on a fresh phone', async () => {
    const ok = await serverReviewAllowance(answered(1), 'm:0', EMPTY_WALLET, NOW);
    expect(ok.allowance).toEqual({ ok: true, source: 'server' });
    expect(canUse(ok.wallet, 'reviews', NOW).ok).toBe(false);
    const limited = await serverReviewAllowance(
      server(async () => Promise.reject(new ApiError('used', 'review_daily_limit', 403))),
      'm:1',
      EMPTY_WALLET,
      NOW,
    );
    expect(limited.allowance).toEqual({ ok: false, source: 'server' });
    expect(canUse(limited.wallet, 'reviews', NOW).ok).toBe(false);
    // A hand reviewed before on another phone: the server counts nothing, and neither does this one.
    const again = await serverReviewAllowance(server(async () => ({ counted: false, unlimited: false, used: 0, limit: 1, resetsAt: null })), 'm:2', EMPTY_WALLET, NOW);
    expect(again.allowance.ok).toBe(true);
    expect(canUse(again.wallet, 'reviews', NOW).ok).toBe(true);
  });

  it('counts on this phone when the server cannot be used, as offline', async () => {
    for (const fail of [new TypeError('Network request failed'), new ApiError('down', 'puzzle_unreachable'), new ApiError('fault', 'internal', 500), new ApiError('slow down', 'rate_limited', 429)]) {
      const r = await serverReviewAllowance(server(async () => Promise.reject(fail)), 'm:0', EMPTY_WALLET, NOW);
      expect(r.allowance, String(fail)).toEqual({ ok: true, source: 'device' });
      expect(canUse(r.wallet, 'reviews', NOW).ok).toBe(false);
      // The day's review already spent here: closed.
      expect((await serverReviewAllowance(server(async () => Promise.reject(fail)), 'm:1', r.wallet, NOW)).allowance).toEqual({ ok: false, source: 'device' });
    }
  });

  it('without the server: a hand reviewed before and the plan are free; otherwise this phone counts', () => {
    expect(localReviewAllowance(consume(EMPTY_WALLET, 'reviews', NOW), true, NOW).allowance).toEqual({ ok: true, source: 'again' });
    expect(localReviewAllowance(FOURWINDS, false, NOW)).toEqual({ allowance: { ok: true, source: 'plan' }, wallet: FOURWINDS });
    const first = localReviewAllowance(EMPTY_WALLET, false, NOW);
    expect(first.allowance).toEqual({ ok: true, source: 'device' });
    expect(localReviewAllowance(first.wallet, false, NOW).allowance).toEqual({ ok: false, source: 'device' });
  });

  it('counts reviews by the UTC day, as the server does, and never lowers this phone’s count', () => {
    const spent = consume(EMPTY_WALLET, 'reviews', NOW);
    expect(canUse(spent, 'reviews', new Date(Date.UTC(2026, 10, 27, 23, 59))).ok).toBe(false);
    expect(canUse(spent, 'reviews', new Date(Date.UTC(2026, 10, 28, 0, 0))).ok).toBe(true);
    expect(followServerReviews(spent, 0, NOW).meters.reviews).toBe(1);
    expect(followServerReviews(EMPTY_WALLET, 1, NOW).meters).toMatchObject({ day: '2026-11-27', reviews: 1 });
  });
});
