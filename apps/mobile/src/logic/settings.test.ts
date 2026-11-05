import { describe, expect, it } from 'vitest';
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
