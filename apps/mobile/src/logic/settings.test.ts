import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { DEFAULT_RULES } from '@mjm/engine';
import { migrateSettings, parseLocalePreference } from './settings';
import type { Settings } from '../storage';

const DEFAULTS: Settings = { rules: DEFAULT_RULES, coach: true, botSkill: 'beginner', sound: true, tableTheme: 'classic', locale: 'auto' };

describe('migrateSettings', () => {
  it('gives settings saved before the language setting the device language', () => {
    const old = { rules: DEFAULT_RULES, coach: false, botSkill: 'club', sound: true, tableTheme: 'jade' };
    const s = migrateSettings(old, DEFAULTS);
    expect(s.locale).toBe('auto');
    expect(s.coach).toBe(false);
    expect(s.botSkill).toBe('club');
    expect(s.tableTheme).toBe('jade');
  });

  it('keeps a saved language choice', () => {
    expect(migrateSettings({ ...DEFAULTS, locale: 'zh-TW' }, DEFAULTS).locale).toBe('zh-TW');
    expect(migrateSettings({ ...DEFAULTS, locale: 'en' }, DEFAULTS).locale).toBe('en');
    expect(migrateSettings({ ...DEFAULTS, locale: 'auto' }, DEFAULTS).locale).toBe('auto');
  });

  it('falls back to the device language for an unknown or malformed choice', () => {
    for (const locale of ['zh-CN', 'fr', '', 7, null, { a: 1 }]) expect(migrateSettings({ ...DEFAULTS, locale }, DEFAULTS).locale).toBe('auto');
  });

  it('drops fields older builds saved and sanitises the rules', () => {
    const s = migrateSettings({ ...DEFAULTS, signalUrl: 'ws://old:1', hostedTables: true, rules: { ...DEFAULT_RULES, basePoints: 1e9, maxTai: -4 } }, DEFAULTS) as Settings & Record<string, unknown>;
    expect('signalUrl' in s).toBe(false);
    expect('hostedTables' in s).toBe(false);
    expect(s.rules.basePoints).toBe(5000);
    expect(s.rules.maxTai).toBe(0);
  });

  it('returns the defaults for junk', () => {
    for (const junk of [undefined, null, 'x', 3, []]) expect(migrateSettings(junk, DEFAULTS)).toEqual({ ...DEFAULTS, rules: DEFAULT_RULES });
  });
});

describe('parseLocalePreference', () => {
  it('accepts only supported values', () => {
    expect(parseLocalePreference('zh-TW')).toBe('zh-TW');
    expect(parseLocalePreference('en')).toBe('en');
    expect(parseLocalePreference('zh-Hant')).toBe('auto');
    expect(parseLocalePreference(undefined)).toBe('auto');
  });
});

describe('what the app says about the bot tiers', () => {
  const tiers = ['beginner', 'club', 'pro'] as const;

  it('describes what each tier does and never ranks Pro above Club or promises scoring play', () => {
    for (const locale of [en, zhTW]) {
      for (const k of tiers) expect(locale.settings.botAbout[k].length).toBeGreaterThan(10);
      const pro = locale.settings.botAbout.pro;
      expect(pro).not.toMatch(/fast and efficient|keeps scoring tiles|strong|best|beats|出牌快|加台|最強|更強/i);
    }
    // What Pro measurably does (docs/ARCHITECTURE.md): it folds far more when far from ready. Its overall edge is
    // given with where it comes from: the team's 35,000 paired hands, which two later runs did not confirm.
    expect(en.settings.botAbout.pro).toMatch(/Folds far more often than Club when its hand is far from ready/);
    expect(en.settings.botAbout.pro).toMatch(/In the team's own test of 35,000 paired hands it scored about 3 points a hand more than Club/);
    expect(en.settings.botAbout.pro).toMatch(/two later runs of 1,000 and 4,000 hands showed no clear difference/);
    expect(en.settings.botAbout.pro).not.toMatch(/a little more than Club/);
    expect(en.settings.botAbout.pro).toMatch(/the policy the coach's advice comes from/);
    expect(zhTW.settings.botAbout.pro).toMatch(/棄胡防守/);
    expect(zhTW.settings.botAbout.pro).toMatch(/開發團隊自己的 35,000 手配對測試/);
    expect(zhTW.settings.botAbout.pro).toMatch(/沒有看出明顯差別/);
    expect(zhTW.settings.botAbout.pro).not.toMatch(/只比牌友略高/);
    expect(zhTW.settings.botAbout.pro).toMatch(/教練/);
    // The Chinese description the engine's helper falls back on says the same.
    expect(zhTW.common.bots.pro).toBe(zhTW.settings.botAbout.pro);
    expect(zhTW.common.bots.club).toBe(zhTW.settings.botAbout.club);
  });

  // Settings shows the chosen tier's own description: src/screens/Settings.render.test.tsx ("a free bot tier is chosen and described").
  it('sits under a heading that does not rank the tiers', () => {
    expect(en.settings.botStrength).not.toMatch(/strength/i);
    expect(zhTW.settings.botStrength).not.toMatch(/強/);
  });
});
