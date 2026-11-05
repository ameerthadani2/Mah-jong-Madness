/**
 * Hand analysis: winning-shape decomposition, waits (聽牌) and shanten (向聽數)
 * for a 16-tile hand (5 sets + 1 pair = 17 tiles).
 *
 * All functions operate on a `Counts` array of 34 playable kinds so they are
 * independent of physical tile ids and cheap enough for bot search on mobile.
 */
import { isSuited, KIND_WIND, NUM_PLAY_KINDS, rankOfKind, type Kind } from './tiles';

export type Counts = number[];

export interface SetShape {
  type: 'chow' | 'pong';
  /** Lowest kind of the chow, or the kind of the pong */
  kind: Kind;
}

export interface Decomposition {
  pair: Kind;
  sets: SetShape[];
}

export const TOTAL_SETS = 5;

export function emptyCounts(): Counts {
  return new Array<number>(NUM_PLAY_KINDS).fill(0);
}

export function countsFromKinds(kinds: readonly Kind[]): Counts {
  const c = emptyCounts();
  for (const k of kinds) if (k < NUM_PLAY_KINDS) c[k]++;
  return c;
}

export function kindsFromCounts(counts: Counts): Kind[] {
  const out: Kind[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let i = 0; i < counts[k]; i++) out.push(k);
  return out;
}

export function totalCount(counts: Counts): number {
  let n = 0;
  for (let k = 0; k < NUM_PLAY_KINDS; k++) n += counts[k];
  return n;
}

/** Can `kind` start a chow (kind, kind+1, kind+2) within the same suit? */
export function canStartChow(kind: Kind): boolean {
  return isSuited(kind) && rankOfKind(kind) <= 7;
}

/**
 * Enumerate every way to split `counts` into `setsNeeded` sets plus one pair.
 * Returns [] if the counts do not form a complete hand.
 */
export function decompose(counts: Counts, setsNeeded: number): Decomposition[] {
  if (totalCount(counts) !== setsNeeded * 3 + 2) return [];
  const results: Decomposition[] = [];
  const c = counts.slice();
  for (let pair = 0; pair < NUM_PLAY_KINDS; pair++) {
    if (c[pair] < 2) continue;
    c[pair] -= 2;
    const sets: SetShape[] = [];
    decomposeSets(c, 0, sets, (found) => results.push({ pair, sets: found.slice() }));
    c[pair] += 2;
  }
  return results;
}

function decomposeSets(c: Counts, from: number, acc: SetShape[], emit: (sets: SetShape[]) => void): void {
  let k = from;
  while (k < NUM_PLAY_KINDS && c[k] === 0) k++;
  if (k >= NUM_PLAY_KINDS) {
    emit(acc);
    return;
  }
  // Pong
  if (c[k] >= 3) {
    c[k] -= 3;
    acc.push({ type: 'pong', kind: k });
    decomposeSets(c, k, acc, emit);
    acc.pop();
    c[k] += 3;
  }
  // Chow
  if (canStartChow(k) && c[k + 1] > 0 && c[k + 2] > 0) {
    c[k]--;
    c[k + 1]--;
    c[k + 2]--;
    acc.push({ type: 'chow', kind: k });
    decomposeSets(c, k, acc, emit);
    acc.pop();
    c[k]++;
    c[k + 1]++;
    c[k + 2]++;
  }
}

/** True if `counts` (concealed tiles incl. the winning tile) forms `setsNeeded` sets + pair. */
export function isComplete(counts: Counts, setsNeeded: number): boolean {
  if (totalCount(counts) !== setsNeeded * 3 + 2) return false;
  const c = counts.slice();
  for (let pair = 0; pair < NUM_PLAY_KINDS; pair++) {
    if (c[pair] < 2) continue;
    c[pair] -= 2;
    const ok = completesSets(c, 0);
    c[pair] += 2;
    if (ok) return true;
  }
  return false;
}

function completesSets(c: Counts, from: number): boolean {
  let k = from;
  while (k < NUM_PLAY_KINDS && c[k] === 0) k++;
  if (k >= NUM_PLAY_KINDS) return true;
  if (c[k] >= 3) {
    c[k] -= 3;
    const ok = completesSets(c, k);
    c[k] += 3;
    if (ok) return true;
  }
  if (canStartChow(k) && c[k + 1] > 0 && c[k + 2] > 0) {
    c[k]--;
    c[k + 1]--;
    c[k + 2]--;
    const ok = completesSets(c, k);
    c[k]++;
    c[k + 1]++;
    c[k + 2]++;
    if (ok) return true;
  }
  return false;
}

/**
 * Kinds that would complete the hand if added. `counts` must hold 3n+1 tiles
 * where n = setsNeeded. A kind already held 4 times in `counts` is skipped.
 *
 * `blocked` optionally lists copies of each kind that are out of play beyond
 * `counts` (for example the player's own exposed or concealed melds); a kind is
 * then skipped when `counts` and `blocked` together hold all four copies, so only
 * live waits are reported. Without it the result is the pure shape answer.
 */
export function waits(counts: Counts, setsNeeded: number, blocked?: Counts): Kind[] {
  if (totalCount(counts) !== setsNeeded * 3 + 1) return [];
  const out: Kind[] = [];
  const c = counts.slice();
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (c[k] + (blocked?.[k] ?? 0) >= 4) continue;
    c[k]++;
    if (isComplete(c, setsNeeded)) out.push(k);
    c[k]--;
  }
  return out;
}

/**
 * Shanten number: how many tile exchanges away from tenpai (聽牌) the hand is.
 * 0 = ready (聽牌), -1 = complete.
 *
 * Generic formula for a hand that needs `setsNeeded` sets + 1 pair:
 *   shanten = 2*setsNeeded − 2*melds − partials − pair
 * with melds + partials ≤ setsNeeded.
 *
 * Suits never interact, so each suit (and the honor block) is reduced to a
 * Pareto front of achievable (melds, partials, pair) triples, cached by its
 * 9-digit count signature, and the fronts are combined. This keeps bot search
 * fast enough for mobile (tens of microseconds per call after warm-up).
 */
export function shanten(counts: Counts, setsNeeded: number): number {
  const n = totalCount(counts);
  const expected = setsNeeded * 3 + 1;
  if (n !== expected && n !== expected + 1) {
    throw new Error(`shanten: expected ${expected} or ${expected + 1} tiles, got ${n}`);
  }
  let combos: Combo[] = [[0, 0, 0]];
  for (let g = 0; g < GROUPS.length; g++) {
    const [from, to, honor] = GROUPS[g];
    const part = groupCombos(counts, from, to, honor);
    combos = combine(combos, part, setsNeeded);
  }
  let best = Infinity;
  for (const [m, t, h] of combos) {
    const mm = Math.min(m, setsNeeded);
    const tt = Math.min(t, setsNeeded - mm);
    const v = 2 * setsNeeded - 2 * mm - tt - h;
    if (v < best) best = v;
  }
  return best;
}

/** [melds, partials, pair(0|1)] */
type Combo = [number, number, number];

const GROUPS: Array<[number, number, boolean]> = [
  [0, 9, false],
  [9, 18, false],
  [18, 27, false],
  [27, 34, true],
];

const comboCache = new Map<string, Combo[]>();
const COMBO_CACHE_LIMIT = 200000;

function groupCombos(counts: Counts, from: number, to: number, honor: boolean): Combo[] {
  let key = honor ? 'h' : 's';
  for (let k = from; k < to; k++) key += counts[k];
  const cached = comboCache.get(key);
  if (cached) return cached;
  const c = counts.slice(from, to);
  const result = searchFrom(c, 0, honor, 0);
  if (comboCache.size > COMBO_CACHE_LIMIT) comboCache.clear();
  comboCache.set(key, result);
  return result;
}

/**
 * Sub-states of the group search, keyed by the remaining counts from `i` and the pair flag.
 * A 17-tile single-suit hand has millions of decompositions but only a few thousand distinct
 * sub-states, so this turns a 20 ms worst case into well under a millisecond.
 */
const subCache = new Map<string, Combo[]>();
const SUB_CACHE_LIMIT = 400000;

/** Pareto front of (melds, partials, pair) achievable from position `i` of `c`, given the pair flag `h`. */
function searchFrom(c: number[], i: number, honor: boolean, h: number): Combo[] {
  const n = c.length;
  while (i < n && c[i] === 0) i++;
  if (i >= n) return [[0, 0, 0]];
  let key = (honor ? 'h' : 's') + i + ':' + h + ':';
  for (let k = i; k < n; k++) key += c[k];
  const hit = subCache.get(key);
  if (hit) return hit;
  const found = new Map<number, Combo>();
  const add = (dm: number, dt: number, dh: number, sub: Combo[]) => {
    for (const [a, b, p] of sub) {
      const m = a + dm;
      const t = b + dt;
      const hh = p + dh;
      found.set(m * 100 + t * 10 + hh, [m, t, hh]);
    }
  };
  if (c[i] >= 3) {
    c[i] -= 3;
    add(1, 0, 0, searchFrom(c, i, honor, h));
    c[i] += 3;
  }
  if (!honor && i + 2 < n && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--;
    c[i + 1]--;
    c[i + 2]--;
    add(1, 0, 0, searchFrom(c, i, honor, h));
    c[i]++;
    c[i + 1]++;
    c[i + 2]++;
  }
  if (c[i] >= 2) {
    c[i] -= 2;
    if (h === 0) add(0, 0, 1, searchFrom(c, i, honor, 1));
    add(0, 1, 0, searchFrom(c, i, honor, h));
    c[i] += 2;
  }
  if (!honor) {
    if (i + 1 < n && c[i + 1] > 0) {
      c[i]--;
      c[i + 1]--;
      add(0, 1, 0, searchFrom(c, i, honor, h));
      c[i]++;
      c[i + 1]++;
    }
    if (i + 2 < n && c[i + 2] > 0) {
      c[i]--;
      c[i + 2]--;
      add(0, 1, 0, searchFrom(c, i, honor, h));
      c[i]++;
      c[i + 2]++;
    }
  }
  // Leave one copy isolated.
  c[i]--;
  add(0, 0, 0, searchFrom(c, i, honor, h));
  c[i]++;
  // Melds, partials and the pair each only ever lower the shanten count (after clipping), so
  // dominated triples can be dropped at every level without changing the result.
  const result = pareto([...found.values()]);
  if (subCache.size > SUB_CACHE_LIMIT) subCache.clear();
  subCache.set(key, result);
  return result;
}

function pareto(list: Combo[]): Combo[] {
  return list.filter((a) => !list.some((b) => b !== a && b[0] >= a[0] && b[1] >= a[1] && b[2] >= a[2] && (b[0] > a[0] || b[1] > a[1] || b[2] > a[2])));
}

function combine(a: Combo[], b: Combo[], setsNeeded: number): Combo[] {
  const seen = new Map<number, Combo>();
  for (const x of a) {
    for (const y of b) {
      const h = Math.min(1, x[2] + y[2]);
      const m = Math.min(setsNeeded, x[0] + y[0]);
      const t = Math.min(setsNeeded, x[1] + y[1]);
      seen.set(m * 100 + t * 10 + h, [m, t, h]);
    }
  }
  return pareto([...seen.values()]);
}

/**
 * For each possible discard from a 3n+2 hand, the resulting shanten and the
 * kinds that would then improve the hand ("acceptance"). Used by bots and hints.
 */
export interface DiscardOption {
  kind: Kind;
  shanten: number;
  /** Kinds that lower shanten after this discard */
  accepts: Kind[];
  /** Sum of remaining copies of accepted kinds given `unseen` counts */
  acceptance: number;
}

export function discardOptions(counts: Counts, setsNeeded: number, unseen: Counts): DiscardOption[] {
  const out: DiscardOption[] = [];
  const c = counts.slice();
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (c[k] === 0) continue;
    c[k]--;
    const s = shanten(c, setsNeeded);
    const accepts: Kind[] = [];
    let acceptance = 0;
    const relevant = relevantKinds(c);
    for (const a of relevant) {
      if (c[a] >= 4 || unseen[a] <= 0) continue;
      c[a]++;
      const s2 = shanten(c, setsNeeded);
      c[a]--;
      if (s2 < s) {
        accepts.push(a);
        acceptance += unseen[a];
      }
    }
    out.push({ kind: k, shanten: s, accepts, acceptance });
    c[k]++;
  }
  return out;
}

/** Kinds that could possibly improve a hand: honors already held and suited kinds within 2 of a held tile. */
export function relevantKinds(counts: Counts): Kind[] {
  const out: Kind[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (k >= KIND_WIND) {
      if (counts[k] > 0) out.push(k);
      continue;
    }
    const base = Math.floor(k / 9) * 9;
    let near = false;
    for (let d = -2; d <= 2 && !near; d++) {
      const kk = k + d;
      if (kk >= base && kk < base + 9 && counts[kk] > 0) near = true;
    }
    if (near) out.push(k);
  }
  return out;
}

export function isHonorOrTerminal(kind: Kind): boolean {
  return kind >= KIND_WIND || rankOfKind(kind) === 1 || rankOfKind(kind) === 9;
}
