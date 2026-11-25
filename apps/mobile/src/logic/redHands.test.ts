import { describe, expect, it } from 'vitest';
import { RED_FAILURES_KEPT, RED_MAX, RED_PER_MATCH, RED_TTL_MS, redFor, validRed, withRed } from './redHands';

const URL = 'wss://game.example/ws';
const NOW = 1_000_000_000;
const red = (hand: number, matchId = 'm-1') => ({ matchId, hand, failures: ['Host sent a malformed frame'] });

describe('the red hands kept apart from the records of tables', () => {
  it('a hand that turns red is added once; the same list comes back when nothing is new (nothing is written)', () => {
    const one = withRed([], URL, 'ABC123', [red(1)], NOW);
    expect(one).toEqual([{ signalUrl: URL, roomCode: 'ABC123', ...red(1), at: NOW }]);
    expect(withRed(one, URL, 'ABC123', [red(1)], NOW)).toBe(one);
    const two = withRed(one, URL, 'ABC123', [red(1), red(3)], NOW);
    expect(two.map((k) => k.hand)).toEqual([1, 3]);
    // The same hand number of another match is another hand; the same match at another room code is the same match.
    expect(withRed(two, URL, 'ABC123', [red(1, 'm-2')], NOW)).toHaveLength(3);
    expect(withRed(two, URL, 'XYZ789', [red(1)], NOW)).toBe(two);
  });

  it('every red hand of a game server goes back to a client, which keeps those of its own match: wherever the match runs', () => {
    let list = withRed([], URL, 'ABC123', [red(1)], NOW);
    list = withRed(list, URL, 'XYZ789', [red(2, 'm-2')], NOW);
    expect(redFor(list, URL, NOW)).toEqual([red(1), red(2, 'm-2')]);
    expect(redFor(list, 'wss://other.example/ws', NOW)).toEqual([]);
  });

  it('is kept for a year', () => {
    const list = withRed([], URL, 'ABC123', [red(1)], NOW);
    expect(redFor(list, URL, NOW + RED_TTL_MS - 1)).toHaveLength(1);
    expect(redFor(list, URL, NOW + RED_TTL_MS + 1)).toEqual([]);
    expect(validRed(list, NOW + RED_TTL_MS + 1)).toEqual([]);
    expect(RED_TTL_MS).toBe(365 * 24 * 3600_000);
  });

  it('keeps the first few hands of a match and failures of a hand; room is made from matches that keep another hand first', () => {
    // The oldest is the only red hand of its match.
    let list = withRed([], URL, 'B', [red(0, 'm-first')], NOW - 1);
    list = withRed(list, URL, 'A', Array.from({ length: RED_PER_MATCH + 3 }, (_, h) => red(h)), NOW);
    expect(list.filter((k) => k.matchId === 'm-1').map((k) => k.hand)).toEqual(Array.from({ length: RED_PER_MATCH }, (_, h) => h));
    const long = withRed([], URL, 'A', [{ matchId: 'm-9', hand: 0, failures: ['a', 'b', 'c', 'd', 'e'] }], NOW);
    expect(long[0].failures).toHaveLength(RED_FAILURES_KEPT);
    // One hand of each of many matches: the match with several hands gives up its oldest first.
    for (let m = 0; m < RED_MAX - RED_PER_MATCH; m++) list = withRed(list, URL, 'B', [red(0, `m-x${m}`)], NOW + m);
    expect(list).toHaveLength(RED_MAX);
    expect(list.filter((k) => k.matchId === 'm-1').map((k) => k.hand)).toEqual(Array.from({ length: RED_PER_MATCH - 1 }, (_, h) => h + 1));
    expect(list[0].matchId).toBe('m-first');
    // Only matches with one hand left: the oldest goes.
    let ones = withRed([], URL, 'C', [red(0, 'm-y0')], NOW);
    for (let m = 1; m <= RED_MAX; m++) ones = withRed(ones, URL, 'C', [red(0, `m-y${m}`)], NOW + m);
    expect(ones).toHaveLength(RED_MAX);
    expect(ones[0].matchId).toBe('m-y1');
  });

  it('reads back only well-formed entries (those saved before they carried a time are kept)', () => {
    const good = { signalUrl: URL, roomCode: 'ABC123', ...red(1) };
    expect(validRed([good, null, { ...good, hand: 'one' }, { ...good, failures: [7] }, { ...good, roomCode: 3 }, { ...good, at: 'x' }], NOW)).toEqual([good]);
    expect(validRed('nope', NOW)).toEqual([]);
  });
});
