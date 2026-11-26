import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every screen and component draws text through the app's Text (./Text.tsx), which gives Chinese the system's heavy
 * Chinese face and keeps scoring terms, tile names and numbers with units whole. React Native's own Text drawn directly
 * would bring back the thin Chinese titles of the showcase review of 20 November.
 */
const app = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("the app's Text", () => {
  it('is the only Text any screen or component imports from React Native', () => {
    const files = [...sources(join(app, 'src')), join(app, 'App.tsx')];
    const direct = files.filter((f) => {
      if (f.endsWith(join('components', 'Text.tsx'))) return false;
      const imports = readFileSync(f, 'utf8').match(/import\s*\{[^}]*\}\s*from\s*'react-native'/g) ?? [];
      return imports.some((i) => /[{,]\s*Text\s*[,}]/.test(i));
    });
    expect(direct.map((f) => relative(app, f))).toEqual([]);
    expect(files.length).toBeGreaterThan(100);
  });
});
