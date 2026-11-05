/**
 * The first-run age gate (docs/STORE_COMPLIANCE.md, "Age rating"). The app asks for a birth
 * year only; with no birthday it assumes the latest one in that year, so a player counts as
 * 17 from 1 January of the year they turn 18. That errs on the side of keeping minors out.
 *
 * The answer is stored on the device (src/storage.ts) and sent with `PATCH /api/me` once the
 * device has a server session (`users.birth_year`). Pure, so the rules are unit-tested.
 */

/** The store age rating (simulated gambling, frequent → 17+). */
export const AGE_LIMIT = 17;

/** Oldest birth year accepted as plausible. */
export const MAX_AGE = 120;

export interface AgeRecord {
  birthYear: number;
  /** When it was given (epoch ms). */
  at: number;
  /** The server has it (PATCH /api/me succeeded). */
  synced: boolean;
}

export type AgeStatus = 'unknown' | 'allowed' | 'blocked';

/** A four-digit year typed by the player, or null when it is not a plausible birth year. */
export function parseBirthYear(input: string, currentYear: number): number | null {
  const s = input.trim();
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  return y <= currentYear && y >= currentYear - MAX_AGE ? y : null;
}

/** The youngest the player can be this year, given only the birth year. */
export function minimumAge(birthYear: number, currentYear: number): number {
  return currentYear - birthYear - 1;
}

export function ageStatus(record: AgeRecord | null, currentYear: number): AgeStatus {
  if (!record || !Number.isInteger(record.birthYear)) return 'unknown';
  return minimumAge(record.birthYear, currentYear) >= AGE_LIMIT ? 'allowed' : 'blocked';
}

/** The first year a blocked player is let in (from 1 January of that year). */
export function allowedFromYear(birthYear: number): number {
  return birthYear + AGE_LIMIT + 1;
}

/** Read a stored record; anything malformed counts as not asked yet. */
export function migrateAgeRecord(raw: unknown): AgeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AgeRecord>;
  if (typeof r.birthYear !== 'number' || !Number.isInteger(r.birthYear)) return null;
  return { birthYear: r.birthYear, at: typeof r.at === 'number' ? r.at : 0, synced: r.synced === true };
}

/** Whether to send the birth year with PATCH /api/me now. */
export function needsServerSync(record: AgeRecord | null, hasSession: boolean): boolean {
  return !!record && !record.synced && hasSession;
}

/**
 * Where the gate appears. On a fresh install it is the first thing asked, before the
 * welcome card; an install that already had a profile from an earlier version is asked
 * before its first visit to the Shop or Clubs. A blocked player sees the blocked screen
 * wherever the gate is checked.
 */
export function gateFor(where: 'home' | 'shop' | 'clubs', status: AgeStatus, firstRun: boolean): 'none' | 'ask' | 'blocked' {
  if (status === 'blocked') return 'blocked';
  if (status === 'allowed') return 'none';
  return where === 'home' ? (firstRun ? 'ask' : 'none') : 'ask';
}
