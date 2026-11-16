import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDocumentLang, htmlLang, isLocale, resolveLocale } from './resolve';

describe('resolveLocale', () => {
  it('reads Traditional Chinese devices as zh-TW', () => {
    for (const tag of ['zh-TW', 'zh-Hant-TW', 'zh-HK', 'zh-Hant-HK', 'zh-MO', 'zh-Hant', 'zh_TW']) expect(resolveLocale([tag]), tag).toBe('zh-TW');
  });
  it('falls past Simplified Chinese to the next preferred language', () => {
    expect(resolveLocale(['zh-CN', 'zh-Hant-TW'])).toBe('zh-TW');
    expect(resolveLocale(['zh-Hans-CN', 'en-GB'])).toBe('en');
    expect(resolveLocale(['zh-CN'])).toBe('en');
  });
  it('defaults to English', () => {
    expect(resolveLocale([])).toBe('en');
    expect(resolveLocale(['ja-JP', 'ko-KR'])).toBe('en');
    expect(resolveLocale(['en-US'])).toBe('en');
    expect(resolveLocale(['fr-FR', 'zh-TW'])).toBe('zh-TW');
  });
  it('isLocale guards saved preferences', () => {
    expect(isLocale('zh-TW')).toBe(true);
    expect(isLocale('zh-CN')).toBe(false);
    expect(isLocale(3)).toBe(false);
  });
});

describe('the web page language', () => {
  it('is the language the UI is shown in, so a screen reader uses the right voice', () => {
    expect(htmlLang('en')).toBe('en');
    expect(htmlLang('zh-TW')).toBe('zh-Hant-TW');
    const page = { document: { documentElement: { lang: 'en' } } };
    applyDocumentLang('zh-TW', page);
    expect(page.document.documentElement.lang).toBe('zh-Hant-TW');
    applyDocumentLang('en', page);
    expect(page.document.documentElement.lang).toBe('en');
  });

  it('is left alone where there is no page (iOS and Android)', () => {
    expect(() => applyDocumentLang('zh-TW', {})).not.toThrow();
  });

  it('is set by the module that switches the language, at start and on every change', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src.match(/applyDocumentLang\(i18n\.locale as Locale\)/g)).toHaveLength(2);
  });
});
