/**
 * Whether a full hand review may open (docs/MONETISATION.md, "Metered free taster"). The Four Winds
 * Club reviews every hand, and a hand reviewed before is always free. Otherwise a free account gets
 * one new hand a UTC day: with a session, the server counts it for the account (`POST /api/reviews`,
 * docs/API.md, "Hand reviews") and the app follows the server's answer, so clearing the app's storage
 * or using a second phone gives no second review. When the server cannot be reached, this phone
 * counts it, as before, and the count is not sent later. Pure TypeScript, so it is unit-tested directly.
 */
import { FREE_METERS } from '../monetisation/catalog';
import { canUse, consume, followServerReviews, trustedNow, type Wallet } from '../monetisation/wallet';
import type { PuzzleServer } from './puzzleSync';

/**
 * Where a review stands: open or not, and who decided it: the plan, a hand reviewed before
 * (`again`), the server's count, or this phone's count (offline or without a session).
 */
export type ReviewAllowance = { ok: boolean; source: 'plan' | 'again' | 'server' | 'device' };

/** True when only the server's count can say (a free account, a new hand, a session to ask with). */
export function needsServer(wallet: Wallet, alreadyReviewed: boolean, server: PuzzleServer | null, hand: string | null): boolean {
  return !alreadyReviewed && !!server && !!hand && canUse(wallet, 'reviews').limit !== null;
}

/** The answer without the server: a hand reviewed before, the plan, or this phone's count (spent here when it opens). */
export function localReviewAllowance(wallet: Wallet, alreadyReviewed: boolean, now: Date = new Date(trustedNow(wallet))): { allowance: ReviewAllowance; wallet: Wallet } {
  if (alreadyReviewed) return { allowance: { ok: true, source: 'again' }, wallet };
  const local = canUse(wallet, 'reviews', now);
  if (local.limit === null) return { allowance: { ok: true, source: 'plan' }, wallet };
  return { allowance: { ok: local.ok, source: 'device' }, wallet: local.ok ? consume(wallet, 'reviews', now) : wallet };
}

/**
 * Asks the server to open a review of `hand` and follows its count. When the server cannot be used
 * (no answer, a timeout, a fault, or any refusal but the day's limit), this phone's count decides.
 */
export async function serverReviewAllowance(server: PuzzleServer, hand: string, wallet: Wallet, now: Date = new Date(trustedNow(wallet))): Promise<{ allowance: ReviewAllowance; wallet: Wallet }> {
  try {
    const reply = await server.openReview(hand);
    if (reply.unlimited) return { allowance: { ok: true, source: 'plan' }, wallet };
    return { allowance: { ok: true, source: 'server' }, wallet: followServerReviews(wallet, reply.used, now) };
  } catch (e) {
    // The day's free review is gone on the server: this phone learns it too.
    if ((e as { code?: unknown } | null)?.code === 'review_daily_limit') return { allowance: { ok: false, source: 'server' }, wallet: followServerReviews(wallet, FREE_METERS.reviewsPerDay, now) };
    return localReviewAllowance(wallet, false, now);
  }
}
