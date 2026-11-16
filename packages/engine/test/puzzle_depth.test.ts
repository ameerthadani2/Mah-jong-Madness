import { describe, expect, it } from 'vitest';
import { DEFENCE_SAFETY_ORDER, defenceOrderRule, defencePuzzle, valuePuzzle, valueSpeedRule, type DefenceOption, type ValueOption } from '../src/index';

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
