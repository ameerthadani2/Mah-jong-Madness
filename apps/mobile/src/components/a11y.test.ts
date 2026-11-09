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

  // The table, Home, Online, Lobby and puzzle screens (and their table components): every control is named and
  // reaches 44 pt on native, through hitSlop where it is drawn smaller (a full-screen scrim needs none).
  const OWNED = [
    ...tsx(join(SRC, 'components', 'table')),
    ...['Tile.tsx', 'TableParts.tsx', 'SeatMotion.tsx', 'PuzzleView.tsx', 'Celebrations.tsx'].map((f) => join(SRC, 'components', f)),
    ...['TableScreen.tsx', 'HomeScreen.tsx', 'OnlineScreen.tsx', 'LobbyScreen.tsx', 'PuzzleScreens.tsx', 'DrillScreen.tsx'].map((s) => join(SRC, 'screens', s)),
  ];

  it('names every Pressable on the table, Home, Online, Lobby and puzzle screens', () => {
    const unnamed: string[] = [];
    for (const f of OWNED) for (const tag of pressableTags(readFileSync(f, 'utf8'))) if (!/accessibilityLabel[=\s]/.test(tag)) unnamed.push(`${relative(SRC, f)}: ${tag.slice(0, 80)}`);
    expect(unnamed).toEqual([]);
  });

  it('gives every small Pressable a 44 pt touch target with hitSlop on those screens', () => {
    const small: string[] = [];
    for (const f of OWNED) for (const tag of pressableTags(readFileSync(f, 'utf8'))) if (!/hitSlop=/.test(tag) && !/style=\{styles\.scrim\}/.test(tag)) small.push(`${relative(SRC, f)}: ${tag.slice(0, 80)}`);
    expect(small).toEqual([]);
  });

  it('labels the shared buttons and icon buttons on those screens (Ui.tsx names them from the title, label or icon)', () => {
    const ui = readFileSync(join(SRC, 'components', 'Ui.tsx'), 'utf8');
    expect(ui).toMatch(/accessibilityLabel=\{accessibilityLabel \?\? title\}/);
    expect(ui).toMatch(/accessibilityLabel=\{label \?\? iconLabel\(icon\)\}/);
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
