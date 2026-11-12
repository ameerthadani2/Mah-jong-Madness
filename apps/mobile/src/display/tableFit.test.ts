import { describe, expect, it } from 'vitest';
import { handLayout, tableLayout } from '../components/table/layout';
import { TILE_SCALES } from './scale';
import { fitHand, fitPools, MAX_HAND_ROWS, portraitRowRoom, rowWidth, wrapRows, fitSideColumn, fitSideSeat, meldWidth, MIN_SIDE_MELD, MIN_SIDE_POND, SIDE_GAP, sidePondPerRow, sideSeatHeight } from './tableFit';

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

describe('a side seat in landscape', () => {
  // Measured on the web export: the side column and its plate on a 667x375 phone (128 px wide) and on an
  // 844x390 phone at Extra-large tiles (150 px wide, ponds capped at 25 px there).
  const small = { width: 128, column: 224, plate: 52, hand: 17, meld: 20, pool: 20 };
  const xl = { width: 150, column: 227, plate: 52, hand: 17, meld: 25, pool: 25 };
  const room = (c: { column: number; plate: number; hand: number }, showHand: boolean) => c.column - c.plate - SIDE_GAP - (showHand ? c.hand + SIDE_GAP : 0);

  it('draws melds and pond at their usual sizes while the column has room', () => {
    const fit = fitSideColumn({ ...small, melds: [3], flowers: 1, discards: 8 });
    expect(fit).toMatchObject({ meld: 20, pool: 20, perRow: 5, scroll: false, showHand: true });
    expect(fit.height).toBeLessThanOrEqual(room(small, true));
  });

  it('measures the column as the felt draws it', () => {
    // A pong: three tiles a pixel apart, the claimed one on its side, 5 px after it.
    expect(meldWidth(3, 20)).toBe(75);
    expect(meldWidth(3, 14)).toBe(55);
    expect(sidePondPerRow(128, 20)).toBe(5);
    expect(sidePondPerRow(128, 16)).toBe(6);
    // Two pongs at 20 px take a line each in 128 px; at 14 px they share one.
    expect(sideSeatHeight({ width: 128, melds: [3, 3], flowers: 0, discards: 0 }, 20, 20)).toBe(28 + 3 + 28);
    expect(sideSeatHeight({ width: 128, melds: [3, 3], flowers: 0, discards: 0 }, 14, 20)).toBe(20);
    // Twelve discards at five a row: three rows two pixels apart, under the melds.
    expect(sideSeatHeight({ width: 128, melds: [3], flowers: 0, discards: 12 }, 20, 20)).toBe(28 + SIDE_GAP + 3 * 28 + 2 * 2);
  });

  it('with four melds and sixteen discards keeps every discard on the felt at 667x375, where the melds alone used to fill the column', () => {
    const seat = { melds: [3, 3, 3, 3], flowers: 2, discards: 16 };
    // At the usual sizes the melds and the pond need far more than the column has: the pond ran off the felt.
    expect(sideSeatHeight({ width: small.width, ...seat }, 20, 20)).toBeGreaterThan(room(small, false) + 60);
    const fit = fitSideColumn({ ...small, ...seat });
    expect(fit.scroll).toBe(false);
    expect(fit.height).toBeLessThanOrEqual(room(small, fit.showHand));
    expect(fit.meld).toBeGreaterThanOrEqual(MIN_SIDE_MELD);
    expect(fit.pool).toBeGreaterThanOrEqual(MIN_SIDE_POND);
    expect(fit.perRow * Math.ceil(seat.discards / fit.perRow)).toBeGreaterThanOrEqual(seat.discards);
  });

  it('with four melds and sixteen discards keeps every discard on the felt at 844x390 with Extra-large tiles', () => {
    const seat = { melds: [3, 3, 3, 3], flowers: 2, discards: 16 };
    expect(sideSeatHeight({ width: xl.width, ...seat }, 25, 25)).toBeGreaterThan(room(xl, false));
    const fit = fitSideColumn({ ...xl, ...seat });
    expect(fit.scroll).toBe(false);
    expect(fit.height).toBeLessThanOrEqual(room(xl, fit.showHand));
    expect(fit.pool).toBeGreaterThanOrEqual(MIN_SIDE_POND);
  });

  it('shrinks the melds before the pond: the discards are what a player reads', () => {
    const fit = fitSideSeat({ width: 128, room: 143, melds: [3, 3, 3], flowers: 0, discards: 10, meld: 20, pool: 20 });
    expect(fit.scroll).toBe(false);
    expect(fit.pool).toBe(20);
    expect(fit.meld).toBeLessThan(20);
    expect(fit.height).toBeLessThanOrEqual(143);
  });

  it('gives up the row of face-down tiles before it scrolls, and scrolls only when nothing else is left', () => {
    const tight = fitSideColumn({ ...small, melds: [3, 3, 3, 3], flowers: 2, discards: 20 });
    expect(tight.showHand).toBe(false);
    expect(tight.scroll).toBe(false);
    expect(tight.height).toBeLessThanOrEqual(room(small, false));
    const impossible = fitSideColumn({ ...small, melds: [4, 4, 4, 4, 4], flowers: 8, discards: 24 });
    expect(impossible).toMatchObject({ scroll: true, showHand: false, meld: MIN_SIDE_MELD, pool: MIN_SIDE_POND });
  });

  it('keeps a kong inside the column at every size it may take', () => {
    for (let w = MIN_SIDE_MELD; w <= 20; w++) expect(meldWidth(4, w)).toBeLessThanOrEqual(128 + 5);
  });

  it('changes nothing before the column has been measured', () => {
    expect(fitSideColumn({ ...small, column: 0, plate: 0, melds: [3, 3, 3, 3], flowers: 2, discards: 16 })).toMatchObject({ meld: 20, pool: 20, scroll: false, showHand: true });
  });

  it('is what the felt draws its side seats with, keeping a scrolling column at its newest discards', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const felt = readFileSync(join(__dirname, '../components/table/Felt.tsx'), 'utf8');
    expect(felt).toContain('const fit = fitSideColumn({');
    expect(felt).toContain('{fit.showHand && hidden}');
    expect(felt).toContain('<DiscardPool tiles={p.discards} size={fit.pool} perRow={fit.perRow}');
    expect(felt).toContain('onContentSizeChange={() => sideScroll.current[r]?.scrollToEnd({ animated: false })}');
  });
});
