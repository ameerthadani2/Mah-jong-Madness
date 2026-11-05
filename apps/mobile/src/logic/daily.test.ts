import { describe, expect, it } from 'vitest';
import { effectiveStreak, nextDailyProgress, type DailyProgress, clampDailyToToday } from './daily';

const fresh = (): DailyProgress => ({ dailySolved: {}, dailyStreak: 0, dailyLastDate: null });

describe('nextDailyProgress', () => {
  it('starts a streak of one on the first attempt', () => {
    const p = nextDailyProgress(fresh(), true, '2026-11-05');
    expect(p.dailyStreak).toBe(1);
    expect(p.dailyLastDate).toBe('2026-11-05');
    expect(p.dailySolved).toEqual({ '2026-11-05': 'correct' });
  });

  it('a wrong answer still counts as attempting and extends the streak', () => {
    let p = nextDailyProgress(fresh(), true, '2026-11-04');
    p = nextDailyProgress(p, false, '2026-11-05');
    expect(p.dailyStreak).toBe(2);
    expect(p.dailySolved['2026-11-05']).toBe('wrong');
    p = nextDailyProgress(p, true, '2026-11-06');
    expect(p.dailyStreak).toBe(3);
  });

  it('restarts at one after a missed day', () => {
    let p = nextDailyProgress(fresh(), true, '2026-11-01');
    p = nextDailyProgress(p, true, '2026-11-02');
    p = nextDailyProgress(p, true, '2026-11-04');
    expect(p.dailyStreak).toBe(1);
  });

  it('continues across a month boundary', () => {
    let p = nextDailyProgress(fresh(), true, '2026-10-31');
    p = nextDailyProgress(p, true, '2026-11-01');
    expect(p.dailyStreak).toBe(2);
  });

  it('ignores a second attempt on the same day', () => {
    const once = nextDailyProgress(fresh(), false, '2026-11-05');
    const twice = nextDailyProgress(once, true, '2026-11-05');
    expect(twice).toBe(once);
    expect(twice.dailySolved['2026-11-05']).toBe('wrong');
  });

  it('keeps unrelated progress fields', () => {
    const p = nextDailyProgress({ ...fresh(), rushBest: 7 }, true, '2026-11-05');
    expect(p.rushBest).toBe(7);
  });
});

describe('effectiveStreak', () => {
  const p: DailyProgress = { dailySolved: { '2026-11-04': 'correct' }, dailyStreak: 4, dailyLastDate: '2026-11-04' };

  it('shows the streak on the day of the last attempt and the day after', () => {
    expect(effectiveStreak(p, '2026-11-04')).toBe(4);
    expect(effectiveStreak(p, '2026-11-05')).toBe(4);
  });

  it('lapses once a whole day is missed', () => {
    expect(effectiveStreak(p, '2026-11-06')).toBe(0);
  });

  it('is zero before any attempt', () => {
    expect(effectiveStreak(fresh(), '2026-11-05')).toBe(0);
  });
});

describe('clampDailyToToday', () => {
  const base = { dailySolved: {} as Record<string, 'correct' | 'wrong'>, dailyStreak: 0, dailyLastDate: null as string | null };
  it('leaves a sane save untouched', () => {
    const p = { ...base, dailySolved: { '2026-11-04': 'correct' as const }, dailyStreak: 1, dailyLastDate: '2026-11-04' };
    expect(clampDailyToToday(p, '2026-11-05')).toBe(p);
  });
  it('pulls an attempt saved under tomorrow back to today and keeps the streak visible', () => {
    const p = { ...base, dailySolved: { '2026-11-05': 'wrong' as const, '2026-11-06': 'correct' as const }, dailyStreak: 2, dailyLastDate: '2026-11-06' };
    const out = clampDailyToToday(p, '2026-11-05');
    expect(out.dailySolved).toEqual({ '2026-11-05': 'wrong' });
    expect(out.dailyLastDate).toBe('2026-11-05');
    expect(out.dailyStreak).toBe(2);
    expect(clampDailyToToday(out, '2026-11-05')).toBe(out);
  });
  it('moves a lone future attempt onto today', () => {
    const out = clampDailyToToday({ ...base, dailySolved: { '2026-11-06': 'correct' as const }, dailyStreak: 1, dailyLastDate: '2026-11-06' }, '2026-11-05');
    expect(out.dailySolved).toEqual({ '2026-11-05': 'correct' });
  });
});
