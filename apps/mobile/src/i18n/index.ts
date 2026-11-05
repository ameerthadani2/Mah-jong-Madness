/**
 * Translations. `t('home.play')` returns the string for the current locale; `useT()`
 * does the same inside a component and re-renders it when the locale changes.
 *
 * The locale follows the device unless the player picks one in Settings
 * (`setLocalePreference`). Strings live in ./locales/<locale>.json, one file per
 * language, with the same keys in every file (`npm run i18n:check` enforces it).
 */
import { useSyncExternalStore } from 'react';
import { I18n, type TranslateOptions } from 'i18n-js';
import { getLocales } from 'expo-localization';
import { engineReasonTranslations } from '@mjm/engine';
import { en, zhTW } from './locales';
import { type Locale, type LocalePreference, resolveLocale } from './resolve';

export { type Locale, type LocalePreference, SUPPORTED_LOCALES, LOCALE_NAMES, resolveLocale, isLocale } from './resolve';

// The engine's coach and review sentences are templates it exports per locale; they live under 'engine.' so
// they cannot collide with the app's own keys. Render them as t('engine.' + reasonKey, reasonParams).
const i18n = new I18n({ en: { ...en, engine: engineReasonTranslations('en') }, 'zh-TW': { ...zhTW, engine: engineReasonTranslations('zh-TW') } });
i18n.defaultLocale = 'en';
i18n.enableFallback = true;
// A missing key shows its path rather than an i18n-js diagnostic, so a gap is visible but never ugly.
i18n.missingBehavior = 'guess';

let preference: LocalePreference = 'auto';
const listeners = new Set<() => void>();

function deviceLocale(): Locale {
  try {
    return resolveLocale(getLocales().map((l) => l.languageTag));
  } catch {
    return 'en';
  }
}

export function currentLocale(): Locale {
  return preference === 'auto' ? deviceLocale() : preference;
}

export function localePreference(): LocalePreference {
  return preference;
}

/** Called once at boot with the saved setting, and again whenever the player changes it. */
export function setLocalePreference(p: LocalePreference): void {
  preference = p;
  i18n.locale = currentLocale();
  for (const l of listeners) l();
}

i18n.locale = currentLocale();

export function t(key: string, options?: TranslateOptions): string {
  return i18n.t(key, options);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Current locale plus `t`; the component re-renders when the locale changes. */
export function useT(): { t: typeof t; locale: Locale } {
  const locale = useSyncExternalStore(subscribe, currentLocale, currentLocale);
  return { t, locale };
}
