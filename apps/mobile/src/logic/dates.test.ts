import { describe, expect, it } from 'vitest';
import { localDateKey, localDayAsUtc, previousDateKey, shiftDateKey } from './dates';

describe('local date keys', () => {
  it('uses the local calendar date, not the UTC one', () => {
    // 23:30 local on 5 Nov is a different UTC date in most zones east or west of UTC; the key must follow local fields.
    const d = new Date(2026, 10, 5, 23, 30);
    expect(localDateKey(d)).toBe('2026-11-05');
    const early = new Date(2026, 10, 6, 0, 15);
    expect(localDateKey(early)).toBe('2026-11-06');
  });

  it('pads months and days', () => {
    expect(localDateKey(new Date(2027, 0, 3, 12))).toBe('2027-01-03');
  });

  it('steps back across month and year boundaries', () => {
    expect(previousDateKey('2026-03-01')).toBe('2026-02-28');
    expect(previousDateKey('2028-03-01')).toBe('2028-02-29');
    expect(previousDateKey('2027-01-01')).toBe('2026-12-31');
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('steps one calendar day across a DST change', () => {
    // Whatever the test machine's zone, every day of the year steps back by exactly one calendar day.
    let key = '2026-12-31';
    for (let i = 0; i < 365; i++) {
      const prev = previousDateKey(key);
      expect(shiftDateKey(prev, 1)).toBe(key);
      key = prev;
    }
    expect(key).toBe('2025-12-31');
  });

  it('maps the local day onto UTC fields for the puzzle seed', () => {
    const d = new Date(2026, 10, 5, 23, 59);
    const u = localDayAsUtc(d);
    expect([u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()]).toEqual([2026, 10, 5]);
    // Same weekday as the local date (the engine picks difficulty by weekday).
    expect(u.getUTCDay()).toBe(d.getDay());
  });
});
