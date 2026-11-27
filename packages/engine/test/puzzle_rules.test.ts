import { describe, expect, it } from 'vitest';
import { timeBound } from './helpers/timing';
import { DISCARD_RULES, fewestStepsThenNeighbours, neighbourWeightRules, setsFirstRules, type DiscardRule } from './helpers/discardRules';
import {
  ANSWER_DEPTH_SHARE,
  checkDiscardAnswer,
  countsFromKinds,
  DAILY_DISCARD_OPTIONS,
  dailyPuzzle,
  discardOptions,
  discardPuzzle,
  ruleOfThumbPicks,
  sha256Hex,
  shanten,
  type DiscardPuzzle,
} from '../src/index';

// How often a rule of thumb answers the daily, hard and medium discard puzzles, against random guessing.
//
// Until 18 November 2026 the obvious tile was right on nearly every puzzle ("fewest steps to ready, then fewest
// neighbours" on 253 of 365 dailies and 242 of 300 hard puzzles). Then hard puzzles and the daily were split into
// rule-proof hands, where no tile a rule of thumb throws first was accepted, and spread hands. That made the
// opposite a rule: the eighth assessment's challenger found "fewest steps, skip every such tile, then fewest
// neighbours" right on 155 of 300 hard puzzles (52%), a sets-first read right on 119 of 156 easy dailies (76%),
// and greedy on 218 of 300 medium drills, which were never rule-proofed.
//
// Since 26 November 2026 medium and hard drills and the daily place the answer at a depth each seed draws among
// the orders rules of thumb throw the tiles in (ANSWER_DEPTH_SHARE, `answerDepth` in src/puzzles.ts): some rule's
// first pick is right on about a third, its second pick or later on the rest. Measured on fresh seed sets fixed
// before the change was tuned (300 hard u21rep-h-*, 300 medium u21rep-m-*, the 365 dailies from 1 January 2033),
// the strongest of the rules measured (the 43 here and the assessors') was right on 30.3% of hard puzzles (chance 10.4%, 28.4%
// among the discards that keep the hand closest to ready), 34.4% of medium and hard dailies (10.8%, 25.8%), 36.3% of
// medium drills (12.2%, 25.6%) and 44.9% of easy dailies (15.9%, 25.4%); the obvious tile ("fewest steps, then
// fewest neighbours") on 26.0%, 16.3%, 33.7% and 35.9%, about as often as a guess among those discards. On the sets
// below, before (after): the strongest rule 42.0% (32.0%) of hard puzzles, 43.8% (38.5%) of medium and hard dailies,
// 92.0% (34.7%) of medium drills, 75.0% (41.7%) of easy dailies; the obvious tile 39.3% (22.7%), 38.5% (27.1%),
// 78.7% (33.3%) and 56.9% (33.3%).
//
// Unit 21's check then found the spare tile (fewest steps, then from the suit holding one over a multiple of three
// tiles, the fewest kinds next to it) right on 49 to 53% of fresh hard puzzles; it is among the rules below now, and
// since 27 November 2026 among the orders the answer is placed by. Measured once on sets fixed beforehand (1,000 hard
// r21r-h-*, 1,000 medium r21r-m-*, the 730 dailies from 1 January 2046): 26.0% of hard puzzles (50.8% before),
// 22.9% of medium drills, 21.6% of medium and hard dailies and 22.0% of easy ones; no rule measured reaches its bar.

const rate = (puzzles: readonly DiscardPuzzle[], rule: DiscardRule) => puzzles.filter((p) => checkDiscardAnswer(p, rule(p.hand))).length / puzzles.length;
/** The expected share right when guessing one of the hand's kinds at random. */
const randomGuess = (puzzles: readonly DiscardPuzzle[]) =>
  puzzles.reduce((sum, p) => {
    const kinds = [...new Set(p.hand)];
    return sum + kinds.filter((k) => p.answers.includes(k)).length / kinds.length;
  }, 0) / puzzles.length;
/** The same, guessing among the discards that keep the hand closest to ready. */
const bestGuess = (puzzles: readonly DiscardPuzzle[]) =>
  puzzles.reduce((sum, p) => {
    const best = p.options.filter((o) => o.shanten === p.bestShanten);
    return sum + best.filter((o) => p.answers.includes(o.kind)).length / best.length;
  }, 0) / puzzles.length;

/** Counting, not a rule of thumb: fewest steps to ready, then the most kinds of tile that improve the hand (copies not counted). */
const countKinds: DiscardRule = (hand) => {
  const c = countsFromKinds(hand);
  const after = (k: number): [number, number] => {
    c[k]--;
    const sh = shanten(c, 5);
    let n = 0;
    for (let t = 0; t < 34; t++) {
      if (c[t] >= 4) continue;
      c[t]++;
      if (shanten(c, 5) < sh) n++;
      c[t]--;
    }
    c[k]++;
    return [sh, n];
  };
  const score = new Map([...new Set(hand)].map((k) => [k, after(k)]));
  return [...score.keys()].sort((a, b) => score.get(a)![0] - score.get(b)![0] || score.get(b)![1] - score.get(a)![1] || a - b)[0];
};

const RULES: Record<string, DiscardRule> = {
  ...DISCARD_RULES,
  ...neighbourWeightRules(),
  ...setsFirstRules(),
};

describe('how often a rule of thumb answers the daily, hard and medium discard puzzles', () => {
  const dailyMs: number[] = [];
  // 24 weeks, so every weekday's difficulty is counted alike.
  const days = Array.from({ length: 168 }, (_, i) => new Date(Date.UTC(2027, 0, 4 + i)));
  const dailies = days.map((day) => {
    const t0 = performance.now();
    const p = dailyPuzzle(day);
    dailyMs.push(performance.now() - t0);
    return p;
  });
  /** The medium and hard dailies (Tuesday, Thursday and the weekend), as `dailyPuzzle` picks the difficulty, and the easy ones. */
  const harderDailies = dailies.filter((_, i) => days[i].getUTCDay() % 2 === 0);
  const easyDailies = dailies.filter((_, i) => days[i].getUTCDay() % 2 === 1);
  const hardMs: number[] = [];
  const hard = Array.from({ length: 150 }, (_, i) => {
    const t0 = performance.now();
    const p = discardPuzzle(`rules-h-${i}`, 3);
    hardMs.push(performance.now() - t0);
    return p;
  });
  const medium = Array.from({ length: 150 }, (_, i) => discardPuzzle(`rules-m-${i}`, 2));
  const over = (puzzles: readonly DiscardPuzzle[], bar: number) =>
    Object.entries(RULES)
      .map(([name, rule]) => [name, rate(puzzles, rule)] as const)
      .filter(([, r]) => r >= bar);
  /** The bars of the eighth assessment's goal: hard puzzles and medium and hard dailies, medium drills, easy dailies. */
  const groups = [
    ['hard puzzles', hard, 0.45],
    ['medium and hard dailies', harderDailies, 0.45],
    ['medium drills', medium, 0.5],
    ['easy dailies', easyDailies, 0.6],
  ] as const;

  it('every rule measured, "avoid the obvious tile" included, is right on under 45% of hard puzzles and medium and hard dailies, 50% of medium drills and 60% of easy dailies', () => {
    expect(harderDailies.length).toBe(96);
    for (const [name, puzzles, bar] of groups) {
      expect(over(puzzles, bar), name).toEqual([]);
      // Each still well above random guessing: the puzzles are not noise.
      expect(Math.max(...Object.values(RULES).map((rule) => rate(puzzles, rule))), name).toBeGreaterThan(2 * randomGuess(puzzles));
    }
  });

  it('the obvious tile is right about as often as a guess among the discards that keep the hand closest to ready, neither always nor never', () => {
    for (const [name, puzzles] of groups) {
      const obvious = rate(puzzles, fewestStepsThenNeighbours);
      expect(obvious, name).toBeGreaterThan(0.6 * bestGuess(puzzles));
      expect(obvious, name).toBeLessThan(1.5 * bestGuess(puzzles));
      expect(obvious, name).toBeGreaterThan(0.15);
    }
    expect(ANSWER_DEPTH_SHARE.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('counting the tiles that improve the hand still finds the answer on most', () => {
    for (const [name, puzzles] of groups) expect(rate(puzzles, countKinds), name).toBeGreaterThan(0.75);
  });

  it('keeps every answer exact: each discard within 10 percent of the best acceptance, at the best shanten', () => {
    for (const p of [...dailies, ...hard, ...medium]) {
      const counts = countsFromKinds(p.hand);
      const opts = discardOptions(
        counts,
        5,
        counts.map((c) => 4 - c),
      );
      const sh = Math.min(...opts.map((o) => o.shanten));
      const top = Math.max(...opts.filter((o) => o.shanten === sh).map((o) => o.acceptance));
      expect([...p.answers].sort((a, b) => a - b)).toEqual(
        opts
          .filter((o) => o.shanten === sh && o.acceptance >= top * 0.9)
          .map((o) => o.kind)
          .sort((a, b) => a - b),
      );
      // Still a decision: never more than a third of the discards accepted.
      expect(p.answers.length).toBeLessThanOrEqual(Math.max(2, Math.floor(opts.length / 3)));
    }
  });

  it('gives the same puzzle for the same seed, quickly enough for the server to make it again', () => {
    expect(dailyPuzzle(new Date(Date.UTC(2027, 0, 9)))).toEqual(dailies[5]);
    expect(discardPuzzle('rules-h-12', 3)).toEqual(hard[12]);
    expect(discardPuzzle('rules-m-7', 2)).toEqual(medium[7]);
    expect(dailyPuzzle(new Date(Date.UTC(2027, 0, 4)))).toEqual(discardPuzzle('daily-2027-01-04', 1, DAILY_DISCARD_OPTIONS));
    // On an idle machine on 26 November 2026: a daily about 10 ms (median) and at most about 250 ms, a hard puzzle about 8 ms and 100 ms.
    for (const ms of [dailyMs, hardMs]) {
      const sorted = [...ms].sort((a, b) => a - b);
      expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(timeBound(30));
      expect(sorted[sorted.length - 1]).toBeLessThan(timeBound(600));
    }
  });
});

describe('the rules of thumb, as the generator reads them', () => {
  it('name the least connected tile by any count, the outermost tile and the outermost single', () => {
    // 1m 2m 3m 5m 7m | 4p 4p 5p | 9s | E E E | C C C | W: the lone West is isolated; 9s is isolated too.
    const hand = [0, 1, 2, 4, 6, 12, 12, 13, 26, 27, 27, 27, 29, 31, 31, 31, 30];
    const picks = ruleOfThumbPicks(hand);
    expect(picks).toContain(29); // West: an isolated honour
    expect(picks).toContain(30); // North
    // A tile in the middle of a run is never one.
    expect(picks).not.toContain(1);
  });
});

describe('easy and medium discard drills stay as recorded', () => {
  // Hands and answers of 120 seeds; the explanation fields are left out of the hash (their wording may change).
  // Easy: recorded on 18 November 2026, before the hard and daily puzzles changed, and unchanged since. Medium:
  // recorded again on 26 November 2026, when medium drills began to place the answer by depth (was
  // 95ff08692958fa1ea27acdec232b1fa0d33b7aadbfd914b9293792a148c06af5), and on 27 November 2026, when the spare-tile
  // orders joined the depth placement (was 038a8a88f574702fb16e5ea56616bcf79bacc12b40c55e859f6bcb96195c0e18).
  const pinned = {
    1: 'b4c15eac9eee2354943d28ed718993a321fbe64220f92691629b56397ccce443',
    2: '2e418ee78f10912382aa12c2e361e45816f390bb5f3024fbff4f1dcc7989c9da',
  } as const;
  for (const d of [1, 2] as const) {
    it(`difficulty ${d}: 120 seeded puzzles are byte-identical`, () => {
      const all = Array.from({ length: 120 }, (_, i) => discardPuzzle(`pin-${i}`, d));
      const recorded = all.map(({ reasonKey: _k, explanation: _e, explanationZh: _z, ...rest }) => rest);
      expect(sha256Hex(JSON.stringify(recorded))).toBe(pinned[d]);
    });
  }
});
