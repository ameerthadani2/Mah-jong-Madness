import { describe, expect, it, vi } from 'vitest';
import { parseTableRating, pollRatingChange, ratingChangeFor, signedChange } from './tableRating';

const rating = (room: string | null, change = 12) => ({ rating: 1532, matches: 7, provisional: true, last: room ? { room, change, at: '2026-11-17T08:00:00Z' } : null });

describe('the quick-match table rating in the app', () => {
  it('reads the server answer and refuses a malformed one', () => {
    expect(parseTableRating(rating('QK7'))).toEqual(rating('QK7'));
    expect(parseTableRating({ rating: 1500, matches: 0, provisional: true, last: null })).toEqual({ rating: 1500, matches: 0, provisional: true, last: null });
    for (const bad of [undefined, null, 'x', { rating: '1500', matches: 0 }, { rating: 1500, matches: -1 }, { rating: 1500.5, matches: 0 }]) expect(parseTableRating(bad)).toBeNull();
    expect(parseTableRating({ rating: 1500, matches: 3, provisional: true, last: { room: 7 } })?.last).toBeNull();
  });

  it('gives the change only for the match at this table', () => {
    expect(ratingChangeFor(rating('QK7'), 'qk7')).toEqual({ rating: 1532, change: 12 });
    expect(ratingChangeFor(rating('ZZ1'), 'QK7')).toBeNull();
    expect(ratingChangeFor(rating(null), 'QK7')).toBeNull();
    expect(ratingChangeFor(null, 'QK7')).toBeNull();
    expect([signedChange(12), signedChange(-8), signedChange(0)]).toEqual(['+12', '-8', '±0']);
  });

  it('asks again until the server has applied the match, and gives up after the last try', async () => {
    const sleep = vi.fn(async () => undefined);
    const answers = [rating('OLD'), null, rating('QK7', -6)];
    const fetchRating = vi.fn(async () => {
      const a = answers.shift();
      if (a === null) throw new Error('offline');
      return a ?? null;
    });
    expect(await pollRatingChange(fetchRating, 'QK7', { tries: 5, sleep })).toEqual({ rating: 1532, change: -6 });
    expect(fetchRating).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const never = vi.fn(async () => rating('OLD'));
    expect(await pollRatingChange(never, 'QK7', { tries: 3, sleep })).toBeNull();
    expect(never).toHaveBeenCalledTimes(3);
    expect(await pollRatingChange(never, 'QK7', { tries: 3, sleep, cancelled: () => true })).toBeNull();
    expect(never).toHaveBeenCalledTimes(3);
  });
});
