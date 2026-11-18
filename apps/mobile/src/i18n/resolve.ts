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
 * On the web, make the page say which language the UI is shown in: its lang attribute (the exported page declares
 * English), so a screen reader picks the right voice, and its title, the app's name in that language (`title`:
 * 麻將狂熱 in Traditional Chinese), which the browser's tab, history and bookmarks show. Nothing else sets the title
 * (the app has no router that would). Does nothing where there is no document, as on iOS and Android.
 */
export function applyDocumentLocale(locale: Locale, title: string, root: unknown = globalThis): void {
  const doc = (root as { document?: { documentElement?: { lang?: string }; title?: string } }).document;
  if (!doc) return;
  if (doc.documentElement) doc.documentElement.lang = htmlLang(locale);
  if (title) doc.title = title;
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}
