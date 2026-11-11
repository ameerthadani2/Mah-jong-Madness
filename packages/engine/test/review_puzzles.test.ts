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
  CLAIM_TOLERANCE,
  DEFENCE_TOLERANCE,
  defencePuzzle,
  isComplete,
  PUZZLE_TYPES,
  puzzleOfType,
  readOpponents,
  scoreWin,
  unseenCounts,
  valuePuzzle,
  VALUE_SELF_DRAW_SHARE,
  VALUE_TOLERANCE,
  waitChance,
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
  return { players, rules: DEFAULT_RULES, dealerSeat: 0, dealerStreak: 0, prevailingWind: 0 } as unknown as GameState;
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

  it('generate in under 50 ms on average', () => {
    expect(avgMs).toBeLessThan(50);
  });

  it('accept every near-safest discard that keeps shanten, and only those', () => {
    for (const p of puzzles) {
      expect(p.hand).toHaveLength(17);
      expect(shanten(count(p.hand), 5)).toBe(p.bestShanten);
      expect(p.opponents.find((o) => o.seat === p.threatSeat)!.melds).toHaveLength(4);
      const kept = p.options.filter((o) => o.shanten === p.bestShanten);
      expect(kept.length).toBeGreaterThanOrEqual(3);
      const chance = (o: (typeof kept)[number]) => o.danger / p.threatLevel;
      const min = Math.min(...kept.map(chance));
      expect(p.answers.slice().sort((a, b) => a - b)).toEqual(kept.filter((o) => chance(o) <= min + DEFENCE_TOLERANCE + 1e-12).map((o) => o.kind));
      expect(p.answers).toContain(p.answer);
      for (const o of p.options) expect(checkDefenceAnswer(p, o.kind)).toBe(p.answers.includes(o.kind));
      expect(p.options.filter((o) => o.shanten > p.bestShanten).every((o) => !o.accepted)).toBe(true);
      expect(p.threatLevel).toBeGreaterThan(0.85);
      expect(p.explanation.length).toBeGreaterThan(0);
      expect(p.explanationZh.length).toBeGreaterThan(0);
      expect(p.reasonKey).toBe(`puzzle.defence.${p.reason}`);
      if (p.reason === 'terminal') expect([0, 8]).toContain(p.answer % 9);
      if (p.reason.endsWith('onour')) expect(p.answer).toBeGreaterThanOrEqual(27);
    }
  });

  it("agree with the bots' deal-in model re-run on the table as shown", () => {
    for (const p of puzzles) {
      const s = tableFromView(p);
      const read = readOpponents(s, 0)[p.threatSeat];
      expect(read.tenpai).toBe(p.threatLevel);
      const unseen = unseenCounts(s, 0);
      for (const o of p.options) {
        expect(read.tenpai * waitChance(read, o.kind, unseen)).toBeCloseTo(o.danger, 12);
        expect(shanten(count(p.hand.filter((k, i) => i !== p.hand.indexOf(o.kind))), 5)).toBe(o.shanten);
      }
    }
  });

  it('agree with an exact enumeration of every hand the threat could hold', () => {
    // Every four-tile concealed hand, once, with its winning kinds (engine waits for one set and a pair).
    const hands: Array<{ counts: Array<[Kind, number]>; wins: Kind[] }> = [];
    const c = new Array<number>(34).fill(0);
    const walk = (from: number, left: number) => {
      if (left === 0) {
        const wins = waits(c, 1);
        if (wins.length > 0) hands.push({ counts: c.flatMap((n, k) => (n > 0 ? [[k, n] as [Kind, number]] : [])), wins });
        return;
      }
      for (let k = from; k < 34; k++) {
        for (let n = 1; n <= Math.min(4, left); n++) {
          c[k] += n;
          walk(k + 1, left - n);
          c[k] -= n;
        }
      }
    };
    walk(0, 4);
    const choose = (n: number, k: number): number => (k > n ? 0 : k === 0 ? 1 : (n * choose(n - 1, k - 1)) / k);
    for (const p of puzzles.filter((_, i) => i % 3 === 0)) {
      const s = tableFromView(p);
      const unseen = unseenCounts(s, 0);
      const threat = p.opponents.find((o) => o.seat === p.threatSeat)!;
      // Not a wait: a kind the threat threw, or one thrown after its last discard by a seat between it and you.
      const excluded = new Set(threat.discards);
      for (let seat = p.threatSeat + 1; seat < 4; seat++) {
        const d = p.opponents.find((o) => o.seat === seat)!.discards;
        if (d.length > 0) excluded.add(d[d.length - 1]);
      }
      const win = new Array<number>(34).fill(0);
      let total = 0;
      for (const h of hands) {
        if (h.wins.some((w) => excluded.has(w))) continue;
        const weight = h.counts.reduce((x, [k, n]) => x * choose(unseen[k], n), 1);
        if (weight === 0) continue;
        total += weight;
        for (const w of h.wins) win[w] += weight;
      }
      const kept = p.options.filter((o) => o.shanten === p.bestShanten);
      for (const o of p.options) expect(o.exact).toBeCloseTo(win[o.kind] / total, 9);
      const exactMin = Math.min(...kept.map((o) => o.exact));
      // The exact safest tile is accepted, every accepted tile is within 1.5 points of it, and a wrong tile is clearly worse.
      expect(kept.some((o) => o.accepted && o.exact <= exactMin + 1e-9)).toBe(true);
      for (const o of kept) if (o.accepted) expect(o.exact).toBeLessThanOrEqual(exactMin + 0.015);
      expect(kept.some((o) => !o.accepted && o.exact >= exactMin + 0.02)).toBe(true);
    }
  }, 120_000);

  it('never mark a discard wrong that the exact count rates as safe as an accepted one, or safer', () => {
    // A wider sweep than the shared set: the model and the count disagree on about 3% of tables.
    const sweep = [...puzzles];
    for (let i = 0; i < 120; i++) sweep.push(defencePuzzle(`order-${i}`, (1 + (i % 3)) as PuzzleDifficulty));
    for (const p of sweep) {
      const kept = p.options.filter((o) => o.shanten === p.bestShanten);
      const acceptedMax = Math.max(...kept.filter((o) => o.accepted).map((o) => o.exact));
      for (const o of kept) if (!o.accepted) expect(o.exact, `${p.seed} d${p.difficulty} kind ${o.kind}`).toBeGreaterThan(acceptedMax);
    }
  });

  it('are not a fixed lookup rule: several reasons, several accepted answers, and deterministic', () => {
    // The old three-step rule ("their discard > fewest-unseen honour > terminal") reproduced every answer.
    let ruleHits = 0;
    for (const p of puzzles) {
      const s = tableFromView(p);
      const unseen = unseenCounts(s, 0);
      const threat = p.opponents.find((o) => o.seat === p.threatSeat)!;
      const kept = p.options.filter((o) => o.shanten === p.bestShanten).map((o) => o.kind);
      const theirs = kept.filter((k) => threat.discards.includes(k));
      const honours = kept.filter((k) => k >= 27).sort((a, b) => unseen[a] - unseen[b]);
      const pick = theirs[0] ?? honours[0] ?? kept.find((k) => k % 9 === 0 || k % 9 === 8);
      if (pick !== undefined && p.answers.length === 1 && p.answers[0] === pick) ruleHits++;
    }
    expect(ruleHits).toBeLessThan(puzzles.length * 0.75);
    expect(new Set(puzzles.map((p) => p.reason)).size).toBeGreaterThanOrEqual(5);
    expect(puzzles.filter((p) => p.answers.length > 1).length).toBeGreaterThan(puzzles.length * 0.1);
    for (let i = 0; i < puzzles.length; i += 15) expect(defencePuzzle(puzzles[i].seed, puzzles[i].difficulty)).toEqual(puzzles[i]);
  });
});

describe('claim puzzles', () => {
  const { puzzles, avgMs } = generateAll(claimPuzzle);

  it('generate in under 50 ms on average', () => {
    expect(avgMs).toBeLessThan(50);
  });

  it('offer exactly the legal claims, and the coach action is always one of the accepted answers', () => {
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
      // The coach, re-run on a table rebuilt from the puzzle alone, picks an accepted answer.
      const coach = coachAction(claimTable(p), 0) as Action;
      expect(checkClaimAnswer(p, coach)).toBe(true);
      expect(p.answers).toContain(p.answer.id);
      for (const o of p.options) expect(checkClaimAnswer(p, o)).toBe(p.answers.includes(o.id));
      expect(p.answers.length).toBeLessThan(p.options.length);
      expect(p.explanation.length).toBeGreaterThan(0);
      expect(p.explanationZh.length).toBeGreaterThan(0);
    }
  });

  it('accept the lowest shanten on offer and, there, the most valuable choices', () => {
    for (const p of puzzles) {
      if (p.options.some((o) => o.type === 'hu')) {
        expect(p.answers).toEqual(['hu']);
        continue;
      }
      const lowest = Math.min(...p.options.map((o) => o.shantenAfter));
      const top = Math.max(...p.options.filter((o) => o.shantenAfter === lowest).map((o) => o.value));
      for (const o of p.options) expect(o.accepted).toBe(o.shantenAfter === lowest && o.value >= CLAIM_TOLERANCE * top);
      // A ready result is judged by its live winning tiles, so it lists them.
      for (const o of p.options) if (o.shantenAfter === 0) expect(o.waits!.length).toBeGreaterThan(0);
    }
  });

  it('weigh 台 and wait quality: a ready pass is scored from its live waits by the engine scorer', () => {
    let checked = 0;
    for (const p of puzzles) {
      const pass = p.options.find((o) => o.type === 'pass')!;
      if (pass.shantenAfter !== 0) continue;
      const c = count(p.hand);
      const melds: Meld[] = p.melds.map((m) => ({ type: m.type, tiles: m.kinds.map((k, i) => k * 4 + i), concealed: m.concealed, from: m.from }));
      const meldCounts = count(p.melds.flatMap((m) => m.kinds));
      // The discard already sits in its thrower's row.
      const seen = count([...p.hand, ...p.ownDiscards, ...p.melds.flatMap((m) => m.kinds), ...p.opponents.flatMap((o) => [...o.discards, ...o.melds.flatMap((m) => m.kinds)])]);
      let value = 0;
      for (const w of waits(c, 5 - p.melds.length)) {
        const live = Math.min(4 - seen[w], 4 - c[w] - meldCounts[w]);
        if (live <= 0) continue;
        const ctx = { rules: DEFAULT_RULES, seat: 0, dealerSeat: p.dealerSeat, dealerStreak: 0, prevailingWind: p.prevailingWind, concealed: p.hand, melds, flowers: [], winningTile: w };
        const d = scoreWin({ ...ctx, selfDrawn: false, fromSeat: 1 }).tai;
        const sd = scoreWin({ ...ctx, selfDrawn: true }).tai;
        value += live * (0.75 * (100 + 20 * d) + 0.25 * 3 * (100 + 20 * sd));
      }
      expect(pass.value).toBeCloseTo(value, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('scale options with difficulty, mix passing and claiming, rarely ask 胡-or-pass, and are deterministic', () => {
    const of = (d: PuzzleDifficulty) => puzzles.filter((p) => p.difficulty === d);
    expect(of(1).filter((p) => p.options.length === 2).length).toBeGreaterThan(SEEDS * 0.95);
    expect(of(2).filter((p) => p.options.length === 3).length).toBeGreaterThan(SEEDS * 0.95);
    expect(of(3).filter((p) => p.options.length >= 4).length).toBeGreaterThan(SEEDS * 0.95);
    const passes = puzzles.filter((p) => p.answer.type === 'pass').length;
    expect(passes).toBeGreaterThan(puzzles.length * 0.2);
    expect(passes).toBeLessThan(puzzles.length * 0.8);
    expect(puzzles.filter((p) => p.options.some((o) => o.type === 'hu')).length).toBeLessThan(puzzles.length * 0.12);
    for (let i = 0; i < puzzles.length; i += 15) expect(claimPuzzle(puzzles[i].seed, puzzles[i].difficulty)).toEqual(puzzles[i]);
  });
});

describe('value puzzles', () => {
  const { puzzles, avgMs } = generateAll(valuePuzzle);

  it('generate in under 10 ms on average', () => {
    expect(avgMs).toBeLessThan(10);
  });

  it('judge every ready discard by its exact expected score, accepting all within the tolerance', () => {
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
      for (const o of p.options) expect(waits(without(o.kind), setsNeeded).length > 0).toBe(o.ready);
      if (n % 3 === 0) {
        expect(shanten(without(p.answer), setsNeeded)).toBe(0);
        expect(shanten(without(p.rival), setsNeeded)).toBe(0);
      }
      // Exact enumeration: every winning tile, every live copy, both ways of winning, every engine item.
      const melds: Meld[] = p.melds.map((m) => ({ type: m.type, tiles: m.kinds.map((k, i) => k * 4 + i), concealed: m.concealed, from: m.from }));
      const meldCounts = count(p.melds.flatMap((m) => m.kinds));
      const exact = new Map<Kind, { score: number; tiles: number; tai: number; best: number }>();
      for (const o of p.options.filter((x) => x.ready)) {
        const rest = p.hand.slice();
        rest.splice(rest.indexOf(o.kind), 1);
        let score = 0;
        let tiles = 0;
        let tai = 0;
        let best = -1;
        for (const w of waits(without(o.kind), setsNeeded)) {
          const live = 4 - c[w] - meldCounts[w];
          if (live <= 0) continue;
          const ctx = { rules: DEFAULT_RULES, seat: 0, dealerSeat: p.dealerSeat, dealerStreak: 0, prevailingWind: p.prevailingWind, concealed: rest, melds, flowers: [], winningTile: w };
          const d = scoreWin({ ...ctx, selfDrawn: false, fromSeat: 1 }).tai;
          const sd = scoreWin({ ...ctx, selfDrawn: true }).tai;
          score += live * ((1 - VALUE_SELF_DRAW_SHARE) * (100 + 20 * d) + VALUE_SELF_DRAW_SHARE * 3 * (100 + 20 * sd));
          tiles += live;
          tai += live * ((1 - VALUE_SELF_DRAW_SHARE) * d + VALUE_SELF_DRAW_SHARE * sd);
          best = Math.max(best, d, sd);
        }
        exact.set(o.kind, { score, tiles, tai: tiles > 0 ? tai / tiles : 0, best });
        expect(o.expectedScore).toBeCloseTo(score, 6);
        expect(o.acceptance).toBe(tiles);
        expect(o.expectedTai).toBeCloseTo(tiles > 0 ? tai / tiles : 0, 9);
        expect(o.bestTai).toBe(best);
      }
      const live = [...exact.entries()].filter(([, e]) => e.tiles > 0);
      const top = Math.max(...live.map(([, e]) => e.score));
      const accepted = live.filter(([, e]) => e.score >= VALUE_TOLERANCE * top).map(([k]) => k);
      expect(p.answers.slice().sort((a, b) => a - b)).toEqual(accepted.sort((a, b) => a - b));
      expect(exact.get(p.answer)!.score).toBe(top);
      expect(p.answers).not.toContain(p.rival);
      for (const o of p.options) expect(checkValueAnswer(p, o.kind)).toBe(p.answers.includes(o.kind));
      if (p.patternKey) {
        expect(p.options.find((o) => o.kind === p.answer)!.items!.some((i) => i.key === p.patternKey)).toBe(true);
        expect(p.explanation).toContain(p.patternEn);
      }
      expect(p.explanationZh.length).toBeGreaterThan(0);
    });
  });

  it('show the expected and the best case honestly: the average never exceeds the best', () => {
    for (const p of puzzles) {
      for (const o of p.options.filter((x) => x.ready && x.acceptance! > 0)) {
        expect(o.expectedTai!).toBeLessThanOrEqual(o.bestTai! + 1e-9);
        expect(o.winning!.reduce((n, w) => n + w.live, 0)).toBe(o.acceptance);
      }
    }
  });

  it('match each difficulty (1: the best is also as fast; 3: a trade of speed against size) and are deterministic', () => {
    const o = (p: ValuePuzzle, k: Kind) => p.options.find((x) => x.kind === k)!;
    expect(puzzles.filter((p) => p.difficulty === 1).filter((p) => o(p, p.answer).acceptance! >= o(p, p.rival).acceptance!).length).toBeGreaterThan(SEEDS * 0.9);
    expect(
      puzzles.filter((p) => p.difficulty === 3).filter((p) => o(p, p.rival).acceptance! > o(p, p.answer).acceptance! || o(p, p.rival).bestTai! > o(p, p.answer).bestTai!).length,
    ).toBeGreaterThan(SEEDS * 0.9);
    // Several patterns turn up, and some answers win on speed rather than on a pattern.
    expect(new Set(puzzles.map((p) => p.patternKey)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(puzzles.map((p) => p.reasonKey)).size).toBe(3);
    for (let i = 0; i < puzzles.length; i += 15) expect(valuePuzzle(puzzles[i].seed, puzzles[i].difficulty)).toEqual(puzzles[i]);
  });
});

describe('puzzleOfType', () => {
  it('builds every theme with its own type', () => {
    for (const t of PUZZLE_TYPES) expect(puzzleOfType(t, 'any', 2).type).toBe(t);
  });
});
