import { previousDateKey } from './dates';

/** The daily-puzzle fields of the saved progress. */
export interface DailyProgress {
  /** One attempt per local day, keyed `YYYY-MM-DD`. */
  dailySolved: Record<string, 'correct' | 'wrong'>;
  /** Consecutive local days with an attempt, ending at `dailyLastDate`. */
  dailyStreak: number;
  dailyLastDate: string | null;
}

/**
 * Records today's attempt. The streak counts consecutive days on which the puzzle
 * was attempted (a wrong answer still keeps it alive); a second attempt on the same
 * day changes nothing.
 */
export function nextDailyProgress<T extends DailyProgress>(p: T, correct: boolean, today: string): T {
  if (p.dailySolved[today] !== undefined) return p;
  const continues = p.dailyStreak > 0 && p.dailyLastDate === previousDateKey(today);
  return {
    ...p,
    dailySolved: { ...p.dailySolved, [today]: correct ? 'correct' : 'wrong' },
    dailyStreak: continues ? p.dailyStreak + 1 : 1,
    dailyLastDate: today,
  };
}

/** The streak as it should be shown today: it lapses once a whole day has been missed. */
export function effectiveStreak(p: DailyProgress, today: string): number {
  if (!p.dailyLastDate) return 0;
  return p.dailyLastDate === today || p.dailyLastDate === previousDateKey(today) ? p.dailyStreak : 0;
}
