/**
 * Rules of thumb a player might use on a discard puzzle, written here apart from the generator's own
 * `ruleOfThumbPicks` (src/puzzles.ts): only `countsFromKinds` and `shanten` come from the engine. Each
 * rule takes the 17-tile hand and names the tile it would throw. `test/puzzle_rules.test.ts` measures how
 * often each is an accepted answer on fixed seed sets, against random guessing.
 *
 * The first four are the seventh assessment's (`assess7/engine/rules.ts`), the fifth its challenger's
 * (`assess7/engine_c/conn.ts`); the rest were added when the generator was changed, to see whether
 * redrawing against the first five only moved the answers to where another simple rule finds them.
 */
import { countsFromKinds, shanten } from '../../src/index';

export type Hand = readonly number[];
export type DiscardRule = (hand: Hand) => number;

const counts = (hand: Hand): number[] => countsFromKinds(hand);
const kindsOf = (hand: Hand): number[] => [...new Set(hand)].sort((a, b) => a - b);
/** Honours first, then the outermost suited tile (terminals, then 2s and 8s ...), then the lowest kind. */
const outerFirst = (a: number, b: number): number => (b >= 27 ? 1 : 0) - (a >= 27 ? 1 : 0) || Math.abs(4 - (b % 9)) - Math.abs(4 - (a % 9)) || a - b;
const near = (c: number[], k: number, d: number): boolean => {
  if (k >= 27) return false;
  const r = k % 9;
  return r + d >= 0 && r + d <= 8 && c[k + d] > 0;
};
/** Extra copies count 3, a neighbour one rank away 2, one two ranks away 1 (the assessor's weights). */
const neighbours = (c: number[], k: number): number => {
  let s = (c[k] - 1) * 3;
  for (const d of [-2, -1, 1, 2]) if (near(c, k, d)) s += Math.abs(d) === 1 ? 2 : 1;
  return s;
};
const shantenAfter = (c: number[], k: number): number => {
  c[k]--;
  const s = shanten(c, 5);
  c[k]++;
  return s;
};
const isolated = (c: number[], k: number): boolean => c[k] === 1 && ![-2, -1, 1, 2].some((d) => near(c, k, d));

/** The team's isolated-tile rule: a single with no neighbour within two in its suit, honours first. */
export const isolatedTileRule: DiscardRule = (hand) => {
  const c = counts(hand);
  return (
    kindsOf(hand)
      .filter((k) => isolated(c, k))
      .sort(outerFirst)[0] ?? -1
  );
};

/** "The tile with the fewest neighbours", honours then terminals on a tie (the assessor's). */
export const fewestNeighbours: DiscardRule = (hand) => {
  const c = counts(hand);
  return kindsOf(hand).sort((a, b) => neighbours(c, a) - neighbours(c, b) || outerFirst(a, b))[0];
};

/** An isolated tile; else the outer tile of an edge (1-2, 8-9) or closed (1-3) 搭子; else the fewest neighbours (the assessor's). */
export const edgeFirst: DiscardRule = (hand) => {
  const lone = isolatedTileRule(hand);
  if (lone >= 0) return lone;
  const c = counts(hand);
  const weak: number[] = [];
  for (let k = 0; k < 27; k++) {
    if (c[k] !== 1) continue;
    const r = k % 9;
    const h = (d: number) => near(c, k, d);
    if ((r === 0 && h(1) && !h(2)) || (r === 8 && h(-1) && !h(-2))) weak.push(k);
    else if ((h(2) && !h(1) && !h(-1) && !h(-2) && !h(3)) || (h(-2) && !h(-1) && !h(1) && !h(2) && !h(-3))) weak.push(k);
  }
  return weak.sort(outerFirst)[0] ?? fewestNeighbours(hand);
};

/** "Fewest steps to ready, then the fewest neighbours" (the assessor's greedy rule). */
export const fewestStepsThenNeighbours: DiscardRule = (hand) => {
  const c = counts(hand);
  const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
  return kindsOf(hand).sort((a, b) => sh.get(a)! - sh.get(b)! || neighbours(c, a) - neighbours(c, b) || outerFirst(a, b))[0];
};

/** "The least connected tile": same-suit tiles within two ranks, two per extra copy; honours, then the outermost, on a tie (the challenger's). */
export const leastConnected: DiscardRule = (hand) => {
  const c = counts(hand);
  const links = (k: number) => {
    let n = 2 * (c[k] - 1);
    if (k < 27) for (let d = -2; d <= 2; d++) if (d !== 0 && near(c, k, d)) n += c[k + d] * (Math.abs(d) === 1 ? 1.01 : 1);
    return n;
  };
  let best = -1;
  let score = Infinity;
  for (let k = 0; k < 34; k++) {
    if (!c[k]) continue;
    const s = links(k) * 100 - (k >= 27 ? 50 : 0) - Math.abs(4 - (k % 9));
    if (s < score) {
      score = s;
      best = k;
    }
  }
  return best;
};

/** "Throw an isolated tile; else break the weakest 搭子 (an edge 1-2 or 8-9, then a closed 1-3), never a pair; else the single with the fewest neighbours". */
export const weakestPartialFirst: DiscardRule = (hand) => {
  const lone = isolatedTileRule(hand);
  if (lone >= 0) return lone;
  const c = counts(hand);
  const edge: number[] = [];
  const closed: number[] = [];
  for (let k = 0; k < 27; k++) {
    if (c[k] !== 1) continue;
    const r = k % 9;
    const h = (d: number) => near(c, k, d);
    if ((r === 0 && h(1) && !h(2)) || (r === 8 && h(-1) && !h(-2))) edge.push(k);
    else if ((r === 1 && h(-1) && c[k - 1] === 1 && !h(1) && !h(2)) || (r === 7 && h(1) && c[k + 1] === 1 && !h(-1) && !h(-2))) edge.push(k);
    else if (!h(1) && !h(-1) && ((h(2) && !h(-2) && !h(3) && c[k + 2] === 1) || (h(-2) && !h(2) && !h(-3) && c[k - 2] === 1))) closed.push(k);
  }
  const pick = edge.sort(outerFirst)[0] ?? closed.sort(outerFirst)[0];
  if (pick !== undefined) return pick;
  const singles = kindsOf(hand).filter((k) => c[k] === 1);
  return singles.length ? singles.sort((a, b) => neighbours(c, a) - neighbours(c, b) || outerFirst(a, b))[0] : fewestNeighbours(hand);
};

/** "Keep every pair, then the tile with the fewest neighbours". */
export const keepPairsThenNeighbours: DiscardRule = (hand) => {
  const c = counts(hand);
  const singles = kindsOf(hand).filter((k) => c[k] === 1);
  return singles.length ? singles.sort((a, b) => neighbours(c, a) - neighbours(c, b) || outerFirst(a, b))[0] : fewestNeighbours(hand);
};

/** "Fewest steps to ready, then honours and terminals first" (no neighbour count). */
export const fewestStepsThenOutermost: DiscardRule = (hand) => {
  const c = counts(hand);
  const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
  return kindsOf(hand).sort((a, b) => sh.get(a)! - sh.get(b)! || outerFirst(a, b))[0];
};

/** "The tile the fewest unseen tiles would join": unseen copies of it and of the kinds within two of it in its suit. */
export const fewestJoiners: DiscardRule = (hand) => {
  const c = counts(hand);
  const joiners = (k: number) => {
    let n = 4 - c[k];
    if (k < 27) for (const d of [-2, -1, 1, 2]) if ((k % 9) + d >= 0 && (k % 9) + d <= 8) n += 4 - c[k + d];
    return n + 10 * (c[k] - 1);
  };
  return kindsOf(hand).sort((a, b) => joiners(a) - joiners(b) || outerFirst(a, b))[0];
};

/** "Break a pair when you hold two or more (the one with the fewest neighbours), else the fewest neighbours". */
export const breakPairFirst: DiscardRule = (hand) => {
  const c = counts(hand);
  const pairs = kindsOf(hand).filter((k) => c[k] === 2);
  if (pairs.length < 2) return fewestNeighbours(hand);
  return pairs.sort((a, b) => neighbours(c, a) - neighbours(c, b) || outerFirst(a, b))[0];
};

/** "Fewest steps to ready; then break a pair when you hold two or more; then the fewest neighbours". */
export const fewestStepsThenPairs: DiscardRule = (hand) => {
  const c = counts(hand);
  const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
  const many = kindsOf(hand).filter((k) => c[k] === 2).length >= 2;
  const pairFirst = (k: number) => (many && c[k] === 2 ? 0 : 1);
  const links = (k: number) => neighbours(c, k) - (c[k] - 1) * 3;
  return kindsOf(hand).sort((a, b) => sh.get(a)! - sh.get(b)! || pairFirst(a) - pairFirst(b) || links(a) - links(b) || outerFirst(a, b))[0];
};

/**
 * "Fewest steps to ready; then break a pair when you hold two or more; then the tile with the most
 * neighbours": the opposite end. A generator that only redrew hands where the least connected tile is
 * right would leave this one right on about half.
 */
export const fewestStepsThenMostConnectedPair: DiscardRule = (hand) => {
  const c = counts(hand);
  const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
  const many = kindsOf(hand).filter((k) => c[k] === 2).length >= 2;
  const pairFirst = (k: number) => (many && c[k] === 2 ? 0 : 1);
  const links = (k: number) => neighbours(c, k) - (c[k] - 1) * 3;
  return kindsOf(hand).sort((a, b) => sh.get(a)! - sh.get(b)! || pairFirst(a) - pairFirst(b) || links(b) - links(a) || a - b)[0];
};

/** "Fewest steps to ready, then the tile with the most neighbours". */
export const fewestStepsThenMostNeighbours: DiscardRule = (hand) => {
  const c = counts(hand);
  const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
  const links = (k: number) => neighbours(c, k) - (c[k] - 1) * 3;
  return kindsOf(hand).sort((a, b) => sh.get(a)! - sh.get(b)! || links(b) - links(a) || a - b)[0];
};

/**
 * "The obvious tile is a trap": the second choice of the fewest-steps-then-neighbours rule. A generator
 * that only redraws hands the first choice answers would leave this one right most of the time.
 */
export const secondChoice: DiscardRule = (hand) => {
  const c = counts(hand);
  const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
  const order = kindsOf(hand).sort((a, b) => sh.get(a)! - sh.get(b)! || neighbours(c, a) - neighbours(c, b) || outerFirst(a, b));
  return order[1] ?? order[0];
};

/** The rules above that throw the most obvious tile (each picks one). */
const OBVIOUS_RULES: readonly DiscardRule[] = [isolatedTileRule, fewestNeighbours, edgeFirst, fewestStepsThenNeighbours, leastConnected, weakestPartialFirst, keepPairsThenNeighbours, fewestStepsThenOutermost, fewestJoiners];

/**
 * "Avoid the obvious tile": fewest steps to ready, skip every tile one of the obvious rules above would throw,
 * then the fewest neighbours (the eighth assessment's challenger: right on 52% of hard puzzles when every
 * obvious tile was made wrong). Written apart from the generator, as the rest of this file.
 */
export const avoidTheObvious: DiscardRule = (hand) => {
  const c = counts(hand);
  const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
  const best = Math.min(...sh.values());
  const obvious = new Set(OBVIOUS_RULES.map((rule) => rule(hand)));
  const keep = kindsOf(hand).filter((k) => sh.get(k) === best);
  const rest = keep.filter((k) => !obvious.has(k));
  return (rest.length > 0 ? rest : keep).sort((a, b) => neighbours(c, a) - neighbours(c, b) || outerFirst(a, b))[0];
};

/** Tiles held of the kind's suit, the honours counting as one group. */
const groupCount = (c: number[], k: number): number => {
  const [from, to] = k >= 27 ? [27, 34] : [k - (k % 9), k - (k % 9) + 9];
  let n = 0;
  for (let i = from; i < to; i++) n += c[i];
  return n;
};

/**
 * "The spare tile" (unit 21's check of the learning track, right on about half the hard puzzles before the generator
 * placed it): fewest steps to ready; then from the suit (honours as one group) whose tile count is one over a multiple
 * of three; there the fewest kinds next to it (`reach`: one rank away, or one or two); then the tile nearer the middle.
 * `most` throws the one with the most instead (the spare tile's opposite). Written apart from the generator.
 */
export function spareTile(reach: 1 | 2, most = false): DiscardRule {
  return (hand) => {
    const c = counts(hand);
    const sh = new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)]));
    const best = Math.min(...sh.values());
    const spare = (k: number) => (groupCount(c, k) % 3 === 1 ? 0 : 1);
    const kinds = (k: number) => [-2, -1, 1, 2].filter((d) => Math.abs(d) <= reach && near(c, k, d)).length;
    const middle = (k: number) => (k >= 27 ? 9 : Math.abs(4 - (k % 9)));
    const keep = kindsOf(hand).filter((k) => sh.get(k) === best);
    return keep.sort((a, b) => spare(a) - spare(b) || (most ? kinds(b) - kinds(a) : kinds(a) - kinds(b)) || middle(a) - middle(b) || a - b)[0];
  };
}

/** Every rule measured, by the name the test reports. */
export const DISCARD_RULES: Readonly<Record<string, DiscardRule>> = {
  isolatedTile: isolatedTileRule,
  fewestNeighbours,
  edgeFirst,
  fewestStepsThenNeighbours,
  leastConnected,
  weakestPartialFirst,
  keepPairsThenNeighbours,
  fewestStepsThenOutermost,
  fewestJoiners,
  breakPairFirst,
  fewestStepsThenPairs,
  fewestStepsThenMostConnectedPair,
  fewestStepsThenMostNeighbours,
  secondChoice,
  avoidTheObvious,
  spareTile: spareTile(2),
  spareTileNextOnly: spareTile(1),
  spareTileMostNeighbours: spareTile(2, true),
};

/**
 * "The tile with the fewest neighbours" with other weights: extra copies, kinds one rank away and kinds
 * two ranks away weighted as given, honours then terminals on a tie, with or without first keeping the
 * fewest steps to ready. However a player weighs connections, the puzzles should not give way.
 */
export function neighbourWeightRules(): Record<string, DiscardRule> {
  const out: Record<string, DiscardRule> = {};
  for (const [wc, wa, wg] of [
    [3, 2, 1],
    [2, 1, 1],
    [1, 1, 1],
    [4, 2, 1],
    [2, 2, 1],
    [1, 1, 0],
    [2, 1, 0],
    [3, 3, 2],
  ]) {
    for (const stepsFirst of [false, true]) {
      out[`weights ${wc}-${wa}-${wg}${stepsFirst ? ' after steps' : ''}`] = (hand) => {
        const c = counts(hand);
        const score = (k: number) => (c[k] - 1) * wc + [-2, -1, 1, 2].reduce((n, d) => n + (near(c, k, d) ? (Math.abs(d) === 1 ? wa : wg) : 0), 0);
        const sh = stepsFirst ? new Map(kindsOf(hand).map((k) => [k, shantenAfter(c, k)])) : null;
        return kindsOf(hand).sort((a, b) => (sh ? sh.get(a)! - sh.get(b)! : 0) || score(a) - score(b) || outerFirst(a, b))[0];
      };
    }
  }
  return out;
}

/** What is left of the hand once complete sets are taken out: pongs first, then runs from the low end of each suit; runs first, then pongs; or the way that takes out the most sets. */
function setsLeft(hand: Hand, read: 'pongs' | 'runs' | 'most'): number[] {
  const c = counts(hand);
  const pongs = () => {
    for (let k = 0; k < 34; k++) while (c[k] >= 3) c[k] -= 3;
  };
  const runs = () => {
    for (let k = 0; k < 27; k++) {
      while (k % 9 <= 6 && c[k] > 0 && c[k + 1] > 0 && c[k + 2] > 0) {
        c[k]--;
        c[k + 1]--;
        c[k + 2]--;
      }
    }
  };
  if (read !== 'most') {
    if (read === 'pongs') pongs();
    runs();
    if (read === 'runs') pongs();
    return c;
  }
  // Every way through the hand, low kinds first: a pong, a run or a leftover at each step.
  const left = new Array<number>(34).fill(0);
  let best = c.slice();
  let most = -1;
  const walk = (k: number, sets: number) => {
    while (k < 34 && c[k] === 0) k++;
    if (k === 34) {
      if (sets > most) [most, best] = [sets, left.slice()];
      return;
    }
    if (c[k] >= 3) {
      c[k] -= 3;
      walk(k, sets + 1);
      c[k] += 3;
    }
    if (k < 27 && k % 9 <= 6 && c[k + 1] > 0 && c[k + 2] > 0) {
      c[k]--;
      c[k + 1]--;
      c[k + 2]--;
      walk(k, sets + 1);
      c[k]++;
      c[k + 1]++;
      c[k + 2]++;
    }
    c[k]--;
    left[k]++;
    walk(k, sets);
    c[k]++;
    left[k]--;
  };
  walk(0, 0);
  return best;
}

/**
 * "Take out your complete sets, then throw the leftover tile with the fewest neighbours" (the seventh
 * pass's engine checker): the sets taken out pongs first, runs first or the most sets; neighbours counted
 * among the leftovers only, extra copies, kinds one rank away and kinds two ranks away weighted as given;
 * honours then terminals on a tie; with or without first keeping the fewest steps to ready. One of a pair
 * inside a run (the 2 of 2234) is a leftover single to this read, which the whole-hand counts never make it.
 */
export function setsFirstRules(): Record<string, DiscardRule> {
  const out: Record<string, DiscardRule> = {};
  for (const read of ['pongs', 'runs', 'most'] as const) {
    for (const [wc, wa, wg] of [
      [3, 2, 1],
      [1, 1, 1],
    ]) {
      for (const stepsFirst of [false, true]) {
        out[`sets first (${read}) ${wc}-${wa}-${wg}${stepsFirst ? ' after steps' : ''}`] = (hand) => {
          const left = setsLeft(hand, read);
          const pool = kindsOf(hand).filter((k) => left[k] > 0);
          const from = pool.length > 0 ? pool : kindsOf(hand);
          const c = pool.length > 0 ? left : counts(hand);
          const all = counts(hand);
          const score = (k: number) => (c[k] - 1) * wc + [-2, -1, 1, 2].reduce((n, d) => n + (near(c, k, d) ? (Math.abs(d) === 1 ? wa : wg) : 0), 0);
          const sh = stepsFirst ? new Map(from.map((k) => [k, shantenAfter(all, k)])) : null;
          return from.sort((a, b) => (sh ? sh.get(a)! - sh.get(b)! : 0) || score(a) - score(b) || outerFirst(a, b))[0];
        };
      }
    }
  }
  return out;
}
