import { describe, expect, it } from 'vitest';
import { timeBound } from './helpers/timing';
import { DEFENCE_SAFETY_ORDER, defenceOrderRule, defencePuzzle, kindInfo, valuePuzzle, valueSpeedRule, type DefenceOption, type ValueOption } from '../src/index';

// How often a one-line rule answers a puzzle: "keep the most winning tiles" for value puzzles, a
// fixed safety order for defence puzzles. Easy and medium puzzles teach those rules; hard ones
// should need more than the rule about half the time.

const ready = (kind: number, acceptance: number, accepted: boolean): ValueOption => ({ kind, ready: true, acceptance, accepted });
const kept = (kind: number, reason: DefenceOption['reason'], accepted: boolean, shanten = 1): DefenceOption => ({ kind, shanten, danger: 0, exact: 0, accepted, reason });

describe('one-line rules measured against the judge', () => {
  it('keep the most winning tiles: right, wrong, or split on a tie', () => {
    expect(valueSpeedRule({ options: [ready(1, 8, true), ready(2, 4, false), { kind: 3, ready: false }] })).toBe(true);
    expect(valueSpeedRule({ options: [ready(1, 8, false), ready(2, 4, true)] })).toBe(false);
    expect(valueSpeedRule({ options: [ready(1, 8, false), ready(2, 8, true), ready(3, 2, false)] })).toBeNull();
  });

  it('the fixed safety order: looks only at shape-keeping discards with the strongest reason', () => {
    const options = [kept(27, 'honour', false), kept(4, 'middle', true), kept(30, 'theirDiscard', true, 2)];
    expect(defenceOrderRule({ bestShanten: 1, options })).toBe(false);
    expect(defenceOrderRule({ bestShanten: 1, options: [kept(27, 'honour', true), kept(4, 'middle', false)] })).toBe(true);
    expect(defenceOrderRule({ bestShanten: 1, options: [kept(27, 'honour', true), kept(28, 'honour', false)] })).toBeNull();
  });

  it('agree with the first-pick rule on generated puzzles whenever they are not split', () => {
    for (let i = 0; i < 30; i++) {
      const v = valuePuzzle(`depth-pick-${i}`, 2);
      const rule = valueSpeedRule(v);
      const live = v.options.filter((o) => o.ready);
      const most = Math.max(...live.map((o) => o.acceptance ?? 0));
      if (rule !== null) expect(v.answers.includes(live.find((o) => o.acceptance === most)!.kind)).toBe(rule);
      const d = defencePuzzle(`depth-pick-${i}`, 2);
      const order = defenceOrderRule(d);
      const shape = d.options.filter((o) => o.shanten === d.bestShanten);
      const pick = shape.slice().sort((x, y) => DEFENCE_SAFETY_ORDER.indexOf(x.reason) - DEFENCE_SAFETY_ORDER.indexOf(y.reason))[0];
      if (order !== null) expect(d.answers.includes(pick.kind)).toBe(order);
    }
  });
});

/** Share of `n` seeded puzzles at `difficulty` where `rule` is wrong, with generation times. */
function measure<T>(gen: (seed: string, d: 1 | 2 | 3) => T, rule: (p: T) => boolean | null, difficulty: 1 | 2 | 3, n: number, prefix: string) {
  let wrong = 0;
  const ms: number[] = [];
  const puzzles: T[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const p = gen(`${prefix}-${i}`, difficulty);
    ms.push(performance.now() - t0);
    puzzles.push(p);
    if (rule(p) === false) wrong++;
  }
  ms.sort((a, b) => a - b);
  return { share: wrong / n, median: ms[Math.floor(n / 2)], max: ms[n - 1], puzzles };
}

describe('hard value puzzles need more than "keep the most winning tiles"', () => {
  const hard = measure(valuePuzzle, valueSpeedRule, 3, 160, 'depth-v');

  it('the rule is wrong in 40 to 60 percent of hard puzzles', () => {
    expect(hard.share).toBeGreaterThanOrEqual(0.4);
    expect(hard.share).toBeLessThanOrEqual(0.6);
  });

  it('easy and medium still teach the rule', () => {
    for (const d of [1, 2] as const) expect(measure(valuePuzzle, valueSpeedRule, d, 80, 'depth-v').share).toBeLessThan(0.25);
  });

  it('when the rule is right at hard, speed beats a bigger hand', () => {
    for (const p of hard.puzzles) {
      if (valueSpeedRule(p) !== true) continue;
      const a = p.options.find((o) => o.kind === p.answer)!;
      const r = p.options.find((o) => o.kind === p.rival)!;
      expect(r.acceptance! > a.acceptance! || r.bestTai! > a.bestTai!).toBe(true);
    }
  });

  it('give the same puzzle for the same seed', () => {
    for (let i = 0; i < 160; i += 16) expect(valuePuzzle(`depth-v-${i}`, 3)).toEqual(hard.puzzles[i]);
  });

  it('generate quickly enough for the server to regenerate a Rush run (loose bound for CI)', () => {
    expect(hard.median).toBeLessThan(timeBound(60));
    expect(hard.max).toBeLessThan(timeBound(1500));
  });
});

describe('hard defence puzzles need reading the discards, not a fixed safety order', () => {
  const hard = measure(defencePuzzle, defenceOrderRule, 3, 160, 'depth-d');

  it('the fixed order is wrong in 40 to 60 percent of hard puzzles', () => {
    expect(hard.share).toBeGreaterThanOrEqual(0.4);
    expect(hard.share).toBeLessThanOrEqual(0.6);
  });

  it('easy and medium still follow the order', () => {
    for (const d of [1, 2] as const) expect(measure(defencePuzzle, defenceOrderRule, d, 80, 'depth-d').share).toBeLessThan(0.15);
  });

  it("say which tile the order picks and that the count rates it more dangerous, in both languages", () => {
    let wrong = 0;
    for (const p of hard.puzzles) {
      const kept = p.options.filter((o) => o.shanten === p.bestShanten);
      const top = Math.min(...kept.map((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason)));
      const pick = kept.find((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason) === top)!;
      if (defenceOrderRule(p) !== false) {
        expect(p.explanation).not.toMatch(/by the usual order/);
        continue;
      }
      wrong++;
      const answer = p.options.find((o) => o.kind === p.answer)!;
      expect(pick.exact).toBeGreaterThan(answer.exact);
      expect(p.explanation).toContain(`${kindInfo(pick.kind).nameEn} looks safer by the usual order`);
      expect(p.explanationZh).toContain(`照一般的順序，${kindInfo(pick.kind).nameZh}看起來比較安全`);
      expect(p.explanation).not.toMatch(/(^|[^0-9.])0\.0%/);
    }
    expect(wrong).toBeGreaterThan(0);
  });

  it('give the same puzzle for the same seed', () => {
    for (let i = 0; i < 160; i += 16) expect(defencePuzzle(`depth-d-${i}`, 3)).toEqual(hard.puzzles[i]);
  });

  it('generate quickly enough for the server to regenerate a Rush run (loose bound for CI)', () => {
    expect(hard.median).toBeLessThan(timeBound(60));
    expect(hard.max).toBeLessThan(timeBound(1500));
  });
});
