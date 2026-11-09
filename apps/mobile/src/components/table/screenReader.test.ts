import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { announcesOn } from './announcePolicy';
import { reactionShouldPlay, REACTION_FRESH_MS } from './feel';
import { tileLabel } from './tileLabel';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('screen readers at the table', () => {
  it('names every tile in the UI language', () => {
    // 0 = 一萬 (1 Character), 27 = 東 (East wind)
    expect(tileLabel(0, 'zh-TW')).toBe('一萬');
    expect(tileLabel(0, 'en')).not.toBe(tileLabel(0, 'zh-TW'));
    expect(tileLabel(27, 'en')).toMatch(/east/i);
  });

  it('labels display tiles (ponds, melds, the win reveal), not only the pressable hand tiles', () => {
    const tile = read('../Tile.tsx');
    // The non-pressable body gets an image role and the spoken name.
    expect(tile).toMatch(/!onPress && !onLongPress && spoken \? \{ accessible: true, accessibilityRole: 'image'/);
    // The pressable fallback is no longer the English name.
    expect(tile).not.toMatch(/info\?\.nameEn/);
  });

  it('announces call-outs and connection banners on iOS, where live regions are ignored', () => {
    expect(announcesOn('ios')).toBe(true);
    expect(announcesOn('android')).toBe(false);
    expect(announcesOn('web')).toBe(false);
    expect(read('./CallBanner.tsx')).toMatch(/announce\(/);
    expect(read('../../screens/TableScreen.tsx')).toMatch(/useAnnounce\(linkBanner\)/);
    expect(read('./announce.ts')).toMatch(/AccessibilityInfo\.announceForAccessibility/);
  });

  it('respects reduce motion in every animated table piece', () => {
    for (const f of ['./Motion.tsx', './CallBanner.tsx', '../SeatMotion.tsx', '../Celebrations.tsx']) expect(read(f), f).toMatch(/useReducedMotion\(\)/);
    expect(read('../../display/reducedMotion.ts')).toMatch(/isReduceMotionEnabled/);
    expect(read('../../display/reducedMotion.ts')).toMatch(/reduceMotionChanged/);
  });
});

describe('seat reactions', () => {
  it('play once, when fresh', () => {
    expect(reactionShouldPlay({ key: 1, at: 1000 }, false, 1000)).toBe(true);
    expect(reactionShouldPlay({ key: 1, at: 1000 }, true, 1000)).toBe(false);
  });

  it('are not replayed by a portrait mounted after a rotation or resize', () => {
    expect(reactionShouldPlay({ key: 1, at: 1000 }, false, 1000 + REACTION_FRESH_MS + 1)).toBe(false);
  });
});
