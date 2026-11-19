import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, legalActions, newGame, type GameState } from '@mjm/engine';
import { compassHeight, CROSS_PAD, fitPortraitFelt, meldsHeight, MIN_COMPASS, MIN_FLAT_MELD, MIN_MELD, MIN_POND, myPondPerRow, PINNED_POND_PAD, pondHeight, pondRows, pondRowsShown, centerPondPerRow, type PortraitFeltFit, type PortraitFeltInput, type PortraitSeat } from './portraitFit';
import { SIDE_GAP, sidePondPerRow } from './tableFit';

const seat = (discards: number, melds: number[] = [], flowers = 0, hand = 16 - 3 * melds.length): PortraitSeat => ({ melds, flowers, discards, hand });

/**
 * The felt as measured on the 320×568 web export at Normal tiles (the smallest phone e2e:screens covers): its inner
 * height with the coach's bar under it, the side plates (avatar over a two-line tag) and the across seat's plate.
 */
const SMALL: PortraitFeltInput = {
  felt: 222,
  sideW: 84,
  centerW: 80,
  pondW: 260,
  plates: { right: 73, left: 73, top: 40 },
  topHandH: 17,
  sideHandH: 17,
  status: 20,
  right: seat(0),
  across: seat(0),
  left: seat(0),
  mine: 0,
  pool: 20,
  meld: 20,
  wallMax: 120,
  compass: 50,
};

/** The felt's columns as the fit says they are drawn: each must be at most the room the felt leaves them. */
function columns(input: PortraitFeltInput, fit: PortraitFeltFit) {
  const side = (s: PortraitSeat, plate: number, keep: number) => {
    const rows = Math.min(keep, pondRows(s.discards, sidePondPerRow(input.sideW, fit.pool)));
    const parts = [plate, fit.hands && s.hand > 0 ? input.sideHandH : 0, meldsHeight(input.sideW, s.melds, s.flowers, fit.meld, fit.flat), pondHeight(rows, fit.pool)].filter((h) => h > 0);
    return parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * SIDE_GAP;
  };
  const myRows = Math.min(fit.keep.mine, pondRows(input.mine, myPondPerRow(input.pondW, fit.pool)));
  const room = input.felt - 2 * CROSS_PAD - PINNED_POND_PAD - pondHeight(myRows, fit.pool);
  return { room, right: side(input.right, input.plates.right, fit.keep.right), left: side(input.left, input.plates.left, fit.keep.left) };
}

describe('the portrait felt fits its box', () => {
  it('keeps everything at the reader’s sizes while it fits, and before it is measured', () => {
    const roomy = fitPortraitFelt({ ...SMALL, felt: 600, right: seat(8, [3]), across: seat(8), left: seat(8), mine: 8 });
    expect(roomy).toMatchObject({ pool: 20, meld: 20, hands: true, flat: false, fits: true, compass: 50, status: true });
    expect(roomy.keep).toEqual({ right: Infinity, across: Infinity, left: Infinity, mine: Infinity });
    // The ring takes what the across seat leaves, up to its full size.
    expect(roomy.wall).toBe(120);
    const unmeasured = fitPortraitFelt({ ...SMALL, felt: 0, right: seat(30, [3, 3, 3, 3], 8), mine: 30 });
    expect(unmeasured).toMatchObject({ pool: 20, meld: 20, hands: true, fits: true });
    expect(unmeasured.keep.right).toBe(Infinity);
  });

  it('gives up the ring, then the status line, then the compass’s size, then the compass, before any tile gets smaller', () => {
    const at = (discards: number) => fitPortraitFelt({ ...SMALL, felt: 330, across: seat(discards, [3, 3]) });
    expect(at(0).wall).toBeGreaterThan(0);
    // The across seat's pond grows: the ring goes, then the status line, then the compass shrinks, then it goes, and only
    // then do the tiles get smaller.
    const sizes = Array.from({ length: 31 }, (_, n) => at(n));
    for (const [n, f] of sizes.entries()) {
      if (f.wall > 0) expect(f.compass, `${n}`).toBe(50);
      if (f.compass < 50) expect([f.wall, f.status], `${n}`).toEqual([0, false]);
      if (f.compass > 0) expect(f.compass, `${n}`).toBeGreaterThanOrEqual(MIN_COMPASS);
    }
    // The tiles first get smaller once the compass has gone (at smaller tiles it may come back into what they free).
    const firstSmaller = sizes.findIndex((f) => f.pool < 20);
    expect(firstSmaller).toBeGreaterThan(0);
    expect(sizes[firstSmaller - 1].compass).toBe(0);
    // The ring starts at its full size and shrinks before it goes (with the status line), then the compass shrinks and goes.
    const rings = sizes.map((f) => f.wall).filter((w, i, a) => w > 0 && a.indexOf(w) === i);
    expect(rings[0]).toBe(120);
    expect(rings.length).toBeGreaterThan(1);
    rings.slice(1).forEach((w, i) => expect(w).toBeLessThan(rings[i]));
    expect(sizes.some((f) => f.wall === 0 && f.compass > 0 && f.compass < 50 && !f.status)).toBe(true);
    expect(sizes.some((f) => f.compass === 0 && f.pool === 20)).toBe(true);
    expect(sizes.some((f) => f.pool < 20)).toBe(true);
    expect(compassHeight(50)).toBe(66);
  });

  it('then shrinks the ponds and melds together, never under MIN_POND and MIN_MELD, before the rows of face-down tiles go', () => {
    const f = fitPortraitFelt({ ...SMALL, felt: 250, pool: 30, meld: 30, right: seat(9, [3]), left: seat(9, [3]) });
    expect(f.pool).toBeLessThan(30);
    expect(f.pool).toBeGreaterThanOrEqual(MIN_POND);
    expect(f.meld).toBeGreaterThanOrEqual(MIN_MELD);
    expect(f.hands).toBe(true);
    expect(f.keep.right).toBe(Infinity);
    expect(f.fits).toBe(true);
  });

  it('keeps only the newest rows of a pond once the tiles are at their smallest and the face-down rows are gone, never fewer than one', () => {
    const f = fitPortraitFelt({ ...SMALL, right: seat(24, [3, 3]), left: seat(6), across: seat(6), mine: 6 });
    expect(f).toMatchObject({ pool: MIN_POND, hands: false, fits: true });
    expect(f.keep.right).toBeGreaterThanOrEqual(1);
    expect(f.keep.right).toBeLessThan(pondRows(24, sidePondPerRow(SMALL.sideW, MIN_POND)));
    // Only the column that needs it, and before my pond's rows or the melds give way.
    expect(f.keep.left).toBe(Infinity);
    expect(f.keep.mine).toBe(Infinity);
    expect(f.flat).toBe(false);
    const c = columns({ ...SMALL, right: seat(24, [3, 3]), left: seat(6), across: seat(6), mine: 6 }, f);
    expect(c.right).toBeLessThanOrEqual(c.room);
  });

  it('keeps fewer rows of my pond only when an opponent at one row still does not fit, and lays melds flat last', () => {
    // Two kongs, a pong and four flowers at the left seat of a 320 px phone: four rows of melds even at the smallest size.
    const hard = { ...SMALL, left: seat(10, [4, 3, 4], 4, 7), right: seat(10, [], 3), across: seat(9, [3]), mine: 20 };
    const f = fitPortraitFelt(hard);
    expect(f.keep.mine).toBe(1);
    expect(f.flat).toBe(true);
    expect(f.meld).toBeGreaterThanOrEqual(MIN_FLAT_MELD);
    expect(f.fits).toBe(true);
    const c = columns(hard, f);
    expect(c.left).toBeLessThanOrEqual(c.room);
    // With room for my pond's rows, melds keep their tile lying on its side.
    const easier = fitPortraitFelt({ ...hard, left: seat(10, [3], 0) });
    expect(easier.flat).toBe(false);
    expect(easier.keep.mine).toBe(Infinity);
  });

  it('says so when even one row each does not fit, so the hand gives way', () => {
    const f = fitPortraitFelt({ ...SMALL, felt: 120, right: seat(12, [3, 3, 3]), left: seat(12, [3, 3]), across: seat(12), mine: 12 });
    expect(f.fits).toBe(false);
    expect(f.keep.right).toBe(1);
  });

  it('fits every decision of 40 bot hands on a 320×568 phone at Normal tiles (the e2e player: passes every claim)', () => {
    let decisions = 0;
    const failures: string[] = [];
    for (let h = 0; h < 40; h++) {
      let s: GameState = newGame(`portrait-fit-${h}`);
      for (let guard = 0; s.phase !== 'ended' && guard < 3000; guard++) {
        if (legalActions(s, 0).length > 0) {
          decisions++;
          const at = (r: number): PortraitSeat => ({ melds: s.players[r].melds.map((m) => m.tiles.length), flowers: s.players[r].flowers.length, discards: s.players[r].discards.length, hand: s.players[r].hand.length });
          const input = { ...SMALL, right: at(1), across: at(2), left: at(3), mine: s.players[0].discards.length, status: s.phase === 'discard' && s.turn === 0 ? 0 : 20 };
          const fit = fitPortraitFelt(input);
          const c = columns(input, fit);
          if (!fit.fits || c.right > c.room || c.left > c.room) failures.push(JSON.stringify({ h, right: input.right, left: input.left }));
          const a = legalActions(s, 0).find((x) => x.type === 'pass') ?? chooseAction(s, 0, { seed: 'me', skill: 'club' });
          if (a) {
            s = applyAction(s, 0, a);
            continue;
          }
        }
        let moved = false;
        for (let seatNo = 1; seatNo < 4 && !moved; seatNo++) {
          const a = chooseAction(s, seatNo, { seed: `b${seatNo}`, skill: 'club' });
          if (a) {
            s = applyAction(s, seatNo, a);
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    expect(decisions).toBeGreaterThan(400);
    expect(failures).toEqual([]);
    // Forty whole hands of bot play: about two seconds on an idle machine, so it gets more than the usual five.
  }, 60_000);
});

describe('a pond keeping its newest rows', () => {
  const tiles = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('draws every row when it keeps them all', () => {
    expect(pondRowsShown(tiles(9), 4)).toEqual({ rows: [[0, 1, 2, 3], [4, 5, 6, 7], [8]], earlier: 0 });
    expect(pondRowsShown(tiles(9), 4, Infinity).earlier).toBe(0);
    expect(pondRowsShown(tiles(9), 4, 3).earlier).toBe(0);
  });

  it('fills the rows it keeps with the newest discards, after the chip, so the newest is always drawn', () => {
    // The chip takes the first place; the kept rows hold the newest keep × 4 − 1 discards.
    expect(pondRowsShown(tiles(8), 4, 1)).toEqual({ rows: [[5, 6, 7]], earlier: 5 });
    expect(pondRowsShown(tiles(10), 4, 2)).toEqual({ rows: [[3, 4, 5], [6, 7, 8, 9]], earlier: 3 });
    // The pond's own newest row is short (its ninth discard alone): the kept row still shows three.
    expect(pondRowsShown(tiles(9), 4, 1)).toEqual({ rows: [[6, 7, 8]], earlier: 6 });
    for (const n of [1, 5, 12, 23]) for (const keep of [1, 2, 3]) {
      const { rows, earlier } = pondRowsShown(tiles(n), 4, keep);
      const drawn = rows.flat();
      expect(drawn[drawn.length - 1], `${n} ${keep}`).toBe(n - 1);
      expect(earlier + drawn.length).toBe(n);
      // The newest discards, in order.
      expect(drawn).toEqual(tiles(n).slice(earlier));
      // Behind a chip, every kept row is full; with the chip, no row is wider than the pond's.
      if (earlier > 0) expect(drawn.length).toBe(keep * 4 - 1);
      rows.forEach((r, i) => expect(r.length + (i === 0 && earlier > 0 ? 1 : 0)).toBeLessThanOrEqual(4));
    }
  });

  it('works out heights and rows as the components draw them', () => {
    expect(pondRows(0, 4)).toBe(0);
    expect(pondRows(9, 4)).toBe(3);
    expect(pondHeight(0, 20)).toBe(0);
    expect(pondHeight(2, 20)).toBe(28 + 2 + 28);
    expect(centerPondPerRow(80, 16)).toBe(4);
    expect(centerPondPerRow(30, 16)).toBe(3);
    expect(myPondPerRow(260, 16)).toBe(12);
    // A pong and a kong at 14 px with their claimed tile on its side take a row each in an 84 px column; flat at 12 px a
    // pong and a pong share one.
    expect(meldsHeight(84, [3, 4], 0, 14)).toBe(20 + 3 + 20);
    expect(meldsHeight(84, [3, 3], 0, 12, true)).toBe(17);
    expect(meldsHeight(84, [], 0, 14)).toBe(0);
  });
});
