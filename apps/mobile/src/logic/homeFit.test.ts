import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LESSONS } from '@mjm/engine';
import { MIN_TOUCH, slopFor } from '../components/table/layout';
import { en, zhTW } from '../i18n/locales';
import { homePlayArtWidth, homeSmallWindowHeight, homeWindowHeight, isShortHome, LINK_GAP, LINK_HEIGHT, LINK_SLOP, SHORT_HOME_HEIGHT } from './homeFit';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('Home on a phone held sideways', () => {
  it('is short at 844x390, and not on a tablet, an upright phone or a tall window', () => {
    expect(isShortHome({ wide: true, tablet: false, height: 390 })).toBe(true);
    expect(isShortHome({ wide: true, tablet: false, height: SHORT_HOME_HEIGHT })).toBe(false);
    expect(isShortHome({ wide: true, tablet: true, height: 390 })).toBe(false);
    expect(isShortHome({ wide: false, tablet: false, height: 375 })).toBe(false);
  });

  it('shrinks the card art there and leaves the blurbs out, so buttons and links end above the bottom edge', () => {
    expect(homeWindowHeight({ wide: true, tablet: false, height: 390 })).toBeLessThanOrEqual(50);
    // Unchanged where there is room.
    expect(homeWindowHeight({ wide: true, tablet: false, height: 500 })).toBe(110);
    expect(homeWindowHeight({ wide: false, tablet: false, height: 844 })).toBe(104);
    expect(homeWindowHeight({ wide: true, tablet: true, height: 768 })).toBe(215);
    const home = read('screens/HomeScreen.tsx');
    expect(home.match(/\{!compact && !short && \(/g)).toHaveLength(2);
  });

  it('gives the small cards less art on a short upright phone, where the full rules line needs the room', () => {
    expect(homeSmallWindowHeight({ wide: false, tablet: false, height: 740 })).toBe(80);
    expect(homeSmallWindowHeight({ wide: false, tablet: false, height: 844 })).toBe(100);
    expect(homeSmallWindowHeight({ wide: true, tablet: false, height: 390 })).toBe(homeWindowHeight({ wide: true, tablet: false, height: 390 }));
  });
});

describe('Home text and touch targets', () => {
  const home = read('screens/HomeScreen.tsx');

  it('shows the rules line and the profile line whole on an upright phone', () => {
    expect(home).toMatch(/numberOfLines=\{phoneLand \? 2 : undefined\}/);
    expect(home).toMatch(/numberOfLines=\{wide \? 1 : 2\} style=\{styles\.profileMeta\}/);
  });

  it('counts lessons out of the lessons there are', () => {
    expect(LESSONS.length).toBeGreaterThan(6);
    expect(home).toMatch(/learnSummary\(LESSONS, LESSON_TRACKS, app\.progress\.lessonsDone\)/);
    expect(home).not.toMatch(/total: \d/);
  });

  it('draws the text links and the chips tall enough for their hitSlop to reach 44 pt', () => {
    expect(LINK_HEIGHT + LINK_SLOP.top + LINK_SLOP.bottom).toBeGreaterThanOrEqual(MIN_TOUCH);
    // A link's press reaches up only as far as the gap to the button above it: a tap on that button's bottom edge stays
    // the button's (the web's padding is the same: linkWebPress).
    expect(LINK_SLOP.top).toBeLessThanOrEqual(LINK_GAP - 2);
    expect(home.match(/hitSlop=\{LINK_SLOP\} style=\{\[styles\.link, linkWebPress\]\}/g)).toHaveLength(2);
    expect(home).toMatch(/paddingTop: LINK_SLOP\.top, marginTop: -LINK_SLOP\.top, paddingBottom: LINK_SLOP\.bottom, marginBottom: -LINK_SLOP\.bottom/);
    expect(home).toMatch(/cardFoot: \{[^}]*gap: LINK_GAP/);
    expect(home).toMatch(/link: \{[^}]*minHeight: LINK_HEIGHT/);
    const ui = read('components/Ui.tsx');
    const chip = Number(/export const CHIP_HEIGHT = (\d+);/.exec(ui)?.[1]);
    expect(chip + 2 * slopFor(chip, 4)).toBeGreaterThanOrEqual(MIN_TOUCH);
    expect(ui).toMatch(/chip: \{[^}]*minHeight: CHIP_HEIGHT/);
    expect(ui).toMatch(/hitSlop=\{slopFor\(CHIP_HEIGHT, 4\)\}/);
  });

  it('uses a short label for My clubs on an upright phone, where the card button is narrowest', () => {
    expect(home).toMatch(/title=\{t\(compact && !landscape \? 'home\.clubs\.openShort' : 'home\.clubs\.open'\)\} accessibilityLabel=\{t\('home\.clubs\.open'\)\}/);
    expect([...zhTW.home.clubs.openShort].length).toBeLessThanOrEqual(3);
    expect(en.home.clubs.openShort.length).toBeLessThanOrEqual(8);
    // Quick match's too: 66 pt wide on a 320 pt phone, under the four characters of 快速配對.
    expect([...zhTW.quickmatch.buttonShort].length).toBeLessThanOrEqual(2);
    expect(en.quickmatch.buttonShort.length).toBeLessThanOrEqual(6);
  });

  it('gives the Play card’s text more of its row on a phone under 360 pt, so 開始打牌 is whole on its button', () => {
    expect(homePlayArtWidth(320)).toBe(112);
    expect(homePlayArtWidth(360)).toBe(156);
    expect(homePlayArtWidth(390)).toBe(156);
    expect(home).toMatch(/key="play" colorsPair=\{WINDOWS\.play\} windowH=\{windowH\} windowW=\{homePlayArtWidth\(width\)\}/);
  });
});
