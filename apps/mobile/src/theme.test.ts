import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colors, contrast, pillTones } from './theme';

describe('small text on coloured fills', () => {
  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(contrast('#FFFFFF', colors.danger)).toBeLessThan(4.5);
  });

  it('every pill tone keeps 4.5:1 between its text and its fill', () => {
    for (const [tone, { bg, fg }] of Object.entries(pillTones)) {
      // The dark pill is translucent ink over the felt: white on ink is its floor.
      const fill = bg.startsWith('#') ? bg : colors.ink;
      expect(contrast(fg, fill), tone).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the Shop ribbons and its diamonds note use ink, not white on a bright colour', () => {
    const shop = readFileSync(join(__dirname, 'screens', 'ShopScreen.tsx'), 'utf8');
    expect(contrast(colors.ink, colors.danger)).toBeGreaterThanOrEqual(4.5);
    expect(shop).toMatch(/ribbon: \{[^}]*backgroundColor: colors\.danger/);
    expect(shop).toMatch(/ribbonText: \{[^}]*color: colors\.ink/);
    // The note about what diamonds buy sits in the cream strip the trust line uses.
    expect(shop).toMatch(/<View style=\{styles\.trust\}>\s*<Icon name="gem" size=\{22\} \/>\s*<Text style=\{\[styles\.trustText[^\n]*shop\.diamondsUse/);
    expect(contrast(colors.ink, colors.cream)).toBeGreaterThanOrEqual(4.5);
  });
});
