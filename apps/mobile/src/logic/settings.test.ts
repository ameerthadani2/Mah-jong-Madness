import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    expect(en.settings.botAbout.pro).toMatch(/how dangerous each discard is and may fold/);
    expect(en.settings.botAbout.pro).toMatch(/the policy the coach's advice comes from/);
    expect(zhTW.settings.botAbout.pro).toMatch(/放槍風險/);
    expect(zhTW.settings.botAbout.pro).toMatch(/教練/);
    // The Chinese description the engine's helper falls back on says the same.
    expect(zhTW.common.bots.pro).toBe(zhTW.settings.botAbout.pro);
    expect(zhTW.common.bots.club).toBe(zhTW.settings.botAbout.club);
  });

  it('is shown from the app\'s own strings in both languages, under a heading that does not rank the tiers', () => {
    const screen = readFileSync(join(__dirname, '..', 'screens', 'SettingsScreen.tsx'), 'utf8');
    expect(screen).toMatch(/t\(`settings\.botAbout\.\$\{settings\.botSkill\}`\)/);
    expect(screen).not.toMatch(/botDescription\(/);
    expect(en.settings.botStrength).not.toMatch(/strength/i);
    expect(zhTW.settings.botStrength).not.toMatch(/強/);
  });
});
