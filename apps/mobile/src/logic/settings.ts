/**
 * Saved settings → today's `Settings`. Builds before the language setting saved no
 * `locale` (they follow the device), older builds saved `signalUrl` (which froze
 * the server address) and `hostedTables`; anything unknown or malformed falls back
 * to the default. Pure, so the migration is unit-tested.
 */
import { sanitizeRules } from '@mjm/engine';
import { isLocale, type LocalePreference } from '../i18n/resolve';
import type { Settings } from '../storage';

export function parseLocalePreference(v: unknown): LocalePreference {
  return v === 'auto' || isLocale(v) ? v : 'auto';
}

export function migrateSettings(saved: unknown, defaults: Settings): Settings {
  const obj = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const { signalUrl: _signalUrl, hostedTables: _hostedTables, ...rest } = obj;
  const merged = { ...defaults, ...rest } as Settings;
  return { ...merged, rules: sanitizeRules(merged.rules), locale: parseLocalePreference(merged.locale) };
}
