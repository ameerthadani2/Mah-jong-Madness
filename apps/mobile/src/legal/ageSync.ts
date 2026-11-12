/**
 * Getting the age gate's birth year to the game server (docs/API.md, PATCH /api/me). The server
 * takes a birth year once: after that only the same year is accepted and any other answers
 * 409 `birth_year_locked`. So the app never sends its year blind:
 *
 *  - the routine sync (`syncBirthYear`) first asks GET /api/me and sends only when the account has none;
 *  - after the quick-match refusal `age_missing` the server has just said it has none, so the year
 *    is sent straight away (`sendBirthYear`);
 *  - `birth_year_locked` means a year is already on file: that counts as done, never as a failure to retry.
 *
 * Pure (the two requests are injected), so the rules are unit-tested.
 */

export interface AgeSyncServer {
  /** GET /api/me: the birth year on the account, or null when it has none. */
  birthYearOnFile(): Promise<number | null>;
  /** PATCH /api/me `{ birthYear }`. */
  sendBirthYear(year: number): Promise<unknown>;
}

/** 'sent': the server took it. 'on_file': it already had one. 'failed': not reached, try on a later visit. */
export type AgeSyncResult = 'sent' | 'on_file' | 'failed';

/** The server's refusal of a second, different birth year (409). */
export function isBirthYearLocked(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'birth_year_locked';
}

/** Sends the year without asking first: only for when the server has just said it has none (`age_missing`). */
export async function sendBirthYear(server: AgeSyncServer, year: number): Promise<AgeSyncResult> {
  try {
    await server.sendBirthYear(year);
    return 'sent';
  } catch (e) {
    return isBirthYearLocked(e) ? 'on_file' : 'failed';
  }
}

/** The routine sync of an unsent answer: asks what the account has, and sends the year only when it has none. */
export async function syncBirthYear(server: AgeSyncServer, year: number): Promise<AgeSyncResult> {
  let onFile: number | null;
  try {
    onFile = await server.birthYearOnFile();
  } catch {
    return 'failed';
  }
  if (onFile !== null) return 'on_file';
  return sendBirthYear(server, year);
}

/** Whether the local record can be marked as on the server after `result`. */
export function ageSyncDone(result: AgeSyncResult): boolean {
  return result !== 'failed';
}
