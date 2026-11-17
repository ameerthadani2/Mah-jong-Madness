import { describe, expect, it } from 'vitest';
import { en, zhTW } from './locales';

/** Every string inside a locale, with its key. */
function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe('plain Taiwanese wording in the app', () => {
  it('never shows 向聽 (a riichi term Taiwanese players do not use) in either locale', () => {
    // 差 N 張聽牌 for a count, 離聽牌還差幾張 for the idea; in English, "from ready".
    expect([...strings(en, 'en'), ...strings(zhTW, 'zh-TW')].filter(([, s]) => s.includes('向聽'))).toEqual([]);
    expect(zhTW.puzzles.view.fromReady).toBe('差 %{n} 張聽牌');
  });
});
