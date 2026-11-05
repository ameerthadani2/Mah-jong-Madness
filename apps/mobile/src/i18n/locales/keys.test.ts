/**
 * Every translation key the app names literally must exist in every locale, and a string's %{placeholders}
 * must be the same in every locale (otherwise i18n-js prints a "missing value" marker at run time).
 * `npm run i18n:check` already compares key sets; this test compares the keys against the source code.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { en, zhTW } from './index';

const SRC = join(__dirname, '..', '..');
const LOCALES: Record<string, unknown> = { en, 'zh-TW': zhTW };
const NAMESPACES = Object.keys(en);

/**
 * Files whose literal keys are checked. Listed rather than discovered, because elsewhere a quoted
 * `namespace.thing` can be a product id or a doc example rather than a key; add files as they move to t().
 */
const CHECKED_FILES = [
  'screens/TableScreen.tsx',
  'screens/ReviewScreen.tsx',
  'screens/FairnessScreen.tsx',
  'screens/LearnScreen.tsx',
  'screens/DrillScreen.tsx',
  'screens/PuzzleScreens.tsx',
  'screens/AvatarGallery.tsx',
  'components/TableParts.tsx',
  'components/PuzzleView.tsx',
  'components/Avatars.tsx',
  'themes.ts',
];

function lookup(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
}

function leaves(tree: unknown, prefix = ''): Array<[string, string]> {
  if (typeof tree === 'string') return [[prefix, tree]];
  if (!tree || typeof tree !== 'object') return [];
  return Object.entries(tree).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

const placeholders = (s: string) => [...s.matchAll(/%\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Quoted strings in the source that look like `namespace.key` for a known namespace. */
function literalKeys(): Map<string, string> {
  const found = new Map<string, string>();
  const re = new RegExp(`['"\`]((?:${NAMESPACES.join('|')})\\.[A-Za-z0-9_.]+)['"\`]`, 'g');
  for (const file of CHECKED_FILES) {
    const code = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const m of code.matchAll(re)) found.set(m[1], file);
  }
  return found;
}

/** Ids feeding template-literal keys (`table.themes.${id}` and friends), read from their source lists. */
function idsFrom(file: string, pattern: RegExp): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  return [...text.matchAll(pattern)].map((m) => m[1]);
}

describe('locale keys', () => {
  const keys = literalKeys();

  it('finds the keys used in the source', () => {
    expect(keys.size).toBeGreaterThan(100);
  });

  for (const [locale, tree] of Object.entries(LOCALES)) {
    it(`${locale} has every key the source names`, () => {
      const missing = [...keys].filter(([k]) => lookup(tree, k) === undefined).map(([k, file]) => `${k} (${file})`);
      expect(missing).toEqual([]);
    });

    it(`${locale} has every template-literal key`, () => {
      const dynamic = [
        ...['best', 'good', 'inaccuracy', 'mistake', 'blunder'].map((g) => `review.grade.${g}`),
        ...['best', 'matched', 'over'].map((k) => `puzzles.rush.outcome.${k}`),
        ...idsFrom('themes.ts', /\{\s*id: '(\w+)'/g).map((id) => `table.themes.${id}`),
        ...idsFrom('themes.ts', /QUICK_CHATS = \[([^\]]*)\]/g)
          .flatMap((list) => [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]))
          .map((id) => `table.quickChat.${id}`),
        ...idsFrom('components/Avatars.tsx', /AVATAR_IDS = \[([^\]]*)\]/g)
          .flatMap((list) => [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]))
          .map((id) => `avatars.names.${id}`),
      ];
      expect(dynamic.length).toBeGreaterThan(30);
      expect(dynamic.filter((k) => typeof lookup(tree, k) !== 'string')).toEqual([]);
    });
  }

  it('zh-TW strings use no placeholder that en does not supply', () => {
    // A zh-TW string may leave a parameter out (e.g. shop.productSub drops the Chinese title it already shows),
    // but a placeholder en never fills would render as a missing-value marker.
    const mismatched = leaves(en)
      .filter(([k, s]) => {
        const other = lookup(zhTW, k);
        if (typeof other !== 'string') return false;
        const allowed = new Set(placeholders(s));
        return placeholders(other).some((p) => !allowed.has(p));
      })
      .map(([k]) => k);
    expect(mismatched).toEqual([]);
  });
});
