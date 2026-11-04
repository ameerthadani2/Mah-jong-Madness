import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, RULE_LIMITS, RULE_PRESETS, SPEED_PRESETS, rulesFromPreset, sanitizeRules, withRules, withSpeed } from '../src/index';

describe('sanitizeRules', () => {
  it('returns the defaults for junk input', () => {
    for (const junk of [undefined, null, 42, 'rules', [], true]) expect(sanitizeRules(junk)).toEqual(DEFAULT_RULES);
  });

  it('drops unknown keys and keeps every legal override', () => {
    const r = sanitizeRules({ basePoints: 300, taiPoints: 100, evil: 'x'.repeat(1000), passRule: true, speed: 'turbo' }) as RuleSet & { evil?: unknown };
    expect(r.evil).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
    expect(r.basePoints).toBe(300);
    expect(r.taiPoints).toBe(100);
    expect(r.passRule).toBe(true);
    expect(r.speed).toBe('turbo');
  });

  it('rejects non-numeric, non-finite and out-of-range numbers (the audit probe rows)', () => {
    // basePoints:'x' used to produce string score deltas; deadWallSize:-30 duplicated tiles; :200 ended hands at the deal.
    expect(sanitizeRules({ basePoints: 'x' }).basePoints).toBe(DEFAULT_RULES.basePoints);
    expect(sanitizeRules({ basePoints: NaN, taiPoints: Infinity }).taiPoints).toBe(DEFAULT_RULES.taiPoints);
    expect(sanitizeRules({ deadWallSize: -30 }).deadWallSize).toBe(0);
    expect(sanitizeRules({ deadWallSize: 200 }).deadWallSize).toBe(RULE_LIMITS.deadWallSize[1]);
    expect(sanitizeRules({ handsPerMatch: 1e9 }).handsPerMatch).toBe(RULE_LIMITS.handsPerMatch[1]);
    expect(sanitizeRules({ turnSeconds: -1 }).turnSeconds).toBe(RULE_LIMITS.turnSeconds[0]);
    expect(sanitizeRules({ maxTai: -5 }).maxTai).toBe(0);
    expect(sanitizeRules({ basePoints: 99.9 }).basePoints).toBe(99);
  });

  it('only accepts real booleans and known speeds', () => {
    expect(sanitizeRules({ allowChi: 'false' as unknown as boolean }).allowChi).toBe(true);
    expect(sanitizeRules({ allowChi: 0 as unknown as boolean }).allowChi).toBe(true);
    expect(sanitizeRules({ allowChi: false }).allowChi).toBe(false);
    expect(sanitizeRules({ speed: 'warp' as never }).speed).toBe('normal');
    expect(sanitizeRules({ speed: '__proto__' as never }).speed).toBe('normal');
  });

  it('clamps against a custom base', () => {
    const base = withRules({ basePoints: 50 });
    expect(sanitizeRules({ taiPoints: 'nope' }, base).basePoints).toBe(50);
  });

  it('every limit admits its own default', () => {
    for (const [key, [lo, hi]] of Object.entries(RULE_LIMITS)) {
      const v = DEFAULT_RULES[key as keyof typeof RULE_LIMITS];
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });
});

describe('presets', () => {
  it('withRules and rulesFromPreset are sanitised', () => {
    expect(withRules({ deadWallSize: -30 }).deadWallSize).toBe(0);
    expect(rulesFromPreset('nope')).toEqual(DEFAULT_RULES);
    expect(rulesFromPreset('turbo').turnSeconds).toBe(SPEED_PRESETS.turbo.turnSeconds);
    expect(rulesFromPreset('taiwan-standard', { ...DEFAULT_RULES, basePoints: 1e9 }).basePoints).toBe(RULE_LIMITS.basePoints[1]);
  });

  it('every preset differs from the defaults in what its description says', () => {
    for (const p of RULE_PRESETS) {
      if (p.id === 'taiwan-standard') continue;
      const r = rulesFromPreset(p.id);
      expect(r, p.id).not.toEqual(DEFAULT_RULES);
    }
    // Purist only turns 過水 on; multiple winners are already off by default.
    expect(rulesFromPreset('purist')).toEqual({ ...DEFAULT_RULES, passRule: true });
  });

  it('withSpeed applies the clock values of the preset', () => {
    const r = withSpeed(DEFAULT_RULES, 'hyper');
    expect(r.timeBankSeconds).toBe(0);
    expect(r.turnSeconds).toBe(4);
  });
});

type RuleSet = typeof DEFAULT_RULES;
