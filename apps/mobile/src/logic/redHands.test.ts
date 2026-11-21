import { describe, expect, it } from 'vitest';
import { RED_MAX, redFor, validRed, withRed } from './redHands';

const URL = 'wss://game.example/ws';
const red = (hand: number, matchId = 'm-1') => ({ matchId, hand, failures: ['Host sent a malformed frame'] });

describe('the red hands kept apart from the records of tables', () => {
  it('a hand that turns red is added once; the same list comes back when nothing is new (nothing is written)', () => {
    const one = withRed([], URL, 'ABC123', [red(1)]);
    expect(one).toEqual([{ signalUrl: URL, roomCode: 'ABC123', ...red(1) }]);
    expect(withRed(one, URL, 'ABC123', [red(1)])).toBe(one);
    const two = withRed(one, URL, 'ABC123', [red(1), red(3)]);
    expect(two.map((k) => k.hand)).toEqual([1, 3]);
    // The same hand number of another match, or at another table, is another hand.
    expect(withRed(two, URL, 'ABC123', [red(1, 'm-2')])).toHaveLength(3);
    expect(withRed(two, URL, 'XYZ789', [red(1)])).toHaveLength(3);
  });

  it('a table takes back its own red hands only, and the newest few are kept', () => {
    let list = withRed([], URL, 'ABC123', [red(1)]);
    list = withRed(list, URL, 'XYZ789', [red(2)]);
    expect(redFor(list, URL, 'ABC123')).toEqual([red(1)]);
    expect(redFor(list, 'wss://other.example/ws', 'ABC123')).toEqual([]);
    for (let h = 0; h < RED_MAX + 5; h++) list = withRed(list, URL, 'MANY', [red(h)]);
    expect(list).toHaveLength(RED_MAX);
    expect(list[list.length - 1].hand).toBe(RED_MAX + 4);
  });

  it('reads back only well-formed entries', () => {
    const good = { signalUrl: URL, roomCode: 'ABC123', ...red(1) };
    expect(validRed([good, null, { ...good, hand: 'one' }, { ...good, failures: [7] }, { ...good, roomCode: 3 }])).toEqual([good]);
    expect(validRed('nope')).toEqual([]);
  });
});
