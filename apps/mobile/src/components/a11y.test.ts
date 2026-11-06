/**
 * Static accessibility checks over the table, learning and shared UI code: every Pressable names its role,
 * and no style sets text smaller than 11 px. (Labels for the shared controls come from Ui.tsx.)
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
// Components other tracks own are checked by their own tests.
const NOT_OURS = new Set(['AgeGate.tsx', 'ReportPlayerSheet.tsx', 'LegalLinks.tsx', 'PrivacyToggles.tsx']);
const SCREENS = ['TableScreen.tsx', 'LearnScreen.tsx', 'DrillScreen.tsx', 'PuzzleScreens.tsx', 'ReviewScreen.tsx', 'FairnessScreen.tsx', 'SettingsScreen.tsx', 'HomeScreen.tsx', 'ShopScreen.tsx', 'ClubsScreen.tsx', 'OnlineScreen.tsx', 'AccountCard.tsx', 'LobbyScreen.tsx'];

function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return tsx(p);
    return f.endsWith('.tsx') && !NOT_OURS.has(f) ? [p] : [];
  });
}

const FILES = [...tsx(join(SRC, 'components')), ...SCREENS.map((s) => join(SRC, 'screens', s))];

/** The source of each `<Pressable …>` opening tag (braces balanced, so arrow functions inside are skipped). */
function pressableTags(code: string): string[] {
  const out: string[] = [];
  let i = code.indexOf('<Pressable');
  while (i >= 0) {
    let depth = 0;
    let j = i + 1;
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(code.slice(i, j + 1));
    i = code.indexOf('<Pressable', j);
  }
  return out;
}

describe('accessibility', () => {
  it('gives every Pressable an accessibilityRole', () => {
    const missing: string[] = [];
    for (const f of FILES) {
      for (const tag of pressableTags(readFileSync(f, 'utf8'))) if (!tag.includes('accessibilityRole')) missing.push(`${relative(SRC, f)}: ${tag.slice(0, 80)}`);
    }
    expect(missing).toEqual([]);
  });

  it('sets no text style below 11 px', () => {
    const small: string[] = [];
    for (const f of FILES) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, n) => {
          // Style objects only (`fontSize: 9`); SVG art inside tiles is drawn in scaled units (`fontSize={…}`).
          for (const m of line.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)\b/g)) if (Number(m[1]) < 11) small.push(`${relative(SRC, f)}:${n + 1} ${m[0]}`);
        });
    }
    expect(small).toEqual([]);
  });
});
