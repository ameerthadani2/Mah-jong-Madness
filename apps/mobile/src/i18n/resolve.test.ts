import { describe, expect, it } from 'vitest';
import { applyDocumentLocale, htmlLang, isLocale, resolveLocale } from './resolve';

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

describe('the web page language and title', () => {
  it('are the language the UI is shown in and the app’s name in it, so a screen reader uses the right voice', () => {
    expect(htmlLang('en')).toBe('en');
    expect(htmlLang('zh-TW')).toBe('zh-Hant-TW');
    const page = { document: { documentElement: { lang: 'en' }, title: 'Mahjong Mania' } };
    applyDocumentLocale('zh-TW', '麻將狂熱', page);
    expect(page.document.documentElement.lang).toBe('zh-Hant-TW');
    expect(page.document.title).toBe('麻將狂熱');
    applyDocumentLocale('en', 'Mahjong Mania', page);
    expect(page.document.documentElement.lang).toBe('en');
    expect(page.document.title).toBe('Mahjong Mania');
    // No name to give (a missing string): the page keeps the title it has.
    applyDocumentLocale('zh-TW', '', page);
    expect(page.document.title).toBe('Mahjong Mania');
  });

  it('are left alone where there is no page (iOS and Android)', () => {
    expect(() => applyDocumentLocale('zh-TW', '麻將狂熱', {})).not.toThrow();
  });
});
