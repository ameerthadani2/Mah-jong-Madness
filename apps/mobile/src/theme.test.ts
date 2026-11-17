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

  it('ink reads on the Shop ribbons\' red and on cream', () => {
    // The Shop drawing its ribbons and its diamonds note in ink on those colours is rendered in
    // src/screens/Shop.render.test.tsx.
    expect(contrast(colors.ink, colors.danger)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.ink, colors.cream)).toBeGreaterThanOrEqual(4.5);
  });
});
