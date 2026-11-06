import { describe, expect, it } from 'vitest';
import { countsFromKinds, decompose, discardOptions, isComplete, kindsFromString, shanten, waits, kindFromCode, kindsToString } from '../src/index';

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
  it('does not call a hand ready when its only completion needs a fifth copy of a quad it holds', () => {
    // Four sets plus a concealed, un-konged 1111s: a pong leaves a lone 1s whose tanki wait is
    // dead, and a pair leaves a 11s partial that wants the same fifth copy. One away, not ready.
    const quad = c('123m 456m 789m 123p 1111s');
    expect(waits(quad, 5)).toEqual([]);
    expect(shanten(quad, 5)).toBe(1);
    expect(shanten(c('EEEE'), 1)).toBe(1);
    expect(shanten(c('1111m 2222p'), 2)).toBe(1);
    // Two dead quads and a pair: the missing set can seed from nothing, so two away.
    expect(shanten(c('EEEE SSSS CC'), 3)).toBe(2);
    // Konged (not in the hand), the same shape is a plain tanki wait.
    expect(shanten(c('123m 456m 789m 123p 1s'), 4)).toBe(0);
  });
  it('agrees with waits() on readiness over quad-heavy hands', () => {
    // waits() and isComplete() enumerate shapes directly, so they are an independent check of the
    // 0 / −1 boundary. Hands are dealt from full walls with one to three quads forced in.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
    for (let i = 0; i < 400; i++) {
      const setsNeeded = 1 + Math.floor(rnd() * 5);
      const size = setsNeeded * 3 + 1 + (i % 2);
      const counts = countsFromKinds([]);
      let left = size;
      for (let q = 1 + Math.floor(rnd() * 3); q > 0 && left >= 4; q--) {
        const k = Math.floor(rnd() * 34);
        if (counts[k] === 0) {
          counts[k] = 4;
          left -= 4;
        }
      }
      while (left > 0) {
        const k = Math.floor(rnd() * 34);
        if (counts[k] < 4) {
          counts[k]++;
          left--;
        }
      }
      const s = shanten(counts, setsNeeded);
      if (size === setsNeeded * 3 + 1) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s === 0).toBe(waits(counts, setsNeeded).length > 0);
      } else {
        expect(s === -1).toBe(isComplete(counts, setsNeeded));
        let ready = false;
        for (let k = 0; k < 34 && !ready; k++) {
          if (counts[k] === 0) continue;
          counts[k]--;
          ready = waits(counts, setsNeeded).length > 0;
          counts[k]++;
        }
        expect(s <= 0).toBe(ready || s === -1);
      }
    }
  });
});

describe('discardOptions', () => {
  it('never reports a ready discard with nothing to accept', () => {
    // 17 tiles holding an un-konged 1111s. Throwing 9p keeps the dead quad shape (one away,
    // improved by 2s/3s); throwing 1s makes 111s a pong and waits on 9p alone.
    const hand = c('123m 456m 789m 123p 1111s 9p');
    const unseen = hand.map((n) => 4 - n);
    const options = discardOptions(hand, 5, unseen);
    for (const o of options) if (o.shanten === 0) expect(o.acceptance).toBeGreaterThan(0);
    const nineP = options.find((o) => o.kind === kindFromCode('9p'))!;
    expect(nineP.shanten).toBe(1);
    expect(nineP.accepts).toContain(kindFromCode('2s'));
    expect(nineP.accepts).toContain(kindFromCode('3s'));
    const oneS = options.find((o) => o.kind === kindFromCode('1s'))!;
    expect(oneS.shanten).toBe(0);
    expect(kindsToString(oneS.accepts)).toBe('9p');
  });
});
