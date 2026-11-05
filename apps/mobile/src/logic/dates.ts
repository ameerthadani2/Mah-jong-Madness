/**
 * Calendar-day keys in the player's own time zone. A "day" for streaks and the
 * daily puzzle is the local calendar date, so it rolls over at local midnight.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for the local calendar date of `d`. */
export function localDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The key `days` calendar days after `key` (negative goes back). Safe across DST changes. */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return localDateKey(new Date(y, m - 1, d + days));
}

/** The key of the calendar day before `key`. */
export function previousDateKey(key: string): string {
  return shiftDateKey(key, -1);
}

/**
 * A Date whose UTC calendar fields equal the local calendar date of `d`. The engine
 * seeds the daily puzzle from UTC fields; passing this keeps the puzzle in step with
 * the local day the attempt is recorded under.
 */
export function localDayAsUtc(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
