import { describe, expect, it } from 'vitest';
import { clampTextScale, clampTileScale, DEFAULT_DISPLAY_SCALE, effectiveTextScale, osFontScale, parseDisplayScale, scaleTextStyle, serialiseDisplayScale, stepIndex, TEXT_SCALES, textFactor, TILE_SCALES } from './scale';
import { scaledTile, tileDims } from '../components/tileDims';

describe('display scale clamping', () => {
  it('snaps any number to the nearest step and anything else to Normal', () => {
    expect(clampTileScale(1.25)).toBe(1.25);
    expect(clampTileScale(1.4)).toBe(1.5);
    expect(clampTileScale(9)).toBe(1.5);
    expect(clampTileScale(0.2)).toBe(1);
    expect(clampTileScale('1.5')).toBe(1);
    expect(clampTileScale(NaN)).toBe(1);
    expect(clampTextScale(1.2)).toBe(1.15);
    expect(clampTextScale(1.29)).toBe(1.3);
    expect(clampTextScale(undefined)).toBe(1);
  });

  it('names three steps for each setting', () => {
    expect(TILE_SCALES.map((s) => stepIndex(TILE_SCALES, s))).toEqual([0, 1, 2]);
    expect(TEXT_SCALES.map((s) => stepIndex(TEXT_SCALES, s))).toEqual([0, 1, 2]);
    expect(stepIndex(TEXT_SCALES, 7)).toBe(0);
  });
});

describe('saved display scale', () => {
  it('round-trips a choice', () => {
    const d = { tileScale: 1.5, textScale: 1.15 } as const;
    expect(parseDisplayScale(serialiseDisplayScale(d))).toEqual(d);
  });

  it('reads nothing, garbage or old shapes as Normal (or the nearest step)', () => {
    expect(parseDisplayScale(null)).toEqual(DEFAULT_DISPLAY_SCALE);
    expect(parseDisplayScale('not json')).toEqual(DEFAULT_DISPLAY_SCALE);
    expect(parseDisplayScale('[1,2]')).toEqual(DEFAULT_DISPLAY_SCALE);
    expect(parseDisplayScale('{"tileScale":3}')).toEqual({ tileScale: 1.5, textScale: 1 });
    expect(parseDisplayScale('{"textScale":"big"}')).toEqual({ tileScale: 1, textScale: 1 });
  });
});

describe('OS text size as the floor', () => {
  it('never shows text smaller than the OS text size', () => {
    expect(effectiveTextScale(1, 1)).toBe(1);
    expect(effectiveTextScale(1.3, 1)).toBe(1.3);
    expect(effectiveTextScale(1, 1.4)).toBe(1.4);
    expect(effectiveTextScale(1.15, 1.4)).toBe(1.4);
  });

  it('adds only what the OS has not already applied', () => {
    expect(textFactor(1, 1)).toBe(1);
    expect(textFactor(1.3, 1)).toBe(1.3);
    // React Native multiplies by the OS scale already: a large OS font needs nothing extra.
    expect(textFactor(1.15, 1.3)).toBe(1);
    expect(textFactor(1.3, 1.15)).toBeCloseTo(1.3 / 1.15, 3);
    // The visible size is the factor times the OS scale, and is never below either setting.
    for (const os of [0.85, 1, 1.15, 1.3, 1.6])
      for (const s of TEXT_SCALES) {
        const seen = textFactor(s, os) * osFontScale(os);
        expect(seen).toBeGreaterThanOrEqual(s - 0.001);
        expect(seen).toBeGreaterThanOrEqual(osFontScale(os) - 0.001);
      }
  });

  it('treats missing, small or absurd OS values sensibly', () => {
    expect(osFontScale(undefined)).toBe(1);
    expect(osFontScale(0)).toBe(1);
    expect(osFontScale(0.8)).toBe(1);
    expect(osFontScale(3.5)).toBe(2);
  });
});

describe('scaling sizes', () => {
  it('scales font size and line height, leaving the rest alone', () => {
    expect(scaleTextStyle({ fontSize: 15, lineHeight: 21, color: 'red' }, 1.3)).toEqual({ fontSize: 19.5, lineHeight: 27.5, color: 'red' });
    const same = { fontSize: 12 };
    expect(scaleTextStyle(same, 1)).toBe(same);
    expect(scaleTextStyle({ color: 'x' }, 1.3)).toEqual({ color: 'x' });
  });

  it('grows named tile sizes into explicit widths', () => {
    expect(scaledTile('sm', 1)).toBe('sm');
    expect(scaledTile('sm', 1.5)).toBe(42);
    expect(scaledTile(30, 1.25)).toBe(38);
    expect(tileDims(scaledTile('xs', 1.5)).h).toBe(42);
    expect(scaledTile('md', NaN)).toBe('md');
  });
});
