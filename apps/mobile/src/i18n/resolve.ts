/**
 * Locale resolution, kept free of React Native imports so it can be unit-tested.
 *
 * The UI follows the device: Traditional Chinese for zh-Hant devices (Taiwan,
 * Hong Kong, Macau), English for everyone else. Tile faces stay Chinese in every
 * language. Adding a locale means adding a file under ./locales and a line here.
 */
export type Locale = 'en' | 'zh-TW';
export type LocalePreference = Locale | 'auto';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'zh-TW'];
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', 'zh-TW': '繁體中文' };

/** Pick the first supported locale that matches one of the device's language tags, best match first. */
export function resolveLocale(tags: readonly string[]): Locale {
  for (const raw of tags) {
    const tag = raw.toLowerCase().replace(/_/g, '-');
    if (tag.startsWith('zh')) {
      // zh-Hant, zh-TW, zh-HK, zh-MO and any zh-Hant-* variant read Traditional Chinese.
      if (/\bhant\b|-tw\b|-hk\b|-mo\b/.test(tag)) return 'zh-TW';
      continue; // zh-CN / zh-Hans: not shipped yet, try the next preferred language
    }
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

/** The BCP 47 tag for a page in this locale: what the web page's lang attribute says, so a screen reader picks the right voice. */
export function htmlLang(locale: Locale): string {
  return locale === 'zh-TW' ? 'zh-Hant-TW' : 'en';
}

/**
 * On the web, set the page's lang attribute to the language the UI is shown in (the exported page
 * declares English). Does nothing where there is no document, as on iOS and Android.
 */
export function applyDocumentLang(locale: Locale, root: unknown = globalThis): void {
  const doc = (root as { document?: { documentElement?: { lang?: string } } }).document;
  if (doc?.documentElement) doc.documentElement.lang = htmlLang(locale);
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}
