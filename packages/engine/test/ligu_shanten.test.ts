/**
 * The 嚦咕嚦咕 distance to ready (`liguShanten`) against a brute-force enumerator of every target
 * (seven pairs and a triplet) on thousands of random hands, against the exchange definition of the
 * distance, and against the engine's own waits and winning test.
 */
import { describe, expect, it } from 'vitest';
import { bestShanten, countsFromKinds, createRng, isLiguShape, kindsFromString, liguShanten, NUM_PLAY_KINDS, shanten, waits, type Counts } from '../src/index';

/** Largest number of tiles a target of seven pairs and one triplet (different kinds) shares with the hand. */
function bruteOverlap(counts: Counts): number {
  const held: number[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) if (counts[k] > 0) held.push(counts[k]);
  let best = 0;
  // Each held kind is left out, a pair or the triplet; kinds not held fill the rest and share nothing.
  const walk = (i: number, pairs: number, triplets: number, overlap: number): void => {
    if (overlap + 3 * (held.length - i) <= best) return;
    if (i === held.length) {
      best = Math.max(best, overlap);
      return;
    }
    walk(i + 1, pairs, triplets, overlap);
    if (pairs < 7) walk(i + 1, pairs + 1, triplets, overlap + Math.min(held[i], 2));
    if (triplets < 1) walk(i + 1, pairs, triplets + 1, overlap + Math.min(held[i], 3));
  };
  walk(0, 0, 0, 0);
  return best;
}
const brute = (counts: Counts): number => 16 - bruteOverlap(counts);

/**
 * A random hand of `n` tiles, by `mode`: 0 from the full wall; 1 with kinds drawn from a few, so that
 * pairs and triplets are common; 2 a random 嚦咕嚦咕 with a few of its tiles swapped for random ones.
 */
function randomHand(rng: ReturnType<typeof createRng>, n: number, mode: number): Counts {
  const c = new Array<number>(NUM_PLAY_KINDS).fill(0);
  const add = (k: number): boolean => (c[k] < 4 ? (c[k]++, true) : false);
  let placed = 0;
  if (mode === 2) {
    const kinds: number[] = [];
    while (kinds.length < 8) {
      const k = rng.int(NUM_PLAY_KINDS);
      if (!kinds.includes(k)) kinds.push(k);
    }
    kinds.forEach((k, i) => (c[k] = i === 0 ? 3 : 2));
    const dropOne = (): void => {
      const held = c.flatMap((x, k) => (x > 0 ? [k] : []));
      c[held[rng.int(held.length)]]--;
    };
    for (let swaps = rng.int(5); swaps > 0; swaps--) {
      dropOne();
      while (!add(rng.int(NUM_PLAY_KINDS)));
    }
    if (n === 16) dropOne();
    return c;
  }
  const pool = mode === 1 ? Array.from({ length: 6 + rng.int(8) }, () => rng.int(NUM_PLAY_KINDS)) : null;
  while (placed < n) {
    const k = pool ? pool[rng.int(pool.length)] : rng.int(NUM_PLAY_KINDS);
    if (!add(k)) {
      if (pool) pool.push(rng.int(NUM_PLAY_KINDS));
      continue;
    }
    placed++;
  }
  return c;
}

describe('嚦咕嚦咕 distance to ready', () => {
  it('matches a brute-force enumeration of every target on 6,000 random hands of 16 and 17 tiles', () => {
    const rng = createRng('ligu-shanten-brute');
    const seen = new Set<number>();
    for (let i = 0; i < 6000; i++) {
      const c = randomHand(rng, i % 2 === 0 ? 16 : 17, i % 3);
      const d = liguShanten(c);
      expect(d).toBe(brute(c));
      seen.add(d);
    }
    // Every distance from complete (-1) to far away turned up.
    for (const d of [-1, 0, 1, 2, 3, 4, 5, 6]) expect(seen.has(d)).toBe(true);
  });

  it('is the exchange distance: a 16-tile hand d from ready has an exchange to d − 1 and none below it', () => {
    const rng = createRng('ligu-shanten-exchange');
    for (let i = 0; i < 1500; i++) {
      const c = randomHand(rng, 16, i % 3);
      const d = liguShanten(c);
      let bestAfter = Infinity;
      for (let out = 0; out < NUM_PLAY_KINDS; out++) {
        if (c[out] === 0) continue;
        c[out]--;
        for (let draw = 0; draw < NUM_PLAY_KINDS; draw++) {
          if (draw === out || c[draw] >= 4) continue;
          c[draw]++;
          bestAfter = Math.min(bestAfter, liguShanten(c));
          c[draw]--;
        }
        c[out]++;
      }
      if (d > 0) expect(bestAfter).toBe(d - 1);
      else expect(bestAfter).toBeGreaterThanOrEqual(0);
    }
  });

  it('agrees with the engine: ready exactly when 嚦咕嚦咕 has a winning tile, complete exactly on the shape', () => {
    const rng = createRng('ligu-shanten-waits');
    let ready = 0;
    let complete = 0;
    for (let i = 0; i < 4000; i++) {
      const c = randomHand(rng, 16, 1 + (i % 2));
      const liguWaits = waits(c, 5, undefined, true).filter((k) => {
        c[k]++;
        const won = isLiguShape(c, 5);
        c[k]--;
        return won;
      });
      expect(liguShanten(c) === 0).toBe(liguWaits.length > 0);
      if (liguWaits.length > 0) ready++;
      for (const k of liguWaits) {
        c[k]++;
        expect(liguShanten(c)).toBe(-1);
        complete++;
        c[k]--;
      }
    }
    expect(ready).toBeGreaterThan(50);
    expect(complete).toBeGreaterThan(50);
  });

  it('reads the named shapes as a player would', () => {
    const c = (s: string) => countsFromKinds(kindsFromString(s));
    expect(liguShanten(c('11m 22m 33p 55p 77s 99s 44s EE'))).toBe(0); // eight pairs: any of them makes the triplet
    expect(liguShanten(c('11m 22m 33p 55p 77s 99s 444s E'))).toBe(0); // six pairs, a triplet and a single
    expect(liguShanten(c('11m 22m 33p 55p 77s 99s 444s EE'))).toBe(-1);
    // Four of a kind is never two pairs: 1111m with six pairs is one exchange away, not ready.
    expect(liguShanten(c('1111m 33p 55p 77s 99s 44s EE'))).toBe(1);
    // Five pairs and six singles: the target shares 13 tiles (five pairs and three singles), so three exchanges.
    expect(liguShanten(c('11m 33p 55p 77s 99s 2m 4m 6p 8p 1s E'))).toBe(3);
  });

  it('bestShanten takes the smaller distance only when the table plays 嚦咕嚦咕 and the hand has no melds', () => {
    const eightPairs = countsFromKinds(kindsFromString('11m 22m 33p 55p 77s 99s 44s EE'));
    expect(shanten(eightPairs, 5)).toBeGreaterThan(0);
    expect(bestShanten(eightPairs, 5, false)).toBe(shanten(eightPairs, 5));
    expect(bestShanten(eightPairs, 5, true)).toBe(0);
    const melded = countsFromKinds(kindsFromString('11m 22m 33p 55p 77s 99s 4s'));
    expect(bestShanten(melded, 4, true)).toBe(shanten(melded, 4));
    expect(() => liguShanten(melded)).toThrow(/expected 16 or 17/);
  });
});
