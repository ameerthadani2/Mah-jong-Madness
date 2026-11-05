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
  type GameState,
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
});
