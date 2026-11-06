/**
 * Static check: tile names shown in the UI follow the player's locale. A view that passes a fixed
 * locale to `tileName` (so an English sentence says 'Best is 北') fails here.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return tsx(p);
    return f.endsWith('.tsx') ? [p] : [];
  });
}

describe('tile names in the UI', () => {
  it('are rendered in the current locale, never a fixed one', () => {
    const fixed: string[] = [];
    for (const f of [...tsx(join(SRC, 'components')), ...tsx(join(SRC, 'screens'))]) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, n) => {
          for (const m of line.matchAll(/tileName\([^()]*(?:\([^()]*\))?[^()]*,\s*'[a-zA-Z-]+'\)/g)) fixed.push(`${relative(SRC, f)}:${n + 1} ${m[0]}`);
        });
    }
    expect(fixed).toEqual([]);
  });
});
