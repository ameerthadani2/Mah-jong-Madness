import { describe, expect, it } from 'vitest';
import { calloutMs, RESULT_HOLD_MS, rollUp, rollUpMs, slideFrom } from './feel';
import { fitTile, handLayout, MIN_TOUCH, resultLayout, slopFor, tableLayout } from './layout';

describe('tableLayout', () => {
  it('docks the claim buttons over the centre column in landscape, never over a side pond', () => {
    for (const [w, h] of [[844, 390], [667, 375], [1024, 768]]) expect(tableLayout(w, h).actions).toBe('center');
    expect(tableLayout(390, 844).actions).toBe('strip');
    expect(tableLayout(360, 740).actions).toBe('strip');
  });

  it('moves the status pill to the HUD on short landscape phones so my pond clears the hand rail', () => {
    expect(tableLayout(844, 390).statusInHud).toBe(true);
    expect(tableLayout(667, 375).statusInHud).toBe(true);
    expect(tableLayout(1024, 768).statusInHud).toBe(false);
    expect(tableLayout(390, 844).statusInHud).toBe(false);
  });

  it('places the coach beside the compass on short landscape, under the right seat on tall landscape, below in portrait', () => {
    expect(tableLayout(844, 390).coach).toBe('center');
    expect(tableLayout(1024, 768).coach).toBe('side');
    expect(tableLayout(390, 844).coach).toBe('below');
  });

  it('fits my pond beside the compass on short landscape phones', () => {
    for (const [w, h] of [[844, 390], [667, 375]]) {
      const l = tableLayout(w, h);
      expect(l.myPerRow * 22 + l.compassSize + 14, `${w}x${h}`).toBeLessThanOrEqual(l.centerW);
      expect(l.myPerRow).toBeGreaterThanOrEqual(10);
    }
  });

  it('keeps a smaller compass on short landscape phones', () => {
    expect(tableLayout(667, 375).compassSize).toBeLessThan(tableLayout(1024, 600).compassSize);
  });

  it('always fits a full hand on the rail', () => {
    for (const [w, h] of [[844, 390], [667, 375], [1024, 768]]) {
      const l = tableLayout(w, h);
      const hand = handLayout(w, l, 17, 0, 0);
      expect(hand.tile * 17 + 2 * 16 + 10, `${w}x${h}`).toBeLessThanOrEqual(w - hand.plateW - 24);
    }
    // Portrait wraps into rows of nine.
    const p = handLayout(360, tableLayout(360, 740), 17, 0, 0);
    expect(p.tile * 9 + 2 * 8).toBeLessThanOrEqual(360 - 24);
  });
});

describe('resultLayout', () => {
  it('uses two columns with a 2×2 score grid on 667×375 so the buttons are on screen', () => {
    expect(resultLayout(667, 375)).toEqual({ twoCol: true, scoreCols: 2, stackButtons: false });
  });

  it('stacks equal-width buttons on narrow portrait phones', () => {
    expect(resultLayout(360, 740).stackButtons).toBe(true);
    expect(resultLayout(390, 844).stackButtons).toBe(true);
    expect(resultLayout(1024, 768).stackButtons).toBe(false);
  });
});

describe('fitTile', () => {
  it('shrinks a lesson row of nine so 九萬 is not clipped on a 390 px phone', () => {
    // Card content width on a 390 px phone: 390 − 2 × 16 (screen) − 2 × 16 (card) − borders.
    const room = 390 - 32 - 32 - 6;
    const w = fitTile(room, 9, 40);
    expect(w * 9 + 2 * 8).toBeLessThanOrEqual(room);
    expect(w).toBeGreaterThanOrEqual(30);
  });

  it('keeps the requested size when it fits, and never goes below the minimum', () => {
    expect(fitTile(1000, 9, 40)).toBe(40);
    expect(fitTile(50, 14, 40)).toBe(18);
  });
});

describe('touch targets', () => {
  it('grows small controls to 44 pt with hitSlop', () => {
    for (const size of [20, 32, 38, 42, 44, 60]) expect(size + 2 * slopFor(size)).toBeGreaterThanOrEqual(MIN_TOUCH);
    expect(slopFor(60)).toBe(0);
    expect(slopFor(60, 4)).toBe(4);
  });
});

describe('feel', () => {
  it('rolls a counter up from 0, monotonically, landing exactly on the value', () => {
    for (const target of [1, 8, 23, -160, 440]) {
      const d = rollUpMs(target);
      let last = 0;
      for (let t = 0; t <= d; t += 16) {
        const v = rollUp(target, t, d);
        expect(Math.abs(v)).toBeGreaterThanOrEqual(Math.abs(last));
        expect(Math.abs(v)).toBeLessThanOrEqual(Math.abs(target));
        last = v;
      }
      expect(rollUp(target, 0, d)).toBe(0);
      expect(rollUp(target, d, d)).toBe(target);
    }
    expect(rollUpMs(1000)).toBeLessThanOrEqual(900);
  });

  it('holds 胡 and 自摸 banners for the result hold, claims briefly', () => {
    expect(calloutMs('hu')).toBe(RESULT_HOLD_MS.win);
    expect(calloutMs('selfdraw')).toBe(RESULT_HOLD_MS.win);
    expect(calloutMs('pong')).toBeLessThan(1500);
  });

  it('slides each discard in from its owner’s side of the table', () => {
    expect(slideFrom(0).y).toBeGreaterThan(0);
    expect(slideFrom(1).x).toBeGreaterThan(0);
    expect(slideFrom(2).y).toBeLessThan(0);
    expect(slideFrom(3).x).toBeLessThan(0);
  });
});
