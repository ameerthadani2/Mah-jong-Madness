import { describe, expect, it } from 'vitest';
import { isLocale, resolveLocale } from './resolve';

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
