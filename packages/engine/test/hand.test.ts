import { describe, expect, it } from 'vitest';
import { countsFromKinds, decompose, isComplete, kindsFromString, shanten, waits, kindFromCode, kindsToString } from '../src/index';

const c = (s: string) => countsFromKinds(kindsFromString(s));

describe('hand decomposition (16-tile, 5 sets + pair)', () => {
  it('recognises a standard complete hand', () => {
    expect(isComplete(c('123m 456m 789p 234s EEE CC'), 5)).toBe(true);
  });
  it('rejects an incomplete hand', () => {
    expect(isComplete(c('123m 456m 789p 234s EEE CF'), 5)).toBe(false);
  });
  it('handles fewer sets when melds are exposed', () => {
    expect(isComplete(c('123m EEE CC'), 2)).toBe(true);
    expect(isComplete(c('CC'), 0)).toBe(true);
  });
  it('finds multiple decompositions for ambiguous shapes', () => {
    // 111222333m can be 3 pongs or 3 chows
    const d = decompose(c('111222333m 456p 789s EE'), 5);
    expect(d.length).toBeGreaterThanOrEqual(2);
  });
  it('does not form chows across suits or with honors', () => {
    expect(isComplete(c('89m 1p 456p 789p 234s EEE CC 123s'), 5)).toBe(false);
    expect(isComplete(c('ESW 456p 789p 234s 123s 123m CC'), 5)).toBe(false);
  });
});

describe('waits', () => {
  it('finds a single pair wait (單騎)', () => {
    expect(waits(c('123m 456m 789p 234s EEE C'), 5)).toEqual([kindFromCode('C')]);
  });
  it('finds a two-sided wait', () => {
    const w = waits(c('123m 456m 789p 45s EEE CC'), 5);
    expect(kindsToString(w)).toBe('3s 6s');
  });
  it('finds multi-way waits', () => {
    // 2345m + pair → waits on 1m/4m (with 2 pair... ) etc. Just assert >= 2
    const w = waits(c('2345m 456p 789p 234s EEE'), 5);
    expect(w.length).toBeGreaterThanOrEqual(2);
  });
  it('returns nothing for a hand that is not ready', () => {
    expect(waits(c('13m 46m 79p 25s 8s ESW CF B'), 5)).toEqual([]);
  });
  it('drops a wait whose four copies are blocked by the player\'s own melds', () => {
    // 78m waits on 6m and 9m; an own kong of 9m kills the 9m wait.
    const hand = c('123p 456p 789s 78m 55s');
    expect(kindsToString(waits(hand, 4))).toBe('6m 9m');
    expect(kindsToString(waits(hand, 4, c('9999m')))).toBe('6m');
    // Three blocked copies leave one live 9m.
    expect(kindsToString(waits(hand, 4, c('999m')))).toBe('6m 9m');
  });
  it('counts concealed and blocked copies together', () => {
    // 5m pair wait with one 5m held and three more in a meld: no 5m is left.
    const hand = c('123m 456p 789p 234s 5m');
    expect(kindsToString(waits(hand, 4))).toBe('5m');
    expect(waits(hand, 4, c('555m'))).toEqual([]);
  });
});

describe('shanten', () => {
  it('is 0 when ready', () => {
    expect(shanten(c('123m 456m 789p 234s EEE C'), 5)).toBe(0);
  });
  it('is -1 when complete', () => {
    expect(shanten(c('123m 456m 789p 234s EEE CC'), 5)).toBe(-1);
  });
  it('is 1 when one exchange away', () => {
    // 4 sets + a pair + a partial 46m (needs 5m) + stray
    expect(shanten(c('46m 456p 789p 234s EEE C N'), 5)).toBe(1);
  });
  it('is large for a garbage hand', () => {
    expect(shanten(c('19m 19p 19s ESWN CFB 5m 2m 8p'), 5)).toBeGreaterThanOrEqual(5);
  });
  it('works with exposed melds (fewer sets needed)', () => {
    expect(shanten(c('46m CC N 12p'), 2)).toBe(1);
    expect(shanten(c('45m CC'), 1)).toBe(0);
  });
});
