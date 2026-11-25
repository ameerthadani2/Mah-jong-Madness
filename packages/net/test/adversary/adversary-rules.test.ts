/**
 * The rules every gap depends on, in fixed forms (known.ts): the stated limits stay amber, never green, and each control
 * (an attack without the step that made a gap pass) shows red, so the oracle and the phone still see the attacks.
 */
import { describe, expect, it } from 'vitest';
import { LIMIT } from './ci';
import { report, runScenario } from './fuzz';
import { KNOWN_CASES } from './known';

describe('the adversary fuzzer: limits and controls', () => {
  for (const k of KNOWN_CASES.filter((c) => c.role === 'limit')) {
    it(`keeps the stated limit ${k.gap} amber, never green: ${k.what}`, () => {
      const o = runScenario(k.make(k.seed ?? 1));
      expect(o.judgement.cheats.length).toBeGreaterThan(0);
      expect(o.judgement.violations.map((v) => report(o, v))).toEqual([]);
      expect([...o.judgement.verdicts.values()].some((v) => v.status === 'partial')).toBe(true);
    }, LIMIT);
  }

  for (const k of KNOWN_CASES.filter((c) => c.role === 'control')) {
    it(`sees the attack of gap ${k.gap}'s control: ${k.what}`, () => {
      const o = runScenario(k.make(k.seed ?? 1));
      expect(o.judgement.cheats.length).toBeGreaterThan(0);
      expect(o.judgement.violations.map((v) => report(o, v))).toEqual([]);
      expect([...o.judgement.verdicts.values()].some((v) => v.status === 'failed')).toBe(true);
    }, LIMIT);
  }
});
