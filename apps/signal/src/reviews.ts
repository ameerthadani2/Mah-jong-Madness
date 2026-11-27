/**
 * The free hand-review allowance, counted on the server for every account with a session, as the
 * Puzzle Rush meter is (docs/API.md, "Hand reviews"). The review itself is worked out on the phone
 * (the engine replays the hand there); the server keeps the count, so clearing the app's storage
 * no longer brings back a free review. A free account opens `FREE_REVIEWS_PER_DAY` full reviews of
 * new hands a UTC day; reopening a hand it reviewed in the last `HAND_REVIEW_KEEP_MS` is free, and
 * The Four Winds Club reviews every hand (those reviews are not recorded). The app asks before it
 * opens a review and follows the answer; offline it counts on the device (docs/MONETISATION.md).
 */
import { LIMITS } from './config';
import { BucketTable, DAY_MS } from './limits';
import { dayStart, PuzzleError, type PuzzleCtx, type PuzzleRouteFactory } from './puzzles';
import type { Repos } from './repos/types';

/** Full reviews of new hands a free account opens in a UTC day (the app's `FREE_METERS.reviewsPerDay`). */
export const FREE_REVIEWS_PER_DAY = 1;
/** How long the server remembers that an account reviewed a hand, so reopening it is free. */
export const HAND_REVIEW_KEEP_MS = 30 * DAY_MS;

/** A hand as the app names it: `<match id>:<hand number>`, letters, digits and `.:_-`, at most 64 characters. */
export function isHandKey(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v);
}

export interface ReviewDeps {
  repos: Repos;
  now?: () => number;
  /** A non-200 answer (the API's Reply). */
  reply: (status: number, body?: unknown) => unknown;
  /** Whether the account reviews every hand (The Four Winds Club; the API passes the wallet's check). Default: nobody. */
  unlimitedReviews?: (userId: string) => Promise<boolean>;
  /** Per-account bucket for review opens (default `LIMITS.puzzleSubmitsPerMinute` a minute). */
  limiter?: BucketTable<string>;
}

export function reviewRoutes<R>(r: PuzzleRouteFactory<R>, deps: ReviewDeps): R[] {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new BucketTable<string>(LIMITS.puzzleSubmitsPerMinute, LIMITS.puzzleSubmitsPerMinute / 60, { now });
  return [
    r('POST', '/api/reviews', async (ctx: PuzzleCtx) => {
      const me = await ctx.caller();
      if (!limiter.take(me.userId)) throw new PuzzleError(429, 'rate_limited', 'Too many hand reviews; please slow down');
      const hand = ctx.body.hand;
      if (!isHandKey(hand)) throw new PuzzleError(400, 'invalid', 'hand must name a hand: its match id and hand number');
      const at = now();
      const since = dayStart(at);
      const resetsAt = new Date(since + DAY_MS).toISOString();
      if (deps.unlimitedReviews && (await deps.unlimitedReviews(me.userId))) {
        return { counted: false, unlimited: true, used: await deps.repos.handReviews.countSince(me.userId, since), limit: null, resetsAt: null };
      }
      const res = await deps.repos.handReviews.open(me.userId, hand, at, since, FREE_REVIEWS_PER_DAY);
      if (res.outcome === 'limited') {
        return deps.reply(403, { error: 'review_daily_limit', message: 'Free accounts get one full hand review a day; The Four Winds Club reviews every hand', used: res.used, limit: FREE_REVIEWS_PER_DAY, resetsAt });
      }
      return { counted: res.outcome === 'counted', unlimited: false, used: res.used, limit: FREE_REVIEWS_PER_DAY, resetsAt };
    }),
  ];
}
