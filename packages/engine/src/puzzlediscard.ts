/**
 * Discard puzzles (from puzzles.ts): which tile to throw to keep the hand closest to ready (tile efficiency). A seeded
 * hand, every accepted answer (ties within a tenth of the best's acceptance), the decision the puzzle turns on, and, at
 * medium and hard and in the daily, the answer placed at a depth the rules of thumb reach late (`ANSWER_DEPTH_SHARE`).
 */
import { countsFromKinds, discardOptions, kindsFromCounts, shanten, TOTAL_SETS, type Counts } from './hand';
import { createRng, shuffle, type Rng } from './rng';
import { KIND_WIND, NUM_PLAY_KINDS, type Kind } from './tiles';
import { acceptanceAfter, tileEn, tilesEn, tileZh, type PuzzleExplanation } from './puzzletable';

export interface DiscardPuzzle {
  type: 'discard';
  seed: string;
  /** 17 concealed tiles (kinds), sorted. */
  hand: Kind[];
  /** Kinds that count as a correct answer (ties within 10% acceptance). */
  answers: Kind[];
  best: Kind;
  bestShanten: number;
  bestAcceptance: number;
  currentShanten: number;
  /** Per-kind analysis for explanations. */
  options: Array<{ kind: Kind; shanten: number; acceptance: number; accepts: Kind[] }>;
  /** The decision the puzzle turns on (`puzzle.discard.*`, see DISCARD_DECISIONS), named after the answer. */
  reasonKey: string;
  explanation: string;
  explanationZh: string;
}

function randomHand(rng: Rng, maxShanten: number, minShanten = 0, accept?: (hand: Kind[]) => boolean): Kind[] {
  for (let attempt = 0; attempt < 500; attempt++) {
    const pool: Kind[] = [];
    for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let c = 0; c < 4; c++) pool.push(k);
    shuffle(pool, rng);
    const hand = pool.slice(0, 17).sort((a, b) => a - b);
    if (accept && !accept(hand)) continue;
    const sh = shanten(countsFromKinds(hand), 5);
    if (sh <= maxShanten && sh >= minShanten) return hand;
  }
  return [];
}

/**
 * The share of shape-reading discard puzzles (the daily, medium and hard) that may still hold an
 * isolated honour, so "throw the lone honour first" stays right now and then, as it is in play.
 */
export const LONE_HONOUR_PUZZLE_SHARE = 0.1;

/** The honour kinds the hand holds exactly one of: throwing one is almost always an accepted answer. */
export function loneHonours(hand: readonly Kind[]): Kind[] {
  const counts = countsFromKinds(hand);
  const lone: Kind[] = [];
  for (let k = KIND_WIND; k < NUM_PLAY_KINDS; k++) if (counts[k] === 1) lone.push(k);
  return lone;
}

export interface DiscardPuzzleOptions {
  /**
   * Draw a hand that needs reading its shape: no isolated honour, except in a share
   * (LONE_HONOUR_PUZZLE_SHARE) of seeds. On by default at medium and hard; the daily puzzle turns it on
   * at every difficulty. Easy drills keep the beginner's lesson of throwing the lone honour first.
   */
  readShape?: boolean;
  /**
   * Without `deep`: the share of shape-reading seeds whose hand may still be answered by the isolated-tile
   * rule (`isolatedTile`); the rest are redrawn until the rule's tile is not an accepted answer.
   * Defaults to ISOLATED_TILE_PUZZLE_SHARE for the difficulty.
   */
  isolatedTileShare?: number;
  /**
   * Place the answer at a depth the seed draws among the tiles rules of thumb throw first
   * (ANSWER_DEPTH_SHARE). On by default at medium and hard; the daily turns it on at every difficulty.
   */
  deep?: boolean;
}

/**
 * The share of shape-reading seeds that may still be answered by "throw an isolated tile, honours first,
 * then terminals, then the outermost" when a puzzle is not `deep` (no generator default uses that now:
 * medium and hard drills and the daily place the answer by depth). Easy puzzles (1) are not redrawn.
 */
export const ISOLATED_TILE_PUZZLE_SHARE: Record<1 | 2 | 3, number> = { 1: 1, 2: 0.6, 3: 0.3 };

/**
 * Medium and hard discard puzzles and the daily (at every difficulty) place the answer by the seed. A rule of
 * thumb throws the tiles that keep the hand closest to ready in an order of its own (`obviousOrders`: the
 * fewest neighbours by any weighting, by kinds or by tiles; the outermost tile or single; the spare tile, from
 * the suit holding one over a multiple of three; and the fewest neighbours among the tiles left over once
 * complete sets are taken out, read three ways). The answer's depth
 * is the earliest any of those orders reaches an accepted answer: 0 when some rule's first pick is right.
 * Each seed draws the depth from these shares: 0, 1, or 2 and later (2 also off the first pick of
 * `connectedOrders`: the most connected tile, "break the pair with the most neighbours", and two more).
 *
 * The obvious tile was right on nearly every natural hand, and the rule-proof hands of 18 to 20 November
 * 2026, where no rule's first pick was right, made "avoid the obvious tile" a rule of its own (right on 52%
 * of hard puzzles). With the depth drawn, a rule's first pick is right on about a third, the second pick and
 * the most connected tile on fewer, and no measured rule on more than 45% of hard puzzles and of medium and
 * hard dailies, 50% of medium drills and 60% of easy dailies (test/puzzle_rules.test.ts, docs/ARCHITECTURE.md).
 */
export const ANSWER_DEPTH_SHARE: readonly number[] = [1 / 3, 1 / 3, 1 / 3];
/** A depth-placed puzzle has at least this many discards that keep the hand closest to ready, and two for each accepted one. */
export const BEST_DISCARDS_MIN = 3;
/** The options the daily puzzle is generated with (`dailyPuzzle`), for callers that rebuild it by hand. */
export const DAILY_DISCARD_OPTIONS: Readonly<DiscardPuzzleOptions> = { readShape: true, deep: true };
/** Steps of the walk towards the seed's depth before settling for the nearest hand: bounds the time a puzzle takes. */
const ANSWER_DEPTH_STEPS = 300;

/** True when the suited tile has no other tile of its suit within two ranks (honours have none). */
function hasNoNeighbour(counts: Counts, k: Kind): boolean {
  if (k >= KIND_WIND) return true;
  const r = k % 9;
  for (let d = -2; d <= 2; d++) if (d !== 0 && r + d >= 0 && r + d <= 8 && counts[k + d] > 0) return false;
  return true;
}

/**
 * The tile the isolated-tile rule throws: a single tile with no neighbour within two in its suit,
 * honours first, then terminals, then the outermost (lowest kind on a tie); null when there is none.
 */
export function isolatedTile(hand: readonly Kind[]): Kind | null {
  const counts = countsFromKinds(hand);
  let pick: Kind | null = null;
  let pickScore = -1;
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (counts[k] !== 1 || !hasNoNeighbour(counts, k)) continue;
    // Honours rank above every suited tile; within each group the same arithmetic as for ranks (as the measuring probe sorts).
    const score = (k >= KIND_WIND ? 10 : 0) + Math.abs(4 - (k % 9));
    if (score > pickScore) {
      pick = k;
      pickScore = score;
    }
  }
  return pick;
}

/** What a rule of thumb sees of one held kind: the shanten after throwing it, its copies, its neighbours and how far out it sits. */
interface HeldKind {
  kind: Kind;
  shanten: number;
  copies: number;
  /** Kinds held one rank away in its suit (0 to 2), and the tiles of them. */
  nextKinds: number;
  nextTiles: number;
  /** Kinds held two ranks away in its suit (0 to 2), and the tiles of them. */
  gapKinds: number;
  gapTiles: number;
  /** 0 for an honour, 1 for a terminal, 2 for a 2 or an 8, up to 5 for a 5. */
  position: number;
}

/** Tiles held of the kind's suit, all honours counting as one group. */
function groupTiles(counts: Counts, kind: Kind): number {
  const [from, to] = kind >= KIND_WIND ? [KIND_WIND, NUM_PLAY_KINDS] : [kind - (kind % 9), kind - (kind % 9) + 9];
  let n = 0;
  for (let k = from; k < to; k++) n += counts[k];
  return n;
}

function heldKinds(counts: Counts): HeldKind[] {
  const out: HeldKind[] = [];
  const c = counts.slice();
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (c[k] === 0) continue;
    let nextKinds = 0;
    let nextTiles = 0;
    let gapKinds = 0;
    let gapTiles = 0;
    if (k < KIND_WIND) {
      const r = k % 9;
      for (const d of [-2, -1, 1, 2]) {
        if (r + d < 0 || r + d > 8 || c[k + d] === 0) continue;
        if (Math.abs(d) === 1) {
          nextKinds++;
          nextTiles += c[k + d];
        } else {
          gapKinds++;
          gapTiles += c[k + d];
        }
      }
    }
    c[k]--;
    const sh = shanten(c, TOTAL_SETS);
    c[k]++;
    out.push({ kind: k, shanten: sh, copies: c[k], nextKinds, nextTiles, gapKinds, gapTiles, position: k >= KIND_WIND ? 0 : 5 - Math.abs(4 - (k % 9)) });
  }
  return out;
}

/** The kinds in `set` that no other kind beats on every count of `key` (fewer or equal on each, fewer on one). */
function leastOnEveryCount(set: readonly HeldKind[], key: (h: HeldKind) => readonly number[]): Kind[] {
  const keys = set.map(key);
  const beats = (x: readonly number[], y: readonly number[]) => x.every((v, i) => v <= y[i]) && x.some((v, i) => v < y[i]);
  return set.filter((_, i) => !keys.some((other, j) => j !== i && beats(other, keys[i]))).map((h) => h.kind);
}

/**
 * What is left of a hand once complete sets are taken out: pongs first and then runs from the low end of
 * each suit, or runs first and then pongs (a beginner's read), or the way that takes out the most sets
 * (the first such found, low kinds first). Leftover tiles per kind.
 */
function leftAfterSets(counts: Counts, read: (typeof SET_READS)[number]): Counts {
  const c = counts.slice();
  const pongs = () => {
    for (let k = 0; k < NUM_PLAY_KINDS; k++) while (c[k] >= 3) c[k] -= 3;
  };
  const runs = () => {
    for (let k = 0; k < KIND_WIND; k++) {
      while (k % 9 <= 6 && c[k] > 0 && c[k + 1] > 0 && c[k + 2] > 0) {
        c[k]--;
        c[k + 1]--;
        c[k + 2]--;
      }
    }
  };
  if (read === 'pongsFirst') {
    pongs();
    runs();
    return c;
  }
  if (read === 'runsFirst') {
    runs();
    pongs();
    return c;
  }
  const left = new Array<number>(NUM_PLAY_KINDS).fill(0);
  let best: Counts = c.slice();
  let most = -1;
  let tiles = c.reduce((a, b) => a + b, 0);
  const search = (k: number, sets: number) => {
    // No way on from here takes out more sets than the most found so far.
    if (sets + Math.floor(tiles / 3) <= most) return;
    while (k < NUM_PLAY_KINDS && c[k] === 0) k++;
    if (k >= NUM_PLAY_KINDS) {
      if (sets > most) {
        most = sets;
        best = left.slice();
      }
      return;
    }
    tiles -= 3;
    if (c[k] >= 3) {
      c[k] -= 3;
      search(k, sets + 1);
      c[k] += 3;
    }
    if (k < KIND_WIND && k % 9 <= 6 && c[k + 1] > 0 && c[k + 2] > 0) {
      c[k]--;
      c[k + 1]--;
      c[k + 2]--;
      search(k, sets + 1);
      c[k]++;
      c[k + 1]++;
      c[k + 2]++;
    }
    tiles += 2;
    c[k]--;
    left[k]++;
    search(k, sets);
    c[k]++;
    left[k]--;
    tiles += 1;
  };
  search(0, 0);
  return best;
}

/** The held kinds left over in `left`, each with its shanten in the whole hand and its copies and neighbours counted among the leftovers only. */
function leftoverKinds(held: readonly HeldKind[], left: Counts): HeldKind[] {
  const out: HeldKind[] = [];
  for (const h of held) {
    const k = h.kind;
    if (left[k] === 0) continue;
    let nextKinds = 0;
    let nextTiles = 0;
    let gapKinds = 0;
    let gapTiles = 0;
    if (k < KIND_WIND) {
      const r = k % 9;
      for (const d of [-2, -1, 1, 2]) {
        if (r + d < 0 || r + d > 8 || left[k + d] === 0) continue;
        if (Math.abs(d) === 1) {
          nextKinds++;
          nextTiles += left[k + d];
        } else {
          gapKinds++;
          gapTiles += left[k + d];
        }
      }
    }
    out.push({ ...h, copies: left[k], nextKinds, nextTiles, gapKinds, gapTiles });
  }
  return out;
}

/** The ways of taking out complete sets that the sets-first reads use (`leftAfterSets`). */
const SET_READS = ['pongsFirst', 'runsFirst', 'mostSets'] as const;

function ruleOfThumbPicksOf(held: readonly HeldKind[], withSets = false): Set<Kind> {
  const out = new Set<Kind>();
  const counts = new Array<number>(NUM_PLAY_KINDS).fill(0);
  for (const h of held) counts[h.kind] = h.copies;
  // The whole hand, and what is left once complete sets are taken out (each way a player might read them).
  const views = [held, ...(withSets ? SET_READS.map((read) => leftoverKinds(held, leftAfterSets(counts, read))) : [])];
  for (const view of views) {
    if (view.length === 0) continue;
    const best = Math.min(...view.map((h) => h.shanten));
    for (const set of [view, view.filter((h) => h.shanten === best)]) {
      // The least connected tile, however a rule counts neighbours: by kinds or by tiles, with any weights.
      for (const k of leastOnEveryCount(set, (h) => [h.copies, h.nextKinds, h.gapKinds])) out.add(k);
      for (const k of leastOnEveryCount(set, (h) => [h.copies, h.nextTiles, h.gapTiles])) out.add(k);
      // The outermost tile and the outermost single (honours first, then terminals ...; the lowest on a tie).
      for (const singles of [false, true]) {
        const pool = singles ? set.filter((h) => h.copies === 1) : set;
        if (pool.length > 0) out.add(pool.reduce((a, h) => (h.position < a.position ? h : a)).kind);
      }
    }
  }
  return out;
}

/**
 * The tiles a rule of thumb would throw first from a 17-tile hand: the least connected one by any count
 * (no other tile has as few or fewer copies, neighbours one rank away and neighbours two ranks away, by
 * kinds or by tiles, and fewer of one), the outermost tile (honours, then terminals, then 2s and 8s ...)
 * and the outermost single (the lowest kind on a tie), each among all the tiles and again among those that
 * keep the best shanten.
 * That covers "throw the isolated tile", "the tile with the fewest neighbours" whatever the weights,
 * "fewest steps to ready, then fewest neighbours", "honours and terminals first" and the like.
 *
 * With `sets`, also the same picks among the tiles left over once complete sets are taken out, read
 * three ways (`leftAfterSets`: pongs first, runs first, the most sets): "take out your sets, then throw
 * the leftover with the fewest neighbours". Neighbours there are counted among the leftovers only, so
 * one of a pair inside a run (the 2 of 2234) is a leftover single.
 */
export function ruleOfThumbPicks(hand: readonly Kind[], opts: { sets?: boolean } = {}): Kind[] {
  return [...ruleOfThumbPicksOf(heldKinds(countsFromKinds(hand)), opts.sets === true)].sort((a, b) => a - b);
}

const holdsLoneHonour = (counts: Counts): boolean => {
  for (let k = KIND_WIND; k < NUM_PLAY_KINDS; k++) if (counts[k] === 1) return true;
  return false;
};

/**
 * The counts of a uniformly random 17-tile hand within the shanten bounds, with no isolated honour when
 * `shapeOnly`, drawn by a partial shuffle of `wall` (17 swaps, not 136), which leaves the hand in
 * `wall[0..16]` and the rest of the wall after it. Null after `tries` draws.
 */
function quickHand(rng: Rng, wall: Kind[], maxShanten: number, minShanten: number, shapeOnly: boolean, tries = 3000): Counts | null {
  const counts = new Array<number>(NUM_PLAY_KINDS).fill(0);
  for (let attempt = 0; attempt < tries; attempt++) {
    counts.fill(0);
    for (let i = 0; i < 17; i++) {
      const j = i + rng.int(wall.length - i);
      const t = wall[i];
      wall[i] = wall[j];
      wall[j] = t;
      counts[wall[i]]++;
    }
    if (shapeOnly && holdsLoneHonour(counts)) continue;
    const sh = shanten(counts, TOTAL_SETS);
    if (sh <= maxShanten && sh >= minShanten) return counts;
  }
  return null;
}

/**
 * One step of the walk: draw a tile from the rest of the wall and throw a random tile of the hand, as in
 * play, keeping the hand inside the shanten bounds (and free of isolated honours when `shapeOnly`).
 * `wall[0..16]` is the hand and `counts` its counts; both change in place. Returns the two wall positions
 * swapped, for `undoStep`, or null when no step was found.
 */
function walkStep(rng: Rng, wall: Kind[], counts: Counts, maxShanten: number, minShanten: number, shapeOnly: boolean): [number, number] | null {
  for (let tries = 0; tries < 200; tries++) {
    const i = rng.int(17);
    const j = 17 + rng.int(wall.length - 17);
    const out = wall[i];
    const inn = wall[j];
    if (out === inn) continue;
    counts[out]--;
    counts[inn]++;
    if (!(shapeOnly && holdsLoneHonour(counts))) {
      const sh = shanten(counts, TOTAL_SETS);
      if (sh <= maxShanten && sh >= minShanten) {
        wall[i] = inn;
        wall[j] = out;
        return [i, j];
      }
    }
    counts[inn]--;
    counts[out]++;
  }
  return null;
}

/** Takes back a step of the walk. */
function undoStep(wall: Kind[], counts: Counts, [i, j]: [number, number]): void {
  const inn = wall[i];
  const out = wall[j];
  counts[inn]--;
  counts[out]++;
  wall[i] = out;
  wall[j] = inn;
}

/** Sorts by the keys in order, then by kind. */
const byKeys = (kinds: readonly HeldKind[], key: (h: HeldKind) => readonly number[]): Kind[] => {
  const keys = new Map(kinds.map((h) => [h.kind, key(h)]));
  const cmp = (a: Kind, b: Kind): number => {
    const x = keys.get(a)!;
    const y = keys.get(b)!;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a - b;
  };
  return kinds.map((h) => h.kind).sort(cmp);
};

/** Neighbour count with weights for extra copies, kinds one rank away and kinds two ranks away (`byTiles`: tiles of them). */
const weighed = (h: HeldKind, copy: number, next: number, gap: number, byTiles = false): number =>
  (h.copies - 1) * copy + (byTiles ? h.nextTiles : h.nextKinds) * next + (byTiles ? h.gapTiles : h.gapKinds) * gap;

/**
 * The discards that keep the hand closest to ready (`best`), in the orders rules of thumb throw them, the most
 * obvious first: the fewest neighbours over the whole hand (several weightings, by kinds and by tiles), the
 * outermost tile, the outermost single, the spare tile, and the fewest neighbours among the tiles left over once
 * complete sets are taken out (pongs first, runs first, the most sets; a tile used in a set comes after every leftover).
 */
function obviousOrders(held: readonly HeldKind[], best: number, counts: Counts): Kind[][] {
  const keep = held.filter((h) => h.shanten === best);
  const orders: Kind[][] = [
    byKeys(keep, (h) => [weighed(h, 3, 2, 1), h.position]),
    byKeys(keep, (h) => [weighed(h, 1, 1, 1), h.position]),
    byKeys(keep, (h) => [weighed(h, 2, 1, 0), h.position]),
    byKeys(keep, (h) => [weighed(h, 1, 1, 1, true), h.position]),
    byKeys(keep, (h) => [h.position]),
    byKeys(keep, (h) => [h.copies === 1 ? 0 : 1, h.position]),
  ];
  // The spare tile: throw from the suit (the honours count as one) whose tile count is one over a multiple of
  // three, there the tile with the fewest kinds next to it (one rank away, or one or two), the middle or the
  // outermost first on a tie. Without these orders it was right on about half the hard puzzles (unit 21's check).
  const spare = (h: HeldKind): number => (groupTiles(counts, h.kind) % 3 === 1 ? 0 : 1);
  for (const near of [(h: HeldKind) => h.nextKinds, (h: HeldKind) => h.nextKinds + h.gapKinds]) {
    orders.push(byKeys(keep, (h) => [spare(h), near(h), -h.position]), byKeys(keep, (h) => [spare(h), near(h), h.position]));
  }
  for (const read of SET_READS) {
    const left = new Map(leftoverKinds(held, leftAfterSets(counts, read)).map((h) => [h.kind, h]));
    for (const [copy, next, gap] of [
      [3, 2, 1],
      [1, 1, 1],
    ]) {
      orders.push(
        byKeys(keep, (h) => {
          const l = left.get(h.kind);
          return l ? [0, weighed(l, copy, next, gap), l.position] : [1, 0, h.position];
        }),
      );
    }
  }
  return orders;
}

/**
 * Orders whose first pick the deepest bucket also misses. The other end of the same discards: break the pair with
 * the most neighbours (holding two or more pairs), throw the tile with the most neighbours, or the one with the
 * most in the spare suit (the spare tile's opposite). And a search's find once the spare tile was placed: the
 * fewest kinds two ranks away, from the longest suit, then the fewest neighbours (right on 43% of hard puzzles
 * without this order, checked on seeds that took no part in choosing it).
 */
function connectedOrders(held: readonly HeldKind[], best: number, counts: Counts): Kind[][] {
  const keep = held.filter((h) => h.shanten === best);
  const pairs = held.filter((h) => h.copies === 2).length >= 2;
  const links = (h: HeldKind): number => h.nextKinds * 2 + h.gapKinds;
  return [
    byKeys(keep, (h) => [pairs && h.copies === 2 ? 0 : 1, -links(h)]),
    byKeys(keep, (h) => [-links(h)]),
    byKeys(keep, (h) => [-weighed(h, 3, 2, 1), -h.position]),
    byKeys(keep, (h) => [groupTiles(counts, h.kind) % 3 === 1 ? 0 : 1, -weighed(h, 3, 2, 1), -h.position]),
    byKeys(keep, (h) => [h.gapKinds, -groupTiles(counts, h.kind), weighed(h, 3, 2, 1), -h.position]),
  ];
}

/**
 * Where the answer of a 17-tile hand sits for rules of thumb: its accepted answers, the depth (the earliest
 * position at which any obvious order reaches one), whether one is the first pick of a connected order, and
 * how many discards keep the hand closest to ready. Null when the hand is not a puzzle: fewer than
 * BEST_DISCARDS_MIN such discards or two for each answer, or so many answers that it is no decision.
 */
function answerDepth(counts: Counts): { answers: Kind[]; depth: number; connected: boolean; candidates: number } | null {
  const held = heldKinds(counts);
  const best = Math.min(...held.map((h) => h.shanten));
  const keep = held.filter((h) => h.shanten === best).map((h) => h.kind);
  if (keep.length < BEST_DISCARDS_MIN) return null;
  const unseen = counts.map((c) => 4 - c);
  const acceptance = new Map(keep.map((k) => [k, acceptanceAfter(counts, TOTAL_SETS, k, unseen)]));
  const top = Math.max(...acceptance.values());
  const answers = keep.filter((k) => acceptance.get(k)! >= top * 0.9);
  // A real decision: never more than a third of the discards accepted, and two that keep the shape for each answer.
  if (answers.length > Math.max(2, Math.floor(held.length / 3)) || keep.length < 2 * answers.length) return null;
  const depth = Math.min(...obviousOrders(held, best, counts).map((o) => o.findIndex((k) => answers.includes(k))));
  const connected = connectedOrders(held, best, counts).some((o) => answers.includes(o[0]));
  return { answers, depth, connected, candidates: keep.length };
}

/** The puzzle of a 17-tile hand: its analysis, answers within 10% of the best acceptance at the best shanten, and its decision. */
function analysedPuzzle(seed: string, counts: Counts): DiscardPuzzle {
  const hand = kindsFromCounts(counts);
  const options = discardOptions(counts, TOTAL_SETS, counts.map((c) => 4 - c));
  const bestShanten = Math.min(...options.map((o) => o.shanten));
  const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
  const answers = options.filter((o) => o.shanten === bestShanten && o.acceptance >= bestAcceptance * 0.9).map((o) => o.kind);
  const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
  return withDecision({ type: 'discard', seed, hand, answers, best, bestShanten, bestAcceptance, currentShanten: shanten(counts, TOTAL_SETS), options });
}

/**
 * Medium and hard puzzles and the daily: the answer at the depth the seed draws (ANSWER_DEPTH_SHARE). The hand
 * is dealt at random and then changed one tile at a time, a tile drawn from the wall and one thrown, keeping a
 * change unless it takes the hand further from that depth, until it is there: a fresh hand for every try
 * would cost several times as much, since the shanten tables of its suits are new. After ANSWER_DEPTH_STEPS
 * it settles for the hand it has, which is as near as the walk got.
 */
function depthDiscardPuzzle(seed: string, rng: Rng, maxS: number, minS: number, readShape: boolean): DiscardPuzzle {
  const draw = rng.next();
  let bucket = 0;
  let upTo = ANSWER_DEPTH_SHARE[0];
  while (bucket < ANSWER_DEPTH_SHARE.length - 1 && draw >= upTo) upTo += ANSWER_DEPTH_SHARE[++bucket];
  const wall: Kind[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let c = 0; c < 4; c++) wall.push(k);
  const counts = quickHand(rng, wall, maxS, minS, readShape);
  if (!counts) return analysedPuzzle(seed, countsFromKinds(randomHand(rng, 8)));
  /** How near a hand is to the drawn depth (higher is nearer), and whether it is there. A hand with few such discards aims shallower. */
  const fit = (d: ReturnType<typeof answerDepth>): { score: number; there: boolean } => {
    if (!d) return { score: -1, there: false };
    const deepest = Math.min(ANSWER_DEPTH_SHARE.length, d.candidates) - 1;
    const want = Math.min(bucket, deepest);
    if (want < deepest || want === 0) return { score: d.depth === want ? want + 1 : Math.min(d.depth, want), there: d.depth === want };
    // The deepest bucket: at least that deep, and not the first pick of a connected order either.
    return { score: Math.min(d.depth, want) + (d.connected ? 0 : 0.5), there: d.depth >= want && !d.connected };
  };
  let now = fit(answerDepth(counts));
  for (let step = 0; step < ANSWER_DEPTH_STEPS && !now.there; step++) {
    const move = walkStep(rng, wall, counts, maxS, minS, readShape);
    if (!move) continue;
    const next = fit(answerDepth(counts));
    if (next.score >= now.score) now = next;
    else undoStep(wall, counts, move);
  }
  return analysedPuzzle(seed, counts);
}

export function discardPuzzle(seed: string, difficulty: 1 | 2 | 3 = 2, opts: DiscardPuzzleOptions = {}): DiscardPuzzle {
  const rng = createRng(`discard:${seed}`);
  // Harder puzzles are closer to ready, where the differences between discards are subtler.
  const [maxS, minS] = difficulty === 1 ? [4, 2] : difficulty === 2 ? [2, 1] : [1, 0];
  // Easy puzzles draw no extra number, so they stay exactly as they were for every seed.
  const readShapeOn = opts.readShape ?? difficulty >= 2;
  const readShape = readShapeOn && rng.next() >= LONE_HONOUR_PUZZLE_SHARE;
  if (readShapeOn && (opts.deep ?? difficulty >= 2)) return depthDiscardPuzzle(seed, rng, maxS, minS, readShape);
  const accept = readShape ? (hand: Kind[]) => loneHonours(hand).length === 0 : undefined;
  // A second draw (never at easy, so easy puzzles keep their seeds) decides whether the hand must beat the isolated-tile rule.
  const tileShare = opts.isolatedTileShare ?? ISOLATED_TILE_PUZZLE_SHARE[difficulty];
  const compareShapes = readShapeOn && tileShare < 1 && rng.next() >= tileShare && readShape;
  for (let attempt = 0; attempt < (compareShapes ? 200 : 50); attempt++) {
    const hand = randomHand(rng, maxS, minS, accept);
    if (hand.length === 0) continue;
    const counts = countsFromKinds(hand);
    const unseen = counts.map((c) => 4 - c);
    const options = discardOptions(counts, 5, unseen);
    const bestShanten = Math.min(...options.map((o) => o.shanten));
    const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
    const answers = options.filter((o) => o.shanten === bestShanten && o.acceptance >= bestAcceptance * 0.9).map((o) => o.kind);
    // Skip hands where almost anything is right: a puzzle needs a real decision.
    if (answers.length > Math.max(2, Math.floor(options.length / 3))) continue;
    // Comparing shapes: redraw while the isolated-tile rule's tile is an accepted answer.
    if (compareShapes) {
      const lone = isolatedTile(hand);
      if (lone !== null && answers.includes(lone)) continue;
    }
    const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
    return withDecision({ type: 'discard', seed, hand, answers, best, bestShanten, bestAcceptance, currentShanten: shanten(counts, 5), options });
  }
  // Fallback: accept whatever we got.
  const hand = randomHand(rng, 8);
  const counts = countsFromKinds(hand);
  const options = discardOptions(counts, 5, counts.map((c) => 4 - c));
  const bestShanten = Math.min(...options.map((o) => o.shanten));
  const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
  const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
  return withDecision({ type: 'discard', seed, hand, answers: [best], best, bestShanten, bestAcceptance, currentShanten: shanten(counts, 5), options });
}

/**
 * The analysis of any 17-tile hand as a discard puzzle (answers within 10% of the best acceptance at
 * the best shanten, as the generator judges them), with the decision named. For lessons and tests.
 */
export function discardAnalysis(hand: readonly Kind[], seed = 'custom'): DiscardPuzzle {
  const sorted = [...hand].sort((a, b) => a - b);
  const counts = countsFromKinds(sorted);
  const options = discardOptions(counts, 5, counts.map((c) => 4 - c));
  const bestShanten = Math.min(...options.map((o) => o.shanten));
  const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
  const answers = options.filter((o) => o.shanten === bestShanten && o.acceptance >= bestAcceptance * 0.9).map((o) => o.kind);
  const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
  return withDecision({ type: 'discard', seed, hand: sorted, answers, best, bestShanten, bestAcceptance, currentShanten: shanten(counts, 5), options });
}

/**
 * The decisions a discard puzzle can turn on, as `puzzle.discard.<name>` reason keys: the wider of two
 * ready waits; an isolated tile; a pair to break (one too many); the only pair to keep as the eyes; a
 * lone-looking tile that is worth keeping; the weaker (edge or middle) 搭子 to break; otherwise
 * comparing the shapes outright.
 */
export const DISCARD_DECISIONS = ['widerWait', 'isolated', 'breakPair', 'keepPair', 'hiddenValue', 'weakerTaatsu', 'compare'] as const;
export type DiscardDecision = (typeof DISCARD_DECISIONS)[number];

type DiscardOption = DiscardPuzzle['options'][number];

/** The partner of a suited single in an edge (1-2, 8-9) or middle (1-3) 搭子 and the one tile it waits on, or null. */
function weakPartial(counts: Counts, k: Kind): { partner: Kind; wait: Kind; edge: boolean } | null {
  if (k >= KIND_WIND || counts[k] !== 1) return null;
  const r = k % 9;
  const has = (d: number) => r + d >= 0 && r + d <= 8 && counts[k + d] > 0;
  if (has(-1) && has(1)) return null;
  for (const d of [-1, 1]) {
    if (!has(d) || has(-d) || has(2 * d) || has(-2 * d)) continue;
    const lo = Math.min(r, r + d);
    if (lo === 0) return { partner: k + d, wait: k - r + 2, edge: true };
    if (lo === 7) return { partner: k + d, wait: k - r + 6, edge: true };
  }
  if (!has(-1) && !has(1)) for (const d of [-2, 2]) if (has(d) && !has(-d)) return { partner: k + d, wait: k + d / 2, edge: false };
  return null;
}

function withDecision(p: Omit<DiscardPuzzle, 'reasonKey' | 'explanation' | 'explanationZh'>): DiscardPuzzle {
  const { reasonKey, explanation, explanationZh } = discardDecision(p);
  return { ...p, reasonKey, explanation, explanationZh };
}

/** Name the decision a discard puzzle turns on, from its own analysis, in English and Taiwanese Mandarin. */
export function discardDecision(p: Pick<DiscardPuzzle, 'hand' | 'options' | 'answers' | 'best' | 'bestShanten'>): PuzzleExplanation & { decision: DiscardDecision } {
  const counts = countsFromKinds(p.hand);
  const opt = (k: Kind): DiscardOption => p.options.find((o) => o.kind === k)!;
  const b = opt(p.best);
  const rank = (o: DiscardOption) => o.shanten * 1000 - o.acceptance;
  const rivals = p.options.filter((o) => !p.answers.includes(o.kind)).sort((x, y) => rank(x) - rank(y) || x.kind - y.kind);
  const r = rivals[0];
  const pairs = counts.filter((c) => c === 2).length;
  // The tile explained may be a right answer that keeps a little less than the best (`answerExplanation`):
  // then it is not called the best, and the best wrong tile is not called the next best.
  const most = b.acceptance >= Math.max(...p.answers.map((k) => opt(k).acceptance));
  const alone = p.answers.length === 1;
  const B = tileEn(b.kind);
  const Bz = tileZh(b.kind);
  const n = b.acceptance;
  const listEn = (ks: readonly Kind[]) => ks.map(tileEn).join(', ');
  const listZh = (ks: readonly Kind[]) => ks.map(tileZh).join('、');
  const costEn = (o: DiscardOption) => (o.shanten > p.bestShanten ? 'takes you a step further from ready' : `leaves only ${o.acceptance} tiles`);
  const costZh = (o: DiscardOption) => (o.shanten > p.bestShanten ? '會離聽牌更遠一步' : `只剩 ${o.acceptance} 張`);
  const out = (decision: DiscardDecision, explanation: string, explanationZh: string) => ({ decision, reasonKey: `puzzle.discard.${decision}`, explanation, explanationZh });
  if (r && p.bestShanten === 0 && r.shanten === 0 && b.accepts.length > 0) {
    return out(
      'widerWait',
      `Keep the wider wait. Throwing ${B} leaves you ready on ${listEn(b.accepts)} (${n} tiles); throwing ${tileEn(r.kind)} is ready too, but only on ${listEn(r.accepts)} (${r.acceptance} tiles).`,
      `留下較寬的聽牌。打${Bz}聽${listZh(b.accepts)}（${n} 張）；打${tileZh(r.kind)}也聽牌，但只聽${listZh(r.accepts)}（${r.acceptance} 張）。`,
    );
  }
  if (counts[b.kind] === 1 && hasNoNeighbour(counts, b.kind)) {
    return out(
      'isolated',
      `Throw the isolated tile. Nothing in your hand connects to ${B}, so ${most ? 'it is the tile you need least' : 'it does little for the hand'}; after it goes, ${n} tiles still improve the hand.`,
      `打孤張。手上沒有牌能和${Bz}連起來，${most ? '它最沒用' : '它幫不上什麼忙'}；打掉後還有 ${n} 張牌能進張。`,
    );
  }
  if (counts[b.kind] === 2) {
    return pairs >= 2
      ? out(
          'breakPair',
          `Break a pair. You hold ${pairs} pairs and need only one as your eyes; throwing one ${B} keeps ${most ? 'the strongest shapes' : 'good shapes'}, and ${n} tiles still improve the hand.`,
          `拆對子。你有 ${pairs} 組對子，做眼只要一組；拆一張${Bz}${most ? '最划算' : '也不錯'}，打掉後還有 ${n} 張牌能進張。`,
        )
      : out(
          'breakPair',
          `Break the pair. The pair of ${tilesEn(b.kind)} does less for this hand than the shapes around it: throwing one keeps ${n} tiles that improve the hand, and new eyes are easy to find.`,
          `拆對子。${Bz}這對不如旁邊的搭子有用：打一張還有 ${n} 張牌能進張，眼之後再找就好。`,
        );
  }
  if (r && counts[r.kind] === 2 && pairs === 1) {
    return out(
      'keepPair',
      `Keep the pair as your eyes. Your ${tilesEn(r.kind)} are your only pair; breaking it ${costEn(r)}, while throwing ${B} keeps ${n} tiles that improve the hand.`,
      `留對子做眼。${tileZh(r.kind)}是你唯一的對子；拆它${costZh(r)}，打${Bz}則還有 ${n} 張牌能進張。`,
    );
  }
  const lone = isolatedTile(p.hand);
  if (lone !== null && !p.answers.includes(lone)) {
    const l = opt(lone);
    return out(
      'hiddenValue',
      `A lone tile can be worth keeping. ${tileEn(lone)} looks isolated, but it improves more shapes than ${B}: throwing ${B} leaves ${n} tiles that improve the hand, throwing ${tileEn(lone)} ${costEn(l)}.`,
      `孤張不一定最沒用。${tileZh(lone)}看起來是孤張，但它能幫到的形狀比${Bz}多：打${Bz}還有 ${n} 張能進張，打${tileZh(lone)}${costZh(l)}。`,
    );
  }
  const weak = weakPartial(counts, b.kind);
  if (weak) {
    return out(
      'weakerTaatsu',
      `Break the weaker partial set (搭子). ${B} and ${tileEn(weak.partner)} wait only on ${tileEn(weak.wait)} (${weak.edge ? 'an edge' : 'a middle'} wait); keep the partial sets that wait on more. Throwing ${B} keeps ${n} tiles that improve the hand.`,
      `拆比較弱的搭子。${Bz}和${tileZh(weak.partner)}是${weak.edge ? '邊張' : '嵌張'}，只等${tileZh(weak.wait)}；留下等牌較多的搭子。打${Bz}還有 ${n} 張能進張。`,
    );
  }
  return out(
    'compare',
    r ? `Compare the shapes. Throwing ${B} keeps ${n} tiles that improve the hand; ${alone ? 'the closest other choice' : 'the best of the wrong choices'}, ${tileEn(r.kind)}, ${costEn(r)}.` : `Compare the shapes. Throwing ${B} keeps ${n} tiles that improve the hand.`,
    r ? `比較形狀。打${Bz}還有 ${n} 張能進張；${alone ? '次佳的' : '錯的選項裡最好的'}${tileZh(r.kind)}${costZh(r)}。` : `比較形狀。打${Bz}還有 ${n} 張能進張。`,
  );
}
