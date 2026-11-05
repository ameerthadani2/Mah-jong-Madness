/**
 * The translation function as pure logic sees it. Screens pass `t` from `useT()`;
 * tests pass an i18n-js instance built from the same locale files. Keeping logic
 * modules free of the i18n runtime (which reads the device locale through Expo)
 * keeps them unit-testable.
 */
import type { Locale } from '../i18n/resolve';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** A message that is rendered later, in whatever language is current then. */
export interface Message {
  key: string;
  params?: Record<string, string | number>;
}

/** Pick the engine's or a data file's own Chinese field when the UI reads Traditional Chinese. */
export function localized(locale: Locale, en: string, zh: string | undefined): string {
  return locale === 'zh-TW' && zh ? zh : en;
}
