/**
 * Puzzle generators for single-player training (daily puzzle, puzzle rush,
 * drills). Everything is seeded so a "daily" puzzle is identical for every
 * player and a rush run can be replayed.
 *
 * Five themes: discard (tile efficiency), waits (name every winning tile),
 * defence (the safest tiles against an opponent with four exposed sets, by the
 * bots' deal-in model and checked by exact enumeration), claim (the response
 * that leaves the hand closest to ready and worth most) and value (the ready
 * discard with the highest expected score). Each has a seeded generator, every
 * accepted answer (several when they are about equal) and a checker.
 *
 * This file holds the waits puzzle, the daily puzzle, Puzzle Rush and the explanation of a chosen answer. The other
 * themes have a file each, `puzzlediscard.ts`, `puzzledefence.ts`, `puzzleclaim.ts` and `puzzlevalue.ts`, with what
 * they share in `puzzletable.ts`; what the engine exports of them is exported from here.
 *
 * Chinese: first pass, needs native review.
 */
import { countsFromKinds, relevantKinds, waits } from './hand';
import { createRng } from './rng';
import { NUM_PLAY_KINDS, type Kind } from './tiles';
import { DAILY_DISCARD_OPTIONS, discardPuzzle, discardDecision, type DiscardPuzzle } from './puzzlediscard';
import { tileEn, tileZh, capitalise, type PuzzleDifficulty, type PuzzleExplanation } from './puzzletable';
import { defenceText, defencePuzzle, type DefencePuzzle } from './puzzledefence';
import { claimText, claimPuzzle, claimPongTai, type ClaimPuzzle } from './puzzleclaim';
import { fmt1, valueText, valuePuzzle, chasedPattern, type ValuePuzzle } from './puzzlevalue';

export { type PuzzleDifficulty, type PuzzleMeld, type PuzzleSeatView, type PuzzleExplanation } from './puzzletable';
export { LONE_HONOUR_PUZZLE_SHARE, loneHonours, ISOLATED_TILE_PUZZLE_SHARE, ANSWER_DEPTH_SHARE, BEST_DISCARDS_MIN, DAILY_DISCARD_OPTIONS, isolatedTile, ruleOfThumbPicks, discardPuzzle, discardAnalysis, DISCARD_DECISIONS, discardDecision, type DiscardPuzzle, type DiscardPuzzleOptions, type DiscardDecision } from './puzzlediscard';
export { DEFENCE_TOLERANCE, exactWaitChances, DEFENCE_HARD_READ_SHARE, defencePuzzle, DEFENCE_SAFETY_ORDER, defenceOrderRule, checkDefenceAnswer, type DefenceReason, type DefenceOption, type DefencePuzzle } from './puzzledefence';
export { CLAIM_TOLERANCE, claimPuzzle, checkClaimAnswer, type ClaimChoice, type ClaimOption, type ClaimPuzzle } from './puzzleclaim';
export { VALUE_SELF_DRAW_SHARE, VALUE_TOLERANCE, VALUE_HARD_SIZE_SHARE, VALUE_HARD_SHARES, scoreWaits, valuePuzzle, valueTwoLineRule, valueSpeedRule, VALUE_BIG_PATTERN_TAI, valuePatternRule, checkValueAnswer, type ValueWait, type ValueOption, type ValuePuzzle } from './puzzlevalue';

export interface WaitsPuzzle {
  type: 'waits';
  seed: string;
  /** 16 concealed tiles, ready to win. */
  hand: Kind[];
  answers: Kind[];
  candidates: Kind[];
}

export type Puzzle = DiscardPuzzle | WaitsPuzzle;

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
  return discardPuzzle(dailySeed(date), difficulty, DAILY_DISCARD_OPTIONS);
}

/** Every puzzle theme, in Puzzle Rush rotation order. */
export const PUZZLE_TYPES = ['discard', 'defence', 'waits', 'claim', 'value'] as const;
/** The original rotation (two discard puzzles, then a waits puzzle), still the two-argument default. */
const CLASSIC_RUSH: readonly PuzzleType[] = ['discard', 'discard', 'waits'];

/** Generate one puzzle of the given theme. */
export function puzzleOfType(type: PuzzleType, seed: string, difficulty: PuzzleDifficulty = 2): AnyPuzzle {
  switch (type) {
    case 'discard':
      return discardPuzzle(seed, difficulty);
    case 'waits':
      return waitsPuzzle(seed, difficulty);
    case 'defence':
      return defencePuzzle(seed, difficulty);
    case 'claim':
      return claimPuzzle(seed, difficulty);
    case 'value':
      return valuePuzzle(seed, difficulty);
  }
}

/**
 * Puzzle Rush: an endless, seeded sequence that gets harder as you go. With two
 * arguments it keeps the classic discard/waits rotation; pass `PUZZLE_TYPES` to
 * rotate all five themes (as the app's Rush does).
 */
export function rushPuzzle(runSeed: string, index: number): Puzzle;
export function rushPuzzle(runSeed: string, index: number, types: readonly PuzzleType[]): AnyPuzzle;
export function rushPuzzle(runSeed: string, index: number, types: readonly PuzzleType[] = CLASSIC_RUSH): AnyPuzzle {
  const difficulty: 1 | 2 | 3 = index < 5 ? 1 : index < 15 ? 2 : 3;
  const seed = `${runSeed}:${index}`;
  const list = types.length > 0 ? types : CLASSIC_RUSH;
  return puzzleOfType(list[index % list.length], seed, difficulty);
}

export function checkDiscardAnswer(p: DiscardPuzzle, kind: Kind): boolean {
  return p.answers.includes(kind);
}

export function checkWaitsAnswer(p: WaitsPuzzle, chosen: Kind[]): boolean {
  const set = new Set(chosen);
  return set.size === p.answers.length && p.answers.every((k) => set.has(k));
}

/**
 * The explanation to show for the answer a player gave (a tile kind, the waits, or a claim option id).
 *
 * Every theme but waits accepts several answers when they are about as good, and a puzzle's own
 * explanation is written for one of them (`best` for a discard puzzle, `answer` for the others). A right
 * answer other than that one gets an explanation that is true of what the player chose, and that names
 * the puzzle's own answer as right too:
 * - discard: the decision the chosen tile turns on (`discardDecision` with it as the best), then the
 *   tile that keeps the most and its count;
 * - defence: why the chosen tile is safe, by its own reason and count, with the safest named as about
 *   as safe;
 * - claim: what the chosen claim does, with the coach's choice named as about as good;
 * - value: the chosen tile's winning tiles and value against the best, then the best against the rival.
 * A wrong answer, or the puzzle's own, gets the puzzle's own explanation, as before. Null for a waits
 * puzzle, which has none.
 */
export function answerExplanation(p: AnyPuzzle, answer: Kind | readonly Kind[] | string): PuzzleExplanation | null {
  if (p.type === 'waits') return null;
  const own: PuzzleExplanation = { reasonKey: p.reasonKey, explanation: p.explanation, explanationZh: p.explanationZh };
  switch (p.type) {
    case 'discard': {
      if (typeof answer !== 'number' || answer === p.best || !p.answers.includes(answer)) return own;
      const chosen = discardDecision({ ...p, best: answer });
      const top = p.options.find((o) => o.kind === p.best)!;
      const mine = p.options.find((o) => o.kind === answer)!;
      const B = tileEn(p.best);
      const Bz = tileZh(p.best);
      const tie = mine.acceptance === top.acceptance;
      return {
        reasonKey: chosen.reasonKey,
        explanation: `${chosen.explanation} ${tie ? `${capitalise(B)} is just as good: throwing it also keeps ${top.acceptance} tiles.` : `${capitalise(B)} keeps a few more, ${top.acceptance} tiles; yours keeps ${mine.acceptance}, within a tenth of that, so both count as right.`}`,
        explanationZh: `${chosen.explanationZh}${tie ? `打${Bz}一樣好，也還有 ${top.acceptance} 張能進張。` : `打${Bz}多一點，還有 ${top.acceptance} 張能進張；你打的還有 ${mine.acceptance} 張，差不到一成，兩張都算對。`}`,
      };
    }
    case 'defence': {
      if (typeof answer !== 'number' || answer === p.answer || !p.answers.includes(answer)) return own;
      const reason = p.options.find((o) => o.kind === answer)!.reason;
      const text = defenceText({ ...p, answer, reason }, true);
      // "The fewest hands wait on it" is the safest tile's: this one has about as few.
      return reason === 'middle' ? { ...text, reasonKey: 'puzzle.defence.middleNear' } : text;
    }
    case 'claim': {
      if (typeof answer !== 'string' || answer === p.answer.id || !p.answers.includes(answer)) return own;
      const o = p.options.find((x) => x.id === answer)!;
      return claimText({ ...p, answer: o }, o.type === 'pong' || o.type === 'kong' ? claimPongTai(p) : 0);
    }
    case 'value': {
      if (typeof answer !== 'number' || answer === p.answer || !p.answers.includes(answer)) return own;
      const a = p.options.find((o) => o.kind === p.answer)!;
      const b = p.options.find((o) => o.kind === answer)!;
      const r = p.options.find((o) => o.kind === p.rival)!;
      // The best against the rival, as the puzzle explains it, without the line that names the other right answers.
      const best = valueText({ ...p, answers: [p.answer] }, p.reasonKey, p.difficulty === 3 ? chasedPattern(a, r) : undefined);
      const ratio = Math.round((100 * b.expectedScore!) / a.expectedScore!);
      const B = tileEn(answer);
      const Bz = tileZh(answer);
      const scoreEn = ratio >= 100 ? 'the same as the best discard' : `${ratio}% of the best discard's, within 10% of it`;
      const scoreZh = ratio >= 100 ? '和最好那張一樣' : `是最好那張的${ratio}%，差不到一成`;
      return {
        reasonKey: 'puzzle.value.nearBest',
        explanation: `Throwing ${B} is right too: it leaves ${b.acceptance} winning tiles worth ${fmt1(b.expectedTai!)} 台 a win on average (up to ${b.bestTai} 台), so its expected score is ${scoreEn}. ${best.explanation}`,
        explanationZh: `打${Bz}也算對：聽 ${b.acceptance} 張，平均每次胡 ${fmt1(b.expectedTai!)} 台（最多 ${b.bestTai} 台），期望值${scoreZh}。${best.explanationZh}`,
      };
    }
  }
}

/** Every puzzle theme. `Puzzle` is the two classic themes (discard and waits), the two-argument `rushPuzzle` rotation. */
export type AnyPuzzle = Puzzle | DefencePuzzle | ClaimPuzzle | ValuePuzzle;
export type PuzzleType = AnyPuzzle['type'];
