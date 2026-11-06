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
 * Defined as the distance to the nearest complete target of `setsNeeded` sets +
 * 1 pair: shanten = (3·setsNeeded + 1) − overlap, where overlap is the number of
 * tiles the hand shares with the target. A target may hold at most four copies
 * of a kind, so a concealed quad that has not been konged is never read as a
 * pong plus a tanki wait on a fifth copy (or a pair plus a pair-partial): such a
 * hand is one away, not ready, and agrees with waits() being empty.
 *
 * Suits never interact, so each suit (and the honor block) is reduced to its
 * best overlap per (sets, pair) target share, cached by its count signature,
 * and the four tables are combined. This keeps bot search fast enough for
 * mobile (tens of microseconds per call after warm-up).
 */
export function shanten(counts: Counts, setsNeeded: number): number {
  const n = totalCount(counts);
  const expected = setsNeeded * 3 + 1;
  if (n !== expected && n !== expected + 1) {
    throw new Error(`shanten: expected ${expected} or ${expected + 1} tiles, got ${n}`);
  }
  if (setsNeeded < 0 || setsNeeded > TOTAL_SETS) throw new Error(`shanten: setsNeeded ${setsNeeded} out of range`);
  // best[s * 2 + p]: max overlap using s sets and p pairs from the groups seen so far; -1 = impossible.
  let best = new Int8Array(OVERLAP_SLOTS).fill(-1);
  best[0] = 0;
  for (let g = 0; g < GROUPS.length; g++) {
    const [from, to, honor] = GROUPS[g];
    const part = groupOverlap(counts, from, to, honor);
    const next = new Int8Array(OVERLAP_SLOTS).fill(-1);
    for (let s = 0; s <= setsNeeded; s++) {
      for (let p = 0; p <= 1; p++) {
        const have = best[s * 2 + p];
        if (have < 0) continue;
        for (let gs = 0; s + gs <= setsNeeded; gs++) {
          for (let gp = 0; p + gp <= 1; gp++) {
            const add = part[gs * 2 + gp];
            if (add < 0) continue;
            const slot = (s + gs) * 2 + p + gp;
            if (have + add > next[slot]) next[slot] = have + add;
          }
        }
      }
    }
    best = next;
  }
  return expected - best[setsNeeded * 2 + 1];
}

const GROUPS: Array<[number, number, boolean]> = [
  [0, 9, false],
  [9, 18, false],
  [18, 27, false],
  [27, 34, true],
];

/** Slots of a per-group overlap table: sets 0..TOTAL_SETS × pair 0..1. */
const OVERLAP_SLOTS = (TOTAL_SETS + 1) * 2;
/** A target never holds more copies of a kind than exist. */
const MAX_COPIES = 4;
/** Chows in flight that still cover a kind: those started one and two kinds earlier. */
const CHOW_SPAN = MAX_COPIES + 1;
const DP_SLOTS = CHOW_SPAN * CHOW_SPAN * OVERLAP_SLOTS;

const overlapCache = new Map<string, Int8Array>();
const OVERLAP_CACHE_LIMIT = 200000;

/**
 * For one suit (or the honor block): the greatest number of tiles of `counts[from..to)`
 * that a target made of `s` sets and `p` pairs taken from this group can share with
 * the hand, indexed `s * 2 + p`, or -1 when no such target exists. Every kind in the
 * target is capped at four copies.
 */
function groupOverlap(counts: Counts, from: number, to: number, honor: boolean): Int8Array {
  let key = honor ? 'h' : 's';
  for (let k = from; k < to; k++) key += counts[k];
  const cached = overlapCache.get(key);
  if (cached) return cached;
  const result = overlapTable(counts.slice(from, to), honor);
  if (overlapCache.size > OVERLAP_CACHE_LIMIT) overlapCache.clear();
  overlapCache.set(key, result);
  return result;
}

/**
 * Dynamic programme over the kinds of one group, right to left. The state at kind `k` is
 * (a, b, s, p): chows started at k−1 and k−2 that still cover k, and the sets and pairs the
 * target has yet to start. At each kind the target takes `ch` new chows, `po` pongs and `pa`
 * pairs, holding ch + a + b + 3·po + 2·pa copies, and the hand contributes min(held, count).
 */
function overlapTable(c: number[], honor: boolean): Int8Array {
  const n = c.length;
  const idx = (a: number, b: number, s: number, p: number): number => ((a * CHOW_SPAN + b) * (TOTAL_SETS + 1) + s) * 2 + p;
  let next = new Int8Array(DP_SLOTS).fill(-1);
  next[idx(0, 0, 0, 0)] = 0;
  for (let k = n - 1; k >= 0; k--) {
    const cur = new Int8Array(DP_SLOTS).fill(-1);
    const chowMax = !honor && k + 2 < n ? MAX_COPIES : 0;
    for (let a = 0; a < CHOW_SPAN; a++) {
      for (let b = 0; a + b <= MAX_COPIES; b++) {
        for (let s = 0; s <= TOTAL_SETS; s++) {
          for (let p = 0; p <= 1; p++) {
            let bestHere = -1;
            for (let ch = 0; ch <= chowMax && ch <= s; ch++) {
              for (let po = 0; po <= 1 && ch + po <= s; po++) {
                for (let pa = 0; pa <= p; pa++) {
                  const used = ch + a + b + 3 * po + 2 * pa;
                  if (used > MAX_COPIES) continue;
                  const rest = next[idx(ch, a, s - ch - po, p - pa)];
                  if (rest < 0) continue;
                  const v = Math.min(c[k], used) + rest;
                  if (v > bestHere) bestHere = v;
                }
              }
            }
            cur[idx(a, b, s, p)] = bestHere;
          }
        }
      }
    }
    next = cur;
  }
  const out = new Int8Array(OVERLAP_SLOTS);
  for (let s = 0; s <= TOTAL_SETS; s++) for (let p = 0; p <= 1; p++) out[s * 2 + p] = next[idx(0, 0, s, p)];
  return out;
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
