/**
 * Puzzle generators for single-player training (daily puzzle, puzzle rush,
 * drills). Everything is seeded so a "daily" puzzle is identical for every
 * player and a rush run can be replayed.
 */
import { countsFromKinds, discardOptions, relevantKinds, shanten, waits } from './hand';
import { createRng, shuffle, type Rng } from './rng';
import { NUM_PLAY_KINDS, type Kind } from './tiles';

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
}

export interface WaitsPuzzle {
  type: 'waits';
  seed: string;
  /** 16 concealed tiles, ready to win. */
  hand: Kind[];
  answers: Kind[];
  candidates: Kind[];
}

export type Puzzle = DiscardPuzzle | WaitsPuzzle;

function randomHand(rng: Rng, maxShanten: number, minShanten = 0): Kind[] {
  for (let attempt = 0; attempt < 500; attempt++) {
    const pool: Kind[] = [];
    for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let c = 0; c < 4; c++) pool.push(k);
    shuffle(pool, rng);
    const hand = pool.slice(0, 17).sort((a, b) => a - b);
    const sh = shanten(countsFromKinds(hand), 5);
    if (sh <= maxShanten && sh >= minShanten) return hand;
  }
  return [];
}

export function discardPuzzle(seed: string, difficulty: 1 | 2 | 3 = 2): DiscardPuzzle {
  const rng = createRng(`discard:${seed}`);
  // Harder puzzles are closer to ready, where the differences between discards are subtler.
  const [maxS, minS] = difficulty === 1 ? [4, 2] : difficulty === 2 ? [2, 1] : [1, 0];
  for (let attempt = 0; attempt < 50; attempt++) {
    const hand = randomHand(rng, maxS, minS);
    if (hand.length === 0) continue;
    const counts = countsFromKinds(hand);
    const unseen = counts.map((c) => 4 - c);
    const options = discardOptions(counts, 5, unseen);
    const bestShanten = Math.min(...options.map((o) => o.shanten));
    const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
    const answers = options.filter((o) => o.shanten === bestShanten && o.acceptance >= bestAcceptance * 0.9).map((o) => o.kind);
    // Skip hands where almost anything is right: a puzzle needs a real decision.
    if (answers.length > Math.max(2, Math.floor(options.length / 3))) continue;
    const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
    return { type: 'discard', seed, hand, answers, best, bestShanten, bestAcceptance, currentShanten: shanten(counts, 5), options };
  }
  // Fallback: accept whatever we got.
  const hand = randomHand(rng, 8);
  const counts = countsFromKinds(hand);
  const options = discardOptions(counts, 5, counts.map((c) => 4 - c));
  const bestShanten = Math.min(...options.map((o) => o.shanten));
  const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
  const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
  return { type: 'discard', seed, hand, answers: [best], best, bestShanten, bestAcceptance, currentShanten: shanten(counts, 5), options };
}

/** A random ready (聽牌) 16-tile hand built from 5 random sets + a pair minus one tile. */
export function waitsPuzzle(seed: string, difficulty: 1 | 2 | 3 = 2): WaitsPuzzle {
  const rng = createRng(`waits:${seed}`);
  const minWaits = difficulty === 1 ? 1 : difficulty === 2 ? 2 : 3;
  let fallback: WaitsPuzzle | null = null;
  for (let attempt = 0; attempt < 600; attempt++) {
    const counts = new Array<number>(NUM_PLAY_KINDS).fill(0);
    const hand: Kind[] = [];
    const add = (k: Kind) => {
      counts[k]++;
      hand.push(k);
    };
    let ok = true;
    // Harder puzzles use fewer suits so shapes interlock.
    const suits = difficulty === 3 ? [rng.int(3)] : difficulty === 2 ? [rng.int(3), rng.int(3)] : [0, 1, 2];
    for (let s = 0; s < 5 && ok; s++) {
      if (rng.next() < 0.7) {
        const suit = suits[rng.int(suits.length)];
        const start = suit * 9 + rng.int(7);
        if (counts[start] >= 4 || counts[start + 1] >= 4 || counts[start + 2] >= 4) ok = false;
        else {
          add(start);
          add(start + 1);
          add(start + 2);
        }
      } else {
        const k = difficulty === 1 && rng.next() < 0.5 ? 27 + rng.int(7) : suits[rng.int(suits.length)] * 9 + rng.int(9);
        if (counts[k] + 3 > 4) ok = false;
        else {
          add(k);
          add(k);
          add(k);
        }
      }
    }
    if (!ok) continue;
    const pair = rng.next() < 0.3 ? 27 + rng.int(7) : suits[rng.int(suits.length)] * 9 + rng.int(9);
    if (counts[pair] + 2 > 4) continue;
    add(pair);
    add(pair);
    hand.splice(rng.int(hand.length), 1);
    hand.sort((a, b) => a - b);
    const answers = waits(countsFromKinds(hand), 5);
    if (answers.length === 0) continue;
    const puzzle: WaitsPuzzle = { type: 'waits', seed, hand, answers, candidates: relevantKinds(countsFromKinds(hand)) };
    if (answers.length >= minWaits) return puzzle;
    fallback = fallback ?? puzzle;
  }
  return fallback ?? { type: 'waits', seed, hand: [], answers: [], candidates: [] };
}

/** Deterministic daily puzzle id for a calendar date (UTC). */
export function dailySeed(date: Date): string {
  return `daily-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function dailyPuzzle(date: Date): DiscardPuzzle {
  const day = date.getUTCDay();
  const difficulty: 1 | 2 | 3 = day === 0 || day === 6 ? 3 : day % 2 === 0 ? 2 : 1;
  return discardPuzzle(dailySeed(date), difficulty);
}

/** Puzzle Rush: an endless, seeded sequence that gets harder as you go. */
export function rushPuzzle(runSeed: string, index: number): Puzzle {
  const difficulty: 1 | 2 | 3 = index < 5 ? 1 : index < 15 ? 2 : 3;
  const seed = `${runSeed}:${index}`;
  return index % 3 === 2 ? waitsPuzzle(seed, difficulty) : discardPuzzle(seed, difficulty);
}

export function checkDiscardAnswer(p: DiscardPuzzle, kind: Kind): boolean {
  return p.answers.includes(kind);
}

export function checkWaitsAnswer(p: WaitsPuzzle, chosen: Kind[]): boolean {
  const set = new Set(chosen);
  return set.size === p.answers.length && p.answers.every((k) => set.has(k));
}
