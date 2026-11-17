/**
 * The quick-match table rating as the app reads it (docs/API.md, "Table rating"): a defensive
 * parse of the server's answer, and the change a finished quick match made, which the server
 * applies a moment after the table ends (so the app asks again until it is there).
 */
import type { TableRating } from '../auth/types';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The server's `tableRating`, or null when it is missing or malformed (an older server). */
export function parseTableRating(v: unknown): TableRating | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isInt(o.rating) || !isInt(o.matches) || o.matches < 0) return null;
  const l = o.last as Record<string, unknown> | null | undefined;
  const last = l && typeof l === 'object' && typeof l.room === 'string' && isInt(l.change) && typeof l.at === 'string' ? { room: l.room, change: l.change, at: l.at } : null;
  return { rating: o.rating, matches: o.matches, provisional: o.provisional === true, last };
}

/** The rating after the match at `room` and its change, once the server has applied that match. */
export function ratingChangeFor(rating: TableRating | null, room: string): { rating: number; change: number } | null {
  if (!rating?.last || rating.last.room.toUpperCase() !== room.toUpperCase()) return null;
  return { rating: rating.rating, change: rating.last.change };
}

/** A change as the result sheet writes it: +12, -8, ±0. */
export function signedChange(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `${n}` : '±0';
}

/** How often, and how many times, the result sheet asks for the change after a quick match. */
export const RATING_POLL_MS = 1_500;
export const RATING_POLL_TRIES = 6;

/**
 * Ask for the rating until the server has applied the match at `room` (it does so a moment after
 * the table ends): the rating and change, or null when it has not after `tries` asks or the asks
 * fail (the result sheet then says nothing about the rating). `cancelled` stops it early.
 */
export async function pollRatingChange(
  fetchRating: () => Promise<TableRating | null>,
  room: string,
  opts: { tries?: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; cancelled?: () => boolean } = {},
): Promise<{ rating: number; change: number } | null> {
  const tries = opts.tries ?? RATING_POLL_TRIES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    if (opts.cancelled?.()) return null;
    const rating = await fetchRating().catch(() => null);
    const change = ratingChangeFor(rating, room);
    if (change) return change;
    if (i < tries - 1) await sleep(opts.everyMs ?? RATING_POLL_MS);
  }
  return null;
}
