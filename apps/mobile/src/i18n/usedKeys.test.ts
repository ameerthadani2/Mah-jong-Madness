/**
 * Every translation key written as a literal in the source must resolve to a string (or a plural form) in both
 * locales. A key that names a whole group of strings renders an object, which crashes the screen that shows it;
 * a key that is missing shows its own path. `npm run i18n:check` only compares the two locales with each other.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const app = join(src, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'locales' || name === 'node_modules' ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.fixture\.ts$/.test(name) ? [p] : [];
  });
}

function load(locale: string): Record<string, unknown> {
  const dir = join(here, 'locales', locale);
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
}

const PLURAL_FORMS = new Set(['zero', 'one', 'other']);

function problem(tree: Record<string, unknown>, key: string): string | null {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in (node as object))) return 'missing';
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === 'string') return null;
  if (node && typeof node === 'object' && Object.keys(node).every((k) => PLURAL_FORMS.has(k))) return null;
  return 'a group of strings, not a string';
}

/** Literal keys inside the first argument of t(...): t('a.b'), t("a.b"), and both arms of t(cond ? 'a.b' : 'a.c'). */
function literalKeys(code: string): string[] {
  const keys = new Set<string>();
  const call = /(?<![A-Za-z0-9_.])t\(\s*([^;]*?)(?:,\s*\{|\))/g;
  for (const m of code.matchAll(call)) {
    for (const lit of m[1].matchAll(/['"]([a-zA-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)['"]/g)) keys.add(lit[1]);
  }
  return [...keys];
}

describe('translation keys used in the source', () => {
  const files = [...sources(src), join(app, 'App.tsx')];
  const locales = { en: load('en'), 'zh-TW': load('zh-TW') };
  const namespaces = new Set(Object.keys(locales.en));

  it('finds the keys it is meant to check', () => {
    const all = files.flatMap((f) => literalKeys(readFileSync(f, 'utf8')));
    expect(all.length).toBeGreaterThan(400);
    expect(all).toContain('home.play.title');
  });

  it('each resolve to a string in English and in Traditional Chinese', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const key of literalKeys(readFileSync(f, 'utf8'))) {
        // 'engine.' keys come from the engine package, and a literal outside the known namespaces is not a key.
        if (!namespaces.has(key.split('.')[0])) continue;
        for (const [locale, tree] of Object.entries(locales)) {
          const p = problem(tree, key);
          if (p) bad.push(`${f.slice(app.length + 1)}: t('${key}') is ${p} in ${locale}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
