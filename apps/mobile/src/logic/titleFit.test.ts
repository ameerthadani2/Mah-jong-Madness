import { describe, expect, it } from 'vitest';
import { clubTitleSize, titleEms, TITLE_SIZES } from './titleFit';

/** Lines a title takes at this size in a column this wide, with a fifth of each line lost to word wrapping. */
const lines = (name: string, width: number) => Math.ceil((titleEms(name) * clubTitleSize(name)) / (width * 0.8));

describe('a club name in its header', () => {
  // The title column at 360 wide: the screen less its padding (2 x 16), the Back button (44) and the gap (12).
  const NARROW = 360 - 32 - 44 - 12;

  it('keeps the display size for a short name in either script', () => {
    expect(clubTitleSize('Dragon Gate')).toBe(TITLE_SIZES[0]);
    expect(clubTitleSize('週五夜麻將同好會')).toBe(TITLE_SIZES[0]);
    expect(lines('週五夜麻將同好會', NARROW)).toBeLessThanOrEqual(2);
  });

  it('steps down for a long name so that all of it is shown in a few lines on the narrowest phone', () => {
    const long = 'Dragon Gate Mahjong Society of Taipei';
    expect(clubTitleSize(long)).toBeLessThan(TITLE_SIZES[0]);
    expect(lines(long, NARROW)).toBeLessThanOrEqual(3);
    const longest = '麻'.repeat(40);
    expect(clubTitleSize(longest)).toBe(TITLE_SIZES[2]);
    expect(lines(longest, NARROW)).toBeLessThanOrEqual(4);
  });

  it('counts a full-width character as twice a Latin one', () => {
    expect(titleEms('麻將')).toBe(2);
    expect(titleEms('ab')).toBe(1);
    expect(titleEms('ａ')).toBe(1);
  });
});
