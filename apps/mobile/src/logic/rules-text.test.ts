import { describe, expect, it } from 'vitest';
import { BOT_SKILLS, DEFAULT_RULES, describeRules, RULE_PRESETS, rulesFromPreset, SPEED_PRESETS, type BotSkill, type GameSpeed } from '@mjm/engine';
import { botDescription, botLabel, presetDescription, presetName, rulesStakes, rulesSummary, speedLabel } from './rules-text';
import { translator } from './translator.fixture';

const en = translator('en');
const zh = translator('zh-TW');

describe('translator fixture', () => {
  it('is strict about missing keys', () => {
    expect(() => en('settings.noSuchKey')).toThrow();
  });
});

describe('rulesSummary', () => {
  it('matches the engine’s English description for every preset', () => {
    for (const p of RULE_PRESETS) {
      const r = rulesFromPreset(p.id);
      expect(rulesSummary(r, en, 'en'), p.id).toBe(describeRules(r));
    }
    const odd = { ...DEFAULT_RULES, allowChi: false, maxTai: 12, passRule: true };
    expect(rulesSummary(odd, en, 'en')).toBe(describeRules(odd));
  });

  it('reads Chinese in zh-TW and keeps the stakes first', () => {
    const s = rulesSummary(DEFAULT_RULES, zh, 'zh-TW');
    expect(s.startsWith(rulesStakes(DEFAULT_RULES))).toBe(true);
    expect(s).toContain(SPEED_PRESETS[DEFAULT_RULES.speed].labelZh);
    expect(s).not.toMatch(/rotations|bank/);
  });
});

describe('rule and bot labels', () => {
  it('use the engine’s English and Chinese names', () => {
    for (const p of RULE_PRESETS) {
      expect(presetName(p, 'en')).toBe(p.name);
      expect(presetName(p, 'zh-TW')).toBe(p.nameZh);
      expect(presetDescription(p, en, 'en')).toBe(p.description);
      expect(presetDescription(p, zh, 'zh-TW')).toMatch(/[一-鿿]/);
    }
    for (const sp of Object.keys(SPEED_PRESETS) as GameSpeed[]) {
      expect(speedLabel(sp, 'en')).toBe(SPEED_PRESETS[sp].label);
      expect(speedLabel(sp, 'zh-TW')).toBe(SPEED_PRESETS[sp].labelZh);
    }
    for (const k of Object.keys(BOT_SKILLS) as BotSkill[]) {
      expect(botLabel(k, 'en')).toBe(BOT_SKILLS[k].label);
      expect(botLabel(k, 'zh-TW')).toBe(BOT_SKILLS[k].labelZh);
      expect(botDescription(k, en, 'en')).toBe(BOT_SKILLS[k].description);
      expect(botDescription(k, zh, 'zh-TW')).toMatch(/[一-鿿]/);
    }
    expect(botLabel('club', 'en', true)).toBe('Club');
  });

  it('keeps the English preset copy in the locale file in step with the engine', () => {
    for (const p of RULE_PRESETS) expect(en(`settings.presets.${p.id}`)).toBe(p.description);
    for (const k of Object.keys(BOT_SKILLS) as BotSkill[]) expect(en(`common.bots.${k}`)).toBe(BOT_SKILLS[k].description);
  });
});

describe('rulesSummary lists every non-default rule', () => {
  const house = { ...DEFAULT_RULES, dealerTai: 2, dealerStreakTai: 3, drawKeepsDealer: false, deadWallSize: 8, heavenlyTai: 16, earthlyTai: 8, humanlyTai: 8, startingPoints: 1000 };

  it('in English, exactly as the engine describes it', () => {
    const s = rulesSummary(house, en, 'en');
    expect(s).toBe(describeRules(house));
    for (const part of ['dealer 2台', '連莊 +3台 a hand', '流局不連莊', 'dead wall 8', '天胡16台', '地胡8台', '人胡8台', 'start 1000']) expect(s).toContain(part);
  });

  it('in Traditional Chinese', () => {
    const s = rulesSummary(house, zh, 'zh-TW');
    for (const part of ['莊家2台', '連莊每次加3台', '流局不連莊', '留8張', '天胡16台', '地胡8台', '人胡8台', '起始1000分']) expect(s).toContain(part);
    expect(s).not.toMatch(/dealer|dead wall|start/);
  });
});
