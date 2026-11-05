import { describe, expect, it } from 'vitest';
import {
  applyAction,
  chooseAction,
  checkDiscardAnswer,
  checkWaitsAnswer,
  countsFromKinds,
  dailyPuzzle,
  dealFromSnapshot,
  describeRules,
  discardPuzzle,
  matchSnapshot,
  newGame,
  reviewHand,
  rulesFromPreset,
  rushPuzzle,
  shanten,
  waits,
  waitsPuzzle,
  withSpeed,
  checkClaimAnswer,
  checkDefenceAnswer,
  checkValueAnswer,
  claimPuzzle,
  coachAction,
  dealInDanger,
  defencePuzzle,
  isComplete,
  PUZZLE_TYPES,
  puzzleOfType,
  scoreWin,
  threats,
  unseenCounts,
  valuePuzzle,
  DEFAULT_RULES,
  type Action,
  type ClaimPuzzle,
  type DefencePuzzle,
  type GameState,
  type Kind,
  type Meld,
  type PuzzleDifficulty,
  type PuzzleMeld,
  type ValuePuzzle,
} from '../src/index';

function playHand(s: GameState, skills: Array<'beginner' | 'club' | 'pro'>): GameState {
  let guard = 0;
  while (s.phase !== 'ended' && guard++ < 3000) {
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { seed: `t${seat}`, skill: skills[seat] });
      if (a) {
        s = applyAction(s, seat, a);
        break;
      }
    }
  }
  return s;
}

describe('rules presets and speeds', () => {
  it('applies speed presets', () => {
    const r = withSpeed(rulesFromPreset('taiwan-standard'), 'turbo');
    expect(r.turnSeconds).toBe(7);
    expect(r.timeBankSeconds).toBe(10);
    expect(describeRules(r)).toContain('Turbo');
  });
  it('presets override only their fields', () => {
    const r = rulesFromPreset('big');
    expect(r.basePoints).toBe(300);
    expect(r.handsPerMatch).toBe(16);
  });
});

describe('bot skills', () => {
  it('all skill levels complete hands and the review grades every decision', () => {
    for (let i = 0; i < 4; i++) {
      const start = newGame(`skill-${i}`);
      const snap = matchSnapshot(start);
      const end = playHand(start, ['beginner', 'club', 'pro', 'club']);
      expect(end.phase).toBe('ended');
      for (let seat = 0; seat < 4; seat++) {
        const review = reviewHand(snap, start.seed, start.rules, end.actionLog, seat);
        expect(review.accuracy).toBeGreaterThanOrEqual(0);
        expect(review.accuracy).toBeLessThanOrEqual(100);
        for (const m of review.moves) {
          expect(['best', 'good', 'inaccuracy', 'mistake', 'blunder']).toContain(m.grade);
          expect(m.explanation.length).toBeGreaterThan(0);
          expect(m.reasonKey).toMatch(/^review\./);
        }
      }
    }
  });
  it('a pro bot reviews at least as well as a beginner on average', () => {
    let pro = 0;
    let beginner = 0;
    for (let i = 0; i < 6; i++) {
      const start = newGame(`cmp-${i}`);
      const snap = matchSnapshot(start);
      const end = playHand(start, ['beginner', 'pro', 'club', 'club']);
      beginner += reviewHand(snap, start.seed, start.rules, end.actionLog, 0).accuracy;
      pro += reviewHand(snap, start.seed, start.rules, end.actionLog, 1).accuracy;
    }
    expect(pro).toBeGreaterThanOrEqual(beginner);
  });
  it('replaying from the snapshot reproduces the dealt hands', () => {
    const start = newGame('snap');
    const again = dealFromSnapshot(matchSnapshot(start), start.seed, start.rules);
    expect(again.players[0].hand).toEqual(start.players[0].hand);
  });
});

describe('puzzles', () => {
  it('discard puzzles are deterministic and solvable', () => {
    const a = discardPuzzle('x', 2);
    const b = discardPuzzle('x', 2);
    expect(a.hand).toEqual(b.hand);
    expect(a.hand).toHaveLength(17);
    expect(a.answers).toContain(a.best);
    expect(checkDiscardAnswer(a, a.best)).toBe(true);
    const wrong = a.options.filter((o) => !a.answers.includes(o.kind))[0];
    if (wrong) expect(checkDiscardAnswer(a, wrong.kind)).toBe(false);
  });
  it('waits puzzles are ready hands with the stated waits', () => {
    for (const d of [1, 2, 3] as const) {
      const p = waitsPuzzle(`w${d}`, d);
      expect(p.hand).toHaveLength(16);
      expect(shanten(countsFromKinds(p.hand), 5)).toBe(0);
      expect(waits(countsFromKinds(p.hand), 5)).toEqual(p.answers);
      expect(checkWaitsAnswer(p, p.answers)).toBe(true);
      expect(checkWaitsAnswer(p, p.answers.slice(1))).toBe(p.answers.length === 1 ? false : false);
      for (const k of p.answers) expect(p.candidates).toContain(k);
    }
  });
  it('daily puzzle is the same for the same date and differs across dates', () => {
    const d1 = dailyPuzzle(new Date(Date.UTC(2026, 10, 1)));
    const d1b = dailyPuzzle(new Date(Date.UTC(2026, 10, 1)));
    const d2 = dailyPuzzle(new Date(Date.UTC(2026, 10, 2)));
    expect(d1.hand).toEqual(d1b.hand);
    expect(d1.hand).not.toEqual(d2.hand);
  });
  it('rush puzzles alternate types and are reproducible', () => {
    const types = Array.from({ length: 6 }, (_, i) => rushPuzzle('run', i).type);
    expect(types).toEqual(['discard', 'discard', 'waits', 'discard', 'discard', 'waits']);
    expect(rushPuzzle('run', 3)).toEqual(rushPuzzle('run', 3));
  });
  it('rush rotates all five themes when asked, reproducibly, getting harder', () => {
    const run = Array.from({ length: 20 }, (_, i) => rushPuzzle('run5', i, PUZZLE_TYPES));
    expect(run.map((p) => p.type)).toEqual(Array.from({ length: 20 }, (_, i) => PUZZLE_TYPES[i % 5]));
    expect(rushPuzzle('run5', 7, PUZZLE_TYPES)).toEqual(run[7]);
    // The classic default is the same puzzle as the explicit classic rotation.
    expect(rushPuzzle('run5', 4, ['discard', 'discard', 'waits'])).toEqual(rushPuzzle('run5', 4));
    for (const p of run.slice(15)) if ('difficulty' in p) expect(p.difficulty).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The three table themes: 300 seeds × 3 difficulties each
// ---------------------------------------------------------------------------

const SEEDS = 300;
const DIFFICULTIES: PuzzleDifficulty[] = [1, 2, 3];

/** Generate every (seed, difficulty) once, timing the generator alone. */
function generateAll<T>(gen: (seed: string, d: PuzzleDifficulty) => T): { puzzles: T[]; avgMs: number } {
  const puzzles: T[] = [];
  const t0 = performance.now();
  for (const d of DIFFICULTIES) for (let i = 0; i < SEEDS; i++) puzzles.push(gen(`seed-${i}`, d));
  return { puzzles, avgMs: (performance.now() - t0) / puzzles.length };
}

const count = (hand: Kind[]) => countsFromKinds(hand);

/** A minimal table rebuilt from what a puzzle shows, for re-running the bot's danger model. */
function tableFromView(p: DefencePuzzle): GameState {
  const ids = (kinds: Kind[]) => kinds.map((k) => k * 4);
  const meld = (m: PuzzleMeld): Meld => ({ type: m.type, tiles: ids(m.kinds), concealed: m.concealed, from: m.from });
  const players = [0, 1, 2, 3].map((seat) => {
    const v = p.opponents.find((o) => o.seat === seat);
    return {
      hand: seat === 0 ? ids(p.hand) : [],
      melds: v ? v.melds.map(meld) : [],
      flowers: [],
      discards: ids(seat === 0 ? p.ownDiscards : v!.discards),
      passedWin: false,
      draws: 0,
    };
  });
  return { players } as unknown as GameState;
}

/** A claim window rebuilt from the puzzle alone (seat 0's hand and sets, the discard, the shown options). */
function claimTable(p: ClaimPuzzle): GameState {
  const next = new Map<Kind, number>();
  const id = (k: Kind) => {
    const c = next.get(k) ?? 0;
    next.set(k, c + 1);
    return k * 4 + c;
  };
  const hand = p.hand.map(id);
  const melds: Meld[] = p.melds.map((m) => ({ type: m.type, tiles: m.kinds.map(id), concealed: m.concealed, from: m.from }));
  const tile = id(p.discard);
  const byKind = (k: Kind) => hand.find((t) => Math.floor(t / 4) === k)!;
  const offer = {
    seat: 0,
    hu: p.options.some((o) => o.type === 'hu'),
    pong: p.options.some((o) => o.type === 'pong'),
    kong: p.options.some((o) => o.type === 'kong'),
    chi: p.options.filter((o) => o.type === 'chi').map((o) => [byKind(o.kinds![0]), byKind(o.kinds![1])] as [number, number]),
  };
  const empty = { hand: [], melds: [], flowers: [], discards: [], passedWin: false, draws: 1 };
  return {
    rules: DEFAULT_RULES,
    phase: 'claim',
    handNumber: 0,
    turnCounter: 0,
    turn: p.from,
    players: [{ hand, melds, flowers: [], discards: [], passedWin: false, draws: 1 }, empty, empty, empty],
    pending: { tile, from: p.from, kind: 'discard', offers: [offer], responses: {} },
  } as unknown as GameState;
}

describe('defence puzzles', () => {
  const { puzzles, avgMs } = generateAll(defencePuzzle);

  it('generate in under 5 ms on average', () => {
    expect(avgMs).toBeLessThan(5);
  });

  it('have a unique safest answer among the discards that keep shanten, and it passes its checker', () => {
    for (const p of puzzles) {
      expect(p.hand).toHaveLength(17);
      expect(shanten(count(p.hand), 5)).toBe(p.bestShanten);
      const kept = p.options.filter((o) => o.shanten === p.bestShanten);
      expect(kept.length).toBeGreaterThanOrEqual(2);
      const answer = p.options.find((o) => o.kind === p.answer)!;
      expect(answer.shanten).toBe(p.bestShanten);
      expect(kept.filter((o) => o.danger <= answer.danger)).toHaveLength(1);
      expect(checkDefenceAnswer(p, p.answer)).toBe(true);
      for (const o of p.options) if (o.kind !== p.answer) expect(checkDefenceAnswer(p, o.kind)).toBe(false);
      expect(p.threatLevel).toBeGreaterThan(0);
      expect(p.explanation.length).toBeGreaterThan(0);
      expect(p.explanationZh.length).toBeGreaterThan(0);
      expect(p.reasonKey).toBe(`puzzle.defence.${p.reason}`);
      if (p.reason === 'terminal') expect([0, 8]).toContain(p.answer % 9);
      if (p.reason.endsWith('onour')) expect(p.answer).toBeGreaterThanOrEqual(27);
    }
  });

  it('never raise shanten when an equal-shanten safe tile exists', () => {
    for (const p of puzzles) {
      const answer = p.options.find((o) => o.kind === p.answer)!;
      expect(answer.shanten).toBe(Math.min(...p.options.map((o) => o.shanten)));
      if (p.options.some((o) => o.shanten === p.bestShanten && o.danger === 0)) expect(answer.danger).toBe(0);
    }
  });

  it("agree with the bot's danger model re-run on the table as shown", () => {
    for (const p of puzzles) {
      const s = tableFromView(p);
      const levels = threats(s, 0);
      expect(levels[p.threatSeat]).toBe(p.threatLevel);
      expect(levels.filter((l) => l > 0)).toHaveLength(1);
      const unseen = unseenCounts(s, 0);
      for (const o of p.options) {
        expect(dealInDanger(s, 0, o.kind, levels, unseen)).toBeCloseTo(o.danger, 10);
        expect(shanten(count(p.hand.filter((k, i) => i !== p.hand.indexOf(o.kind))), 5)).toBe(o.shanten);
      }
    }
  });

  it('match the reason each difficulty teaches, and are deterministic', () => {
    const byDifficulty = (d: PuzzleDifficulty) => puzzles.filter((p) => p.difficulty === d);
    expect(byDifficulty(1).every((p) => p.reason === 'theirDiscard')).toBe(true);
    expect(byDifficulty(2).every((p) => p.reason === 'honour' || p.reason === 'terminal')).toBe(true);
    expect(byDifficulty(3).every((p) => p.reason === 'deadHonour' || p.reason === 'lastHonour')).toBe(true);
    for (let i = 0; i < puzzles.length; i += 15) expect(defencePuzzle(puzzles[i].seed, puzzles[i].difficulty)).toEqual(puzzles[i]);
  });
});

describe('claim puzzles', () => {
  const { puzzles, avgMs } = generateAll(claimPuzzle);

  it('generate in under 5 ms on average', () => {
    expect(avgMs).toBeLessThan(5);
  });

  it('offer exactly the legal claims, and the answer is the coach action and passes its checker', () => {
    for (const p of puzzles) {
      const setsNeeded = 5 - p.melds.length;
      const c = count(p.hand);
      expect(p.hand).toHaveLength(3 * setsNeeded + 1);
      expect(shanten(c, setsNeeded)).toBe(p.shantenBefore);
      // Independent legality: 吃 only from the left, 碰 with a pair, 槓 with three, 胡 when complete.
      const withDiscard = c.slice();
      withDiscard[p.discard]++;
      expect(p.options.some((o) => o.type === 'hu')).toBe(isComplete(withDiscard, setsNeeded));
      expect(p.options.some((o) => o.type === 'pong')).toBe(c[p.discard] >= 2);
      expect(p.options.some((o) => o.type === 'kong')).toBe(c[p.discard] >= 3);
      if (p.from !== 3) expect(p.options.some((o) => o.type === 'chi')).toBe(false);
      expect(p.options[0].type).toBe('pass');
      expect(new Set(p.options.map((o) => o.id)).size).toBe(p.options.length);
      // The coach, re-run on a table rebuilt from the puzzle alone, picks the stated answer.
      const coach = coachAction(claimTable(p), 0) as Action;
      expect(checkClaimAnswer(p, coach)).toBe(true);
      expect(checkClaimAnswer(p, p.answer)).toBe(true);
      expect(checkClaimAnswer(p, p.answer.id)).toBe(true);
      for (const o of p.options) if (o.id !== p.answer.id) expect(checkClaimAnswer(p, o)).toBe(false);
      expect(p.explanation.length).toBeGreaterThan(0);
      expect(p.explanationZh.length).toBeGreaterThan(0);
    }
  });

  it('have a unique answer under the coach evaluation', () => {
    for (const p of puzzles) {
      if (p.options.some((o) => o.type === 'hu')) {
        expect(p.answer.type).toBe('hu');
        continue;
      }
      const stay = p.melds.length === 0 && p.shantenBefore <= 0;
      const gain = (o: (typeof p.options)[number]) => p.shantenBefore - o.shantenAfter + (o.type === 'kong' ? 0.5 : 0) - (stay ? 1 : 0);
      const claims = p.options.filter((o) => o.type !== 'pass');
      if (p.answer.type === 'pass') expect(claims.every((o) => gain(o) <= 0)).toBe(true);
      else {
        expect(gain(p.answer)).toBeGreaterThan(0);
        for (const o of claims) if (o.id !== p.answer.id) expect(gain(o)).toBeLessThan(gain(p.answer));
      }
    }
  });

  it('scale options with difficulty, mix passing and claiming, and are deterministic', () => {
    const of = (d: PuzzleDifficulty) => puzzles.filter((p) => p.difficulty === d);
    expect(of(1).filter((p) => p.options.length === 2).length).toBeGreaterThan(SEEDS * 0.95);
    expect(of(2).filter((p) => p.options.length === 3).length).toBeGreaterThan(SEEDS * 0.95);
    expect(of(3).filter((p) => p.options.length >= 4).length).toBeGreaterThan(SEEDS * 0.95);
    const passes = puzzles.filter((p) => p.answer.type === 'pass').length;
    expect(passes).toBeGreaterThan(puzzles.length * 0.2);
    expect(passes).toBeLessThan(puzzles.length * 0.8);
    for (let i = 0; i < puzzles.length; i += 15) expect(claimPuzzle(puzzles[i].seed, puzzles[i].difficulty)).toEqual(puzzles[i]);
  });
});

describe('value puzzles', () => {
  const { puzzles, avgMs } = generateAll(valuePuzzle);

  it('generate in under 5 ms on average', () => {
    expect(avgMs).toBeLessThan(5);
  });

  it('keep the hand ready either way, with a unique higher-台 answer that passes its checker', () => {
    puzzles.forEach((p: ValuePuzzle, n) => {
      const setsNeeded = 5 - p.melds.length;
      expect(p.hand).toHaveLength(3 * setsNeeded + 2);
      const c = count(p.hand);
      expect(isComplete(c, setsNeeded)).toBe(false);
      const without = (k: Kind) => {
        const x = c.slice();
        x[k]--;
        return x;
      };
      // Ready means some tile completes the hand: the engine's waits() agrees for every option, and
      // its shanten (slow on whole-suit hands, so on every third puzzle) says 0 for the answer and rival.
      for (const o of p.options) expect(waits(without(o.kind), setsNeeded).length > 0).toBe(o.ready);
      if (n % 3 === 0) {
        expect(shanten(without(p.answer), setsNeeded)).toBe(0);
        expect(shanten(without(p.rival), setsNeeded)).toBe(0);
      }
      const answer = p.options.find((o) => o.kind === p.answer)!;
      const others = p.options.filter((o) => o.ready && o.kind !== p.answer);
      expect(others.length).toBeGreaterThan(0);
      for (const o of others) expect(o.projectedTai!).toBeLessThan(answer.projectedTai!);
      expect(answer.items!.some((i) => i.key === p.patternKey)).toBe(true);
      expect(p.options.find((o) => o.kind === p.rival)!.items!.some((i) => i.key === p.patternKey)).toBe(false);
      // The projected 台 comes from a real scored win on one of the answer's live waits.
      const rest = p.hand.slice();
      rest.splice(rest.indexOf(p.answer), 1);
      const melds: Meld[] = p.melds.map((m) => ({ type: m.type, tiles: m.kinds.map((k, i) => k * 4 + i), concealed: m.concealed, from: m.from }));
      const scored = answer.waits!.map((w) =>
        scoreWin({ rules: DEFAULT_RULES, seat: 0, dealerSeat: p.dealerSeat, dealerStreak: 0, prevailingWind: p.prevailingWind, concealed: rest, melds, flowers: [], winningTile: w, selfDrawn: false, fromSeat: 1 }),
      );
      expect(scored.some((r) => r.items.some((i) => i.key === p.patternKey))).toBe(true);
      expect(checkValueAnswer(p, p.answer)).toBe(true);
      for (const o of p.options) if (o.kind !== p.answer) expect(checkValueAnswer(p, o.kind)).toBe(false);
      expect(p.explanation).toContain(p.patternEn);
      expect(p.explanationZh.length).toBeGreaterThan(0);
    });
  });

  it('match each difficulty (1: no speed trade, 3: the rival is faster) and are deterministic', () => {
    const acc = (p: ValuePuzzle, k: Kind) => p.options.find((o) => o.kind === k)!.acceptance!;
    expect(puzzles.filter((p) => p.difficulty === 1).every((p) => acc(p, p.answer) >= acc(p, p.rival))).toBe(true);
    expect(puzzles.filter((p) => p.difficulty === 3).every((p) => acc(p, p.rival) > acc(p, p.answer))).toBe(true);
    // Several patterns turn up, not only one.
    expect(new Set(puzzles.map((p) => p.patternKey)).size).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < puzzles.length; i += 15) expect(valuePuzzle(puzzles[i].seed, puzzles[i].difficulty)).toEqual(puzzles[i]);
  });
});

describe('puzzleOfType', () => {
  it('builds every theme with its own type', () => {
    for (const t of PUZZLE_TYPES) expect(puzzleOfType(t, 'any', 2).type).toBe(t);
  });
});
