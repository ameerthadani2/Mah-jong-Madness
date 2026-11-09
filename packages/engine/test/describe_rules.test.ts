import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, describeRules, ruleExtras, withRules } from '../src/index';

describe('describeRules', () => {
  it('shows only stakes, length and speed for the default rules', () => {
    expect(describeRules(DEFAULT_RULES)).toBe('底100 / 台20 · 16 rotations · Normal (15s + 30s bank)');
    expect(ruleExtras(DEFAULT_RULES)).toEqual([]);
  });

  it('shows every rule that differs from the defaults, so a joining player sees the whole house', () => {
    const r = withRules({
      dealerTai: 2,
      dealerStreakTai: 3,
      drawKeepsDealer: false,
      deadWallSize: 8,
      heavenlyTai: 16,
      earthlyTai: 8,
      humanlyTai: 8,
      startingPoints: 1000,
      maxTai: 10,
      allowChi: false,
      passRule: true,
      multipleWinners: true,
      noFlowerTai: true,
    });
    expect(describeRules(r)).toBe(
      '底100 / 台20 · 16 rotations · Normal (15s + 30s bank) · 一炮多響 · 過水 · 無花1台 · 不可吃 · 封頂10台 · dealer 2台 · 連莊 +3台 a hand · 流局不連莊 · dead wall 8 · 天胡16台 · 地胡8台 · 人胡8台 · start 1000',
    );
  });

  it('lists each changed rule exactly once, whichever single rule changes', () => {
    const changes = [
      { dealerTai: 0 },
      { dealerStreakTai: 0 },
      { drawKeepsDealer: false },
      { deadWallSize: 0 },
      { heavenlyTai: 32 },
      { earthlyTai: 24 },
      { humanlyTai: 4 },
      { startingPoints: 500 },
    ];
    for (const c of changes) expect(ruleExtras(withRules(c)), JSON.stringify(c)).toHaveLength(1);
  });
});
