import { describe, expect, it } from 'vitest';
import { timeBound } from './helpers/timing';
import { DISCARD_RULES, neighbourWeightRules, setsFirstRules, type DiscardRule } from './helpers/discardRules';
import {
  checkDiscardAnswer,
  countsFromKinds,
  DAILY_DISCARD_OPTIONS,
  dailyPuzzle,
  discardOptions,
  discardPuzzle,
  ruleOfThumbPicks,
  RULE_PROOF_PUZZLE_SHARE,
  sha256Hex,
  SPREAD_DISCARDS_PER_ANSWER,
  type DiscardPuzzle,
} from '../src/index';

// How often a rule of thumb answers the daily and hard discard puzzles, against random guessing.
//
// Measured on 18 November 2026 on 365 dailies from that date and 300 hard puzzles on fresh seeds
// (u18d3-0 ...), after (before) the change: random guessing 49 and 30 (65 and 44);
// "fewest steps to ready, then fewest neighbours" 160 and 119 (253 and 242); "fewest neighbours" 159 and
// 115 (227 and 186); the least connected tile 159 and 109 (200 and 161); "fewest steps, then break the pair
// with the most neighbours" 161 and 136; the isolated-tile rule 141 and 85 (114 and 76).
//
// The seventh pass's engine checker then read the hand another way: take out the complete sets (pongs
// first, then runs from the low end of each suit) and throw the leftover with the fewest neighbours among
// the leftovers. That was right on 268 and 274 of 365 dailies from 2027 and 2029 and 217 of 300 hard
// puzzles (vfy18h-0 ...), since a rule-proof hand's answer is often one of a pair inside a run, a leftover
// single to that read. Since then medium and hard rule-proof hands beat the sets-first reads too
// (`ruleOfThumbPicks` with `sets`), and a larger share of their seeds draw one (RULE_PROOF_PUZZLE_SHARE).
// Measured on 19 November 2026: the checker's read is right on 207 and 217 of those dailies and 117 of
// those hard puzzles; on 300 more hard seeds (u18r-h-0 ...) every rule here is right on under 43%. The
// easy dailies (Monday, Wednesday, Friday) still give way to it, about three times in four: proving them
// against it as well took a walk too long for a phone (a median over 100 ms) and made the other rules
// stronger there, so the easy daily keeps it as the lesson of the day.

const rate = (puzzles: readonly DiscardPuzzle[], rule: DiscardRule) => puzzles.filter((p) => checkDiscardAnswer(p, rule(p.hand))).length / puzzles.length;
/** The expected share right when guessing one of the hand's kinds at random. */
const randomGuess = (puzzles: readonly DiscardPuzzle[]) =>
  puzzles.reduce((sum, p) => {
    const kinds = [...new Set(p.hand)];
    return sum + kinds.filter((k) => p.answers.includes(k)).length / kinds.length;
  }, 0) / puzzles.length;

const RULES: Record<string, DiscardRule> = {
  ...DISCARD_RULES,
  ...neighbourWeightRules(),
};
const SETS_FIRST: Record<string, DiscardRule> = setsFirstRules();

describe('how often a rule of thumb answers the daily and hard discard puzzles', () => {
  const dailyMs: number[] = [];
  // 24 weeks, so every weekday's difficulty is counted alike.
  const days = Array.from({ length: 168 }, (_, i) => new Date(Date.UTC(2027, 0, 4 + i)));
  const dailies = days.map((day) => {
    const t0 = performance.now();
    const p = dailyPuzzle(day);
    dailyMs.push(performance.now() - t0);
    return p;
  });
  /** The medium and hard dailies (Tuesday, Thursday and the weekend), as `dailyPuzzle` picks the difficulty. */
  const harderDailies = dailies.filter((_, i) => days[i].getUTCDay() % 2 === 0);
  const hardMs: number[] = [];
  const hard = Array.from({ length: 150 }, (_, i) => {
    const t0 = performance.now();
    const p = discardPuzzle(`rules-h-${i}`, 3);
    hardMs.push(performance.now() - t0);
    return p;
  });
  const over = (puzzles: readonly DiscardPuzzle[], rules: Record<string, DiscardRule>, bar: number) =>
    Object.entries(rules)
      .map(([name, rule]) => [name, rate(puzzles, rule)] as const)
      .filter(([, r]) => r >= bar);

  it('on hard puzzles every rule measured is right on under half, the sets-first reads included, each well above random guessing', () => {
    expect(over(hard, { ...RULES, ...SETS_FIRST }, 0.48)).toEqual([]);
    expect(randomGuess(hard)).toBeLessThan(0.15);
    expect(Math.max(...Object.values({ ...RULES, ...SETS_FIRST }).map((rule) => rate(hard, rule)))).toBeGreaterThan(0.3);
  });

  it('on daily puzzles every rule measured but the sets-first reads is right on under half; those are right on under half of the medium and hard dailies, and on most easy ones', () => {
    expect(over(dailies, RULES, 0.48)).toEqual([]);
    expect(randomGuess(dailies)).toBeLessThan(0.2);
    expect(Math.max(...Object.values(RULES).map((rule) => rate(dailies, rule)))).toBeGreaterThan(0.3);
    expect(harderDailies.length).toBe(96);
    expect(over(harderDailies, SETS_FIRST, 0.5)).toEqual([]);
    // Over every day of the week, well under the three in four of before.
    expect(over(dailies, SETS_FIRST, 0.62)).toEqual([]);
  });

  it('about half are rule-proof (no tile a rule of thumb throws first is accepted), and the rest have a spread', () => {
    for (const puzzles of [dailies, hard]) {
      const proof = puzzles.filter((p) => !ruleOfThumbPicks(p.hand).some((k) => p.answers.includes(k))).length;
      const keep = (p: DiscardPuzzle) => p.options.filter((o) => o.shanten === p.bestShanten).length;
      const spread = puzzles.filter((p) => ruleOfThumbPicks(p.hand).some((k) => p.answers.includes(k)) && keep(p) >= SPREAD_DISCARDS_PER_ANSWER * p.answers.length).length;
      // The share is drawn per seed (and a tenth of seeds keep a lone honour), and a medium or hard walk that
      // must beat the sets-first reads too settles for a spread hand more often, so the counts are loose.
      expect(proof / puzzles.length).toBeGreaterThan(0.38);
      expect(proof / puzzles.length).toBeLessThan(0.68);
      expect((proof + spread) / puzzles.length).toBeGreaterThan(0.8);
    }
    // Hard rule-proof hands beat the sets-first reads as well (a few spread hands are rule-proof by chance, not by the walk).
    const hardProof = hard.filter((p) => !ruleOfThumbPicks(p.hand).some((k) => p.answers.includes(k)));
    const setsProof = hardProof.filter((p) => !ruleOfThumbPicks(p.hand, { sets: true }).some((k) => p.answers.includes(k)));
    expect(setsProof.length).toBeGreaterThanOrEqual(0.9 * hardProof.length);
    expect(RULE_PROOF_PUZZLE_SHARE[1]).toBeLessThan(RULE_PROOF_PUZZLE_SHARE[3]);
  });

  it('keeps every answer exact: each discard within 10 percent of the best acceptance, at the best shanten', () => {
    for (const p of [...dailies, ...hard]) {
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
    expect(dailyPuzzle(new Date(Date.UTC(2027, 0, 4)))).toEqual(discardPuzzle('daily-2027-01-04', 1, DAILY_DISCARD_OPTIONS));
    // The slowest of 365 dailies took about 150 ms on 18 November 2026 (the first, before the shanten tables fill), a hard puzzle about 50 ms.
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

describe('medium and easy discard puzzles stay as they were', () => {
  // Hands and answers of 120 seeds, recorded on 18 November 2026 before the hard and daily puzzles
  // changed; the explanation fields are left out of the hash (their wording may change).
  const pinned = {
    1: 'b4c15eac9eee2354943d28ed718993a321fbe64220f92691629b56397ccce443',
    2: '95ff08692958fa1ea27acdec232b1fa0d33b7aadbfd914b9293792a148c06af5',
  } as const;
  for (const d of [1, 2] as const) {
    it(`difficulty ${d}: 120 seeded puzzles are byte-identical`, () => {
      const all = Array.from({ length: 120 }, (_, i) => discardPuzzle(`pin-${i}`, d));
      const recorded = all.map(({ reasonKey: _k, explanation: _e, explanationZh: _z, ...rest }) => rest);
      expect(sha256Hex(JSON.stringify(recorded))).toBe(pinned[d]);
    });
  }
});
