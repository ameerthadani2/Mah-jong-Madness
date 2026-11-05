/**
 * Rule-set fuzzing, ported from the engine review probe (review/engine/fuzz.ts): random, partly
 * malformed rule objects go through `sanitizeRules`, and Club bots play hands under each result.
 * Every step must conserve the 144 tiles, every hand must end, settle to zero and replay to the
 * same state hash. In each stream the first two rule sets force the dead-wall extremes (0 and 32 tiles).
 */
import { describe, expect, it } from 'vitest';
import {
  advanceMatch,
  applyAction,
  chooseAction,
  hashState,
  matchSnapshot,
  newGame,
  nextHand,
  RULE_LIMITS,
  sanitizeRules,
  replayHand,
  type GameState,
  type MatchSnapshot,
  type RuleSet,
} from '../src/index';
import { tileTotal } from './helpers/state';

const NUMERIC_KEYS = Object.keys(RULE_LIMITS) as Array<keyof typeof RULE_LIMITS>;
const BOOLEAN_KEYS = ['drawKeepsDealer', 'allowChi', 'multipleWinners', 'passRule', 'noFlowerTai'] as const;

/** Small deterministic LCG, so a failure names a reproducible rule set. */
function lcg(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

/** A rule object as an untrusted client might send it: out-of-range, fractional, NaN, wrong types. */
function randomRules(R: () => number, index: number): RuleSet {
  const junk = (): unknown => {
    const r = R();
    if (r < 0.1) return NaN;
    if (r < 0.15) return -0;
    if (r < 0.2) return 1e308;
    if (r < 0.25) return -1e308;
    if (r < 0.3) return 'x';
    if (r < 0.35) return { a: 1 };
    if (r < 0.4) return true;
    return Math.floor(R() * 80) - 10 + (R() < 0.3 ? 0.5 : 0);
  };
  const raw: Record<string, unknown> = {};
  for (const k of NUMERIC_KEYS) if (R() < 0.6) raw[k] = junk();
  for (const k of BOOLEAN_KEYS) if (R() < 0.6) raw[k] = R() < 0.5 ? true : R() < 0.5 ? false : 'true';
  if (index === 0) raw.deadWallSize = 0;
  else if (index === 1) raw.deadWallSize = 32;
  else if (index % 7 === 0) raw.deadWallSize = R() < 0.5 ? 0 : 32;
  return sanitizeRules(raw);
}

/** Play one hand with four Club bots, asserting conservation at every step. */
function playHand(s: GameState, label: string): GameState {
  let steps = 0;
  while (s.phase !== 'ended') {
    if (tileTotal(s) !== 144) throw new Error(`${label}: ${tileTotal(s)} tiles at step ${steps}`);
    let acted = false;
    for (let seat = 0; seat < 4 && !acted; seat++) {
      const a = chooseAction(s, seat, { seed: `b${seat}`, skill: 'club' });
      if (a) {
        s = applyAction(s, seat, a);
        acted = true;
      }
    }
    if (!acted) throw new Error(`${label}: nobody can act in phase ${s.phase}`);
    if (++steps > 3000) throw new Error(`${label}: hand did not terminate`);
  }
  return s;
}

describe('rule-set fuzzing', () => {
  // Two streams of 100 hands (200 in all), so each test stays within a few seconds.
  it.each([12345, 987])('Club bots finish 100 hands under random sanitised rules (stream %i) with every tile accounted for', (stream) => {
    const R = lcg(stream);
    const target = 100;
    let hands = 0;
    const deadWalls = new Set<number>();
    for (let i = 0; hands < target; i++) {
      const rules = randomRules(R, i);
      for (const k of NUMERIC_KEYS) {
        expect(Number.isInteger(rules[k])).toBe(true);
        expect(rules[k]).toBeGreaterThanOrEqual(RULE_LIMITS[k][0]);
        expect(rules[k]).toBeLessThanOrEqual(RULE_LIMITS[k][1]);
      }
      if (i === 0) expect(rules.deadWallSize).toBe(0);
      if (i === 1) expect(rules.deadWallSize).toBe(32);
      deadWalls.add(rules.deadWallSize);
      let s = newGame(`fz${i}`, rules, i % 4);
      // The snapshot each hand starts from, taken before its deal (a hand can be won at the deal).
      let snap: MatchSnapshot = { ...matchSnapshot(s), scores: [0, 0, 0, 0] };
      for (let h = 0; h < 3 && hands < target; h++) {
        const label = `rules #${i} hand ${h}`;
        const seed = s.seed;
        s = playHand(s, label);
        hands++;
        expect(tileTotal(s), label).toBe(144);
        expect(s.result, label).toBeDefined();
        expect(s.result!.scoreDelta.reduce((a, b) => a + b, 0), label).toBe(0);
        expect(hashState(replayHand(snap, seed, rules, s.actionLog)), label).toBe(hashState(s));
        if (s.matchOver) break;
        snap = advanceMatch(s);
        s = nextHand(s);
        if (s.matchOver) break;
      }
    }
    expect(hands).toBe(target);
    expect(deadWalls.has(0) && deadWalls.has(32)).toBe(true);
  }, 30_000);
});
