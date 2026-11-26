import { describe, expect, it } from 'vitest';
import { calloutMs, RESULT_HOLD_MS, rollUp, rollUpMs, slideFrom } from './feel';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ACTION_DOCK_H, CENTRE_KEEP, COACH_PANEL_MAX, coachBarLines, compactCompassSize, dockHeight, fitTile, handLayout, landscapeWallSize, matchOverLayout, MIN_TOUCH, pinnedCoachFace, portraitCoachStatus, resultLayout, slopFor, tableLayout, TAP_HINT_DOCK_H } from './layout';

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

  it('places the coach above the hand on landscape phones, under the right seat on tablets, pinned under the felt in portrait', () => {
    // Never in a share of the felt's middle on a phone: the ponds and the claim buttons can take all of it there.
    for (const [w, h] of [[844, 390], [667, 375], [640, 360], [568, 320], [932, 430]]) expect(tableLayout(w, h).coach, `${w}x${h}`).toBe('rail');
    expect(tableLayout(1024, 768).coach).toBe('side');
    for (const [w, h] of [[390, 844], [360, 740], [320, 568]]) expect(tableLayout(w, h).coach, `${w}x${h}`).toBe('pinned');
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

// The showcase review of 20 November: on an 11-inch tablet (1194 x 834) the coach's panel, 214 px wide under the right
// seat, broke its lines every dozen characters (補 / 到胡牌, 槓上開花（1 / 台）).
describe("the coach's side panel", () => {
  it('reaches into the centre where it has room, up to 300 px in all, and leaves the centre at least 520 px', () => {
    for (const [w, h] of [
      [1194, 834],
      [1366, 1024],
      [1180, 820],
      [1112, 834],
    ]) {
      const L = tableLayout(w, h);
      expect(L.coach, `${w}x${h}`).toBe('side');
      expect(L.coachReach, `${w}x${h}`).toBeGreaterThan(0);
      expect(L.sideWidth + L.coachReach, `${w}x${h}`).toBeLessThanOrEqual(COACH_PANEL_MAX);
      expect(L.centerW - 2 * L.coachReach, `${w}x${h}`).toBeGreaterThanOrEqual(CENTRE_KEEP);
      // The wall ring, centred, stays clear of the strip the panel takes.
      expect((L.centerW - L.wallSize) / 2, `${w}x${h}`).toBeGreaterThan(L.coachReach);
    }
    // The showcase's tablet, and a 12.9-inch one: the whole 300 px.
    expect(tableLayout(1194, 834).sideWidth + tableLayout(1194, 834).coachReach).toBe(COACH_PANEL_MAX);
    expect(tableLayout(1366, 1024).sideWidth + tableLayout(1366, 1024).coachReach).toBe(COACH_PANEL_MAX);
  });

  it('keeps the side column\'s width where the centre has no room to give, and anywhere the coach is not a side panel', () => {
    expect(tableLayout(1024, 768).coachReach).toBe(0);
    for (const [w, h] of [
      [390, 844],
      [844, 390],
      [667, 375],
      [768, 1024],
    ]) expect(tableLayout(w, h).coachReach, `${w}x${h}`).toBe(0);
  });
});

describe('the coach bar', () => {
  it('always has a line for the advice, wherever it is placed and whatever the tiles', () => {
    for (const place of ['pinned', 'rail'] as const)
      for (const besidePlate of [false, true]) {
        const lines = coachBarLines(place, besidePlate);
        expect(lines.advice, `${place} ${besidePlate}`).toBeGreaterThanOrEqual(1);
      }
  });

  it('shows the status over two lines of advice in portrait, and the advice alone above a landscape hand', () => {
    expect(coachBarLines('pinned')).toEqual({ status: 1, advice: 2 });
    // Normal tiles: a slim row of its own beside my plate, so the felt keeps its height.
    expect(coachBarLines('rail')).toEqual({ status: 0, advice: 1 });
    // Large and Extra-large tiles: beside my plate in the row the plate has of its own, which has the height for two.
    expect(coachBarLines('rail', true)).toEqual({ status: 0, advice: 2 });
  });

  it('pinned under the portrait felt, shows the status only on a tall phone or a tablet, and two lines of advice always', () => {
    expect(coachBarLines('pinned', false, false)).toEqual({ status: 0, advice: 2 });
    expect(portraitCoachStatus(844)).toBe(true);
    expect(portraitCoachStatus(1024)).toBe(true);
    for (const h of [568, 640, 667, 740]) expect(portraitCoachStatus(h), `${h}`).toBe(false);
  });

  it('draws the pinned bar at least 44 px tall, so it is its own press and needs no padding over its neighbours', () => {
    // 9 px of border and padding, a 17 px status, 15 px advice lines.
    expect(pinnedCoachFace(false)).toBe(MIN_TOUCH);
    expect(pinnedCoachFace(true)).toBe(9 + 17 + 2 * 15);
    // A larger OS text size grows the lines, never below 44.
    expect(pinnedCoachFace(false, 1.4)).toBe(Math.ceil(9 + 30 * 1.4));
    expect(pinnedCoachFace(true, 1.4)).toBe(Math.ceil(9 + 47 * 1.4));
    expect(pinnedCoachFace(false, 0.8)).toBe(MIN_TOUCH);
    expect(pinnedCoachFace(true, Number.NaN)).toBe(56);
  });
});

describe('own pond and compass on short landscape (the claim buttons have a row of their own)', () => {
  it('gives the claim buttons a row of their own (short landscape) or floats them above my pond (tablets), never over it', () => {
    expect(dockHeight('none', false)).toBe(0);
    expect(dockHeight('hint', false)).toBe(TAP_HINT_DOCK_H);
    expect(dockHeight('buttons', false)).toBe(ACTION_DOCK_H);
    expect(dockHeight('buttons', true)).toBeGreaterThan(ACTION_DOCK_H);
    const felt = readFileSync(join(__dirname, 'Felt.tsx'), 'utf8');
    expect(felt).toMatch(/styles\.actionRow, \{ minHeight: dockH \}/);
    expect(felt).toMatch(/styles\.actionCenter, \{ bottom: pondH \+ 4 \}/);
  });

  it('shrinks the compass to the row that is left, and drops it under 40 px', () => {
    expect(compactCompassSize(0, 62)).toBe(62);
    expect(compactCompassSize(120, 62)).toBe(62);
    expect(compactCompassSize(56, 62)).toBe(50);
    expect(compactCompassSize(40, 62)).toBe(0);
  });
});

describe('the wall ring and the claim strip', () => {
  it('on a landscape tablet sizes the ring to what the across seat and my pond leave, so my pond stays on the felt', () => {
    expect(landscapeWallSize(0, 0, 0, 300, 112)).toBe(300);
    expect(landscapeWallSize(600, 130, 80, 300, 112)).toBe(300);
    // Extra-large tiles: a taller across seat and pond.
    expect(landscapeWallSize(560, 230, 150, 300, 112)).toBe(156);
    expect(landscapeWallSize(400, 230, 150, 300, 112)).toBe(0);
  });

  it('lets the portrait claim strip grow with its buttons, so a wrapped 胡 never sits under the hand rail', () => {
    const screen = readFileSync(join(__dirname, '../../screens/TableScreen.tsx'), 'utf8');
    expect(screen).toMatch(/actionStrip: \{ minHeight: ACTION_STRIP_H/);
  });

});

describe('resultLayout', () => {
  it('uses two columns with a 2×2 score grid on 667×375 so the buttons are on screen', () => {
    expect(resultLayout(667, 375)).toEqual({ twoCol: true, scoreCols: 2, stackButtons: false, shortReview: true });
  });

  it('stacks equal-width buttons on narrow portrait phones', () => {
    expect(resultLayout(360, 740).stackButtons).toBe(true);
    expect(resultLayout(390, 844).stackButtons).toBe(true);
    expect(resultLayout(1024, 768).stackButtons).toBe(false);
  });

  it('says "Review" rather than "Review my hand" where half a row is narrower than the long label (a 320 pt phone)', () => {
    expect(resultLayout(320, 568).shortReview).toBe(true);
    expect(resultLayout(360, 640).shortReview).toBe(false);
    expect(resultLayout(390, 844).shortReview).toBe(false);
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

describe('matchOverLayout', () => {
  it('never lets the card be taller than the window: it scrolls inside it', () => {
    for (const h of [375, 390, 740, 768, 844]) {
      const L = matchOverLayout(h);
      expect(L.maxHeight).toBe(h - 2 * L.pad);
      expect(L.maxHeight).toBeLessThan(h);
    }
  });

  it('takes its small sizes on a short landscape phone, where the usual card was taller than the window', () => {
    expect(matchOverLayout(375)).toMatchObject({ compact: true, pad: 8, title: 22, avatar: 26 });
    expect(matchOverLayout(390).compact).toBe(true);
    expect(matchOverLayout(768)).toMatchObject({ compact: false, pad: 16, title: 28, avatar: 34 });
    // Four ranks, the ribbon and the button at the small sizes, as measured: well inside 375 px.
    const L = matchOverLayout(375);
    const ranks = 4 * (L.avatar + 2 * L.rowPad + 2);
    expect(16 + (L.title + 12) + ranks + 46 + 5 * 6).toBeLessThanOrEqual(L.maxHeight);
  });

  // That the match-over card is drawn with it, its standings and the way home inside one scroll view, is rendered in
  // src/components/table/ResultSheet.render.test.tsx.
});
