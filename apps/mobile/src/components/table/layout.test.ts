import { describe, expect, it } from 'vitest';
import { calloutMs, RESULT_HOLD_MS, rollUp, rollUpMs, slideFrom } from './feel';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ACTION_DOCK_H, coachBubbleHeight, coachBudget, coachTextLines, COACH_MAX_ADVICE_LINES, COACH_STATUS_LINE_H, compactCompassSize, dockHeight, fitTile, fitWallSize, handLayout, landscapeWallSize, MIN_TOUCH, resultLayout, slopFor, tableLayout, TAP_HINT_DOCK_H } from './layout';

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

describe('own pond, coach and compass on short landscape (the claim buttons have a row of their own)', () => {
  // The claim sentences the engine can show (packages/engine/src/hints.ts): the usual one, and the longest.
  const USUAL = 'This claim brings you closer to ready. You would lose 門清 (1 台, or 門清自摸 3 台).';
  const LONGEST = 'This claim would bring you closer to ready, but your concealed hand is worth more here. You would lose 門清 (1 台, or 門清自摸 3 台).';
  const pondRow = 28;

  it('never budgets the coach over my pond: the bubble ends above it', () => {
    for (const dock of ['none', 'hint', 'buttons'] as const) {
      for (const [columnH, pondH] of [[135, pondRow], [97, pondRow * 2], [80, pondRow]]) {
        const b = coachBudget(columnH, dock, pondH);
        expect(b.maxHeight! + pondH, `${dock} ${columnH}/${pondH}`).toBeLessThanOrEqual(columnH);
        if (b.lines > 0) expect(coachBubbleHeight(b), `${dock} ${columnH}/${pondH}`).toBeLessThanOrEqual(b.maxHeight! + COACH_STATUS_LINE_H);
      }
    }
  });

  it('gives the claim advice the room the status line leaves, text-only, while the buttons are up', () => {
    const b = coachBudget(135, 'buttons', pondRow);
    expect(b).toMatchObject({ statusLines: 0, textOnly: true });
    expect(b.lines).toBeGreaterThanOrEqual(3);
    // Text width of the right-hand column at 667×375 (beside the 62 px compass); the longest sentence scrolls
    // inside the bubble when it needs more lines than fit, so it is never cut off.
    const width = tableLayout(667, 375).centerW - 12 - 62 - 6 - 22;
    expect(coachTextLines(USUAL, width)).toBeGreaterThan(0);
    expect(coachTextLines(LONGEST, width)).toBeGreaterThan(0);
  });

  it('hides the bubble rather than a clipped sliver when there is no line of room above my pond', () => {
    // Two rows of my pond (40 px measured) plus the 4 px gap, then the room left for the bubble.
    expect(coachBudget(40 + 4 + 20, 'buttons', 40).lines).toBe(0);
    expect(coachBudget(40 + 4 + 27, 'buttons', 40).lines).toBe(1);
  });

  it('keeps one status line under the tap hint, two with nothing docked, and never more than four advice lines', () => {
    const hint = coachBudget(135, 'hint', pondRow);
    expect(hint).toMatchObject({ statusLines: 1, textOnly: false });
    expect(hint.lines).toBeGreaterThanOrEqual(3);
    const none = coachBudget(135, 'none', pondRow);
    expect(none).toMatchObject({ statusLines: 2, textOnly: false });
    expect(none.lines).toBeGreaterThanOrEqual(2);
    expect(coachBudget(400, 'none').lines).toBe(COACH_MAX_ADVICE_LINES);
    expect(coachBudget(0, 'buttons')).toMatchObject({ maxHeight: null, lines: COACH_MAX_ADVICE_LINES });
  });

  it('never cuts the coach text with an ellipsis: it scrolls inside the bubble', () => {
    const src = readFileSync(join(__dirname, 'CoachPanel.tsx'), 'utf8');
    const compact = src.slice(src.indexOf('if (compact)'), src.indexOf('return (\n    <View style={styles.coach} accessibilityRole'));
    expect(compact).not.toMatch(/numberOfLines/);
    expect(compact).toMatch(/<ScrollView/);
  });

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

describe('portrait felt (360×740 late in a hand)', () => {
  it('shrinks the wall ring so the felt content fits its scroll view, keeping my pond on screen', () => {
    // Measured before: content 483 px against a 429 px view at 360×740 with a 124 px ring.
    expect(fitWallSize(124, 483, 429, 124, 68)).toBe(70);
    // Converges: at the new size the content fits and the ring stays.
    expect(fitWallSize(70, 429, 429, 124, 68)).toBe(70);
    // Grows back when there is room again, never past its full size.
    expect(fitWallSize(70, 380, 429, 124, 68)).toBe(119);
    expect(fitWallSize(119, 300, 429, 124, 68)).toBe(124);
  });

  it('on a landscape tablet sizes the ring to what the across seat and my pond leave, so my pond stays on the felt', () => {
    expect(landscapeWallSize(0, 0, 0, 300, 112)).toBe(300);
    expect(landscapeWallSize(600, 130, 80, 300, 112)).toBe(300);
    // Extra-large tiles: a taller across seat and pond.
    expect(landscapeWallSize(560, 230, 150, 300, 112)).toBe(156);
    expect(landscapeWallSize(400, 230, 150, 300, 112)).toBe(0);
  });

  it('pins my pond under the scrolling part of the felt, so it never scrolls out of view (any tile size)', () => {
    const felt = readFileSync(join(__dirname, 'Felt.tsx'), 'utf8');
    expect(felt).toMatch(/<\/ScrollView>\s*<View style=\{styles\.pinnedPond\}>\{myPond\(pinnedPerRow\)\}<\/View>/);
    expect(felt).toMatch(/\{!portrait && myPond\(centerPerRow\)\}/);
  });

  it('drops the ring for the compass alone when even the smallest ring would not fit, and brings it back only with room for all of it', () => {
    expect(fitWallSize(80, 520, 429, 124, 68)).toBe(0);
    expect(fitWallSize(0, 400, 429, 124, 68)).toBe(0);
    expect(fitWallSize(0, 350, 429, 124, 68)).toBe(68);
    // Unmeasured: unchanged.
    expect(fitWallSize(124, 0, 429, 124, 68)).toBe(124);
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
