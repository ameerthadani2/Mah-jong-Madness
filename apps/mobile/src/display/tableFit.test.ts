import { describe, expect, it } from 'vitest';
import { handLayout, tableLayout } from '../components/table/layout';
import { TILE_SCALES } from './scale';
import { fitHand, fitPools, MAX_HAND_ROWS, portraitRowRoom, rowWidth, wrapRows } from './tableFit';

const VIEWPORTS: Array<[number, number]> = [
  [390, 844],
  [844, 390],
  [667, 375],
  [360, 740],
  [1024, 768],
];

describe('wrapRows', () => {
  it('wraps greedily and counts the drawn tile gap', () => {
    // Nine 36 px tiles fit 358 px (9 × 36 + 8 × 2 + 10 = 350); nine 37 px ones do not (359).
    expect(wrapRows(9, 36, 358)).toBe(1);
    expect(wrapRows(9, 37, 358)).toBe(2);
    expect(wrapRows(17, 37, 358)).toBe(2);
    expect(wrapRows(17, 55, 358)).toBe(3);
    expect(wrapRows(1, 400, 358)).toBe(1);
  });
});

describe('fitHand', () => {
  it('is exactly the normal layout at Normal', () => {
    for (const [w, h] of VIEWPORTS) {
      const L = tableLayout(w, h);
      for (const [n, mt, mc] of [[17, 0, 0], [11, 6, 2], [5, 12, 4]] as const) {
        const fit = fitHand(w, h, L, n, mt, mc, 1);
        const base = handLayout(w, L, n, mt, mc);
        expect(fit.tile, `${w}x${h}`).toBe(base.tile);
        expect(fit.plateW).toBe(base.plateW);
        expect(fit.meldTile).toBe(28);
        expect(fit.scroll).toBe(false);
      }
    }
  });

  it('grows the hand with the tile scale, never shrinking it', () => {
    for (const [w, h] of VIEWPORTS) {
      const L = tableLayout(w, h);
      const sizes = TILE_SCALES.map((s) => fitHand(w, h, L, 17, 0, 0, s).tile);
      // A landscape phone's full hand already spans the rail at Normal: larger settings keep it there (they grow
      // the ponds and melds instead) rather than push tiles off the side.
      if (!L.portrait) expect(sizes[1], `${w}x${h}`).toBeGreaterThanOrEqual(sizes[0]);
      else expect(sizes[1], `${w}x${h}`).toBeGreaterThan(sizes[0]);
      expect(sizes[2]).toBeGreaterThanOrEqual(sizes[1]);
    }
  });

  it('fits 17 tiles at 390 px in portrait at every scale, wrapping to at most three rows', () => {
    for (const w of [390, 360]) {
      const L = tableLayout(w, 844);
      for (const s of TILE_SCALES) {
        const fit = fitHand(w, 844, L, 17, 0, 0, s);
        expect(fit.scroll).toBe(false);
        expect(fit.rows, `${w} @${s}`).toBeLessThanOrEqual(MAX_HAND_ROWS);
        expect(fit.perRow * (fit.tile + 2) - 2).toBeLessThanOrEqual(portraitRowRoom(w));
        expect(fit.perRow * fit.rows).toBeGreaterThanOrEqual(17);
      }
      expect(fitHand(w, 844, L, 17, 0, 0, 1).rows).toBe(2);
      expect(fitHand(w, 844, L, 17, 0, 0, 1.5).rows).toBe(3);
    }
  });

  it('shrinks Extra-large tiles to fit the landscape rail instead of scrolling sideways', () => {
    for (const [w, h] of [[844, 390], [667, 375], [1024, 768]] as const) {
      const L = tableLayout(w, h);
      const normal = fitHand(w, h, L, 17, 0, 0, 1);
      for (const s of TILE_SCALES) {
        const fit = fitHand(w, h, L, 17, 0, 0, s);
        expect(fit.rows).toBe(1);
        expect(fit.scroll, `${w}x${h} at ${s}`).toBe(false);
        expect(rowWidth(17, fit.tile), `${w}x${h} at ${s}`).toBeLessThanOrEqual(w - 24 - fit.plateW);
        expect(fit.tile).toBeGreaterThanOrEqual(normal.tile);
        // The rail never takes more than a fifth of the screen's height.
        expect(fit.tile * 1.4).toBeLessThanOrEqual(Math.max(h * 0.2, normal.tile * 1.4));
      }
    }
    // With melds on the rail too, the hand still fits beside them.
    const L = tableLayout(844, 390);
    const fit = fitHand(844, 390, L, 11, 6, 2, 1.5);
    expect(fit.scroll).toBe(false);
  });

  it('grows landscape melds only while they leave room for the hand', () => {
    const L = tableLayout(844, 390);
    // Two melds have room to grow; four already fill 40 % of the rail and stay at the normal size.
    const two = fitHand(844, 390, L, 11, 6, 2, 1.5);
    expect(two.meldTile).toBeGreaterThan(28);
    expect(6 * (two.meldTile + 1) + 2 * 8).toBeLessThanOrEqual(844 * 0.4);
    // …and the hand still fits beside them without scrolling.
    expect(rowWidth(11, two.tile) + 6 * (two.meldTile + 1) + 2 * 8 + 10).toBeLessThanOrEqual(844 - 24 - two.plateW);
    const four = fitHand(844, 390, L, 5, 12, 4, 1.5);
    expect(four.meldTile).toBe(28);
    expect(four.tile).toBeGreaterThanOrEqual(handLayout(844, L, 5, 12, 4).tile);
  });
});

describe('fitPools', () => {
  it('is the normal layout at Normal', () => {
    for (const [w, h] of VIEWPORTS) {
      const L = tableLayout(w, h);
      expect(fitPools(L, 1)).toEqual({ tile: 20 + (L.tablet ? 8 : 0), centerPerRow: L.centerPerRow, myPerRow: L.myPerRow, sidePerRow: L.sidePerRow, meldScale: 1 });
    }
  });

  it('grows the ponds and still fits every row in its column', () => {
    for (const [w, h] of VIEWPORTS) {
      const L = tableLayout(w, h);
      for (const s of [1.25, 1.5]) {
        const p = fitPools(L, s);
        expect(p.tile, `${w}x${h} @${s}`).toBeGreaterThan(fitPools(L, 1).tile);
        expect(p.sidePerRow).toBeGreaterThanOrEqual(3);
        expect(p.sidePerRow * (p.tile + 2)).toBeLessThanOrEqual(L.sideWidth);
        expect(p.centerPerRow * (p.tile + 2)).toBeLessThanOrEqual(L.centerW);
        expect(p.meldScale).toBeCloseTo(p.tile / fitPools(L, 1).tile, 5);
      }
    }
  });

  it('stops at Large on short landscape phones so the side ponds stay on the felt', () => {
    const L = tableLayout(844, 390);
    expect(fitPools(L, 1.5).tile).toBe(fitPools(L, 1.25).tile);
    const P = tableLayout(390, 844);
    expect(fitPools(P, 1.5).tile).toBeGreaterThanOrEqual(fitPools(P, 1.25).tile);
  });
});
