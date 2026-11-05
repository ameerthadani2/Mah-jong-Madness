/**
 * Test helper: a `Translate` over the real locale files, configured like src/i18n
 * but without the device lookup, and strict, so a missing key fails the test
 * instead of rendering its path.
 */
import { I18n } from 'i18n-js';
import { en, zhTW } from '../i18n/locales';
import type { Locale } from '../i18n/resolve';
import type { Translate } from './translate';

export function translator(locale: Locale): Translate {
  const i18n = new I18n({ en, 'zh-TW': zhTW });
  i18n.defaultLocale = 'en';
  i18n.enableFallback = false;
  i18n.missingBehavior = 'error';
  i18n.locale = locale;
  return (key, params) => i18n.t(key, params);
}
