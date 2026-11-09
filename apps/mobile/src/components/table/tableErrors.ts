/**
 * Refusals from the game server and the table host when creating, joining or running a table, localised by
 * their `code` (or, for the table host's error frames, which the client keeps only as a message, by the
 * server's sentence): one seat per account, a table that is gone or full, the server or the account at its
 * table limit, and table controls that only the table opener or a club admin may use. Anything else falls back
 * to logic/errors.ts `friendlyError`. Used wherever a join or lobby error is shown (Online, Lobby, the table's
 * toast, Home's resume card).
 */
import { friendlyError } from '../../logic/errors';
import type { Message, Translate } from '../../logic/translate';

const BY_CODE: Readonly<Record<string, string>> = {
  already_seated: 'online.errors.alreadySeated',
  room_unavailable: 'online.errors.roomUnavailable',
  server_full: 'online.errors.serverFull',
  table_cap: 'online.errors.tableCap',
  not_controller: 'online.errors.notController',
};

/** The servers' own sentences (apps/signal/src/rooms.ts, packages/net/src/host.ts), for errors that arrive without a code. */
const BY_MESSAGE: ReadonlyArray<readonly [RegExp, string]> = [
  [/already has a seat at this table/i, 'online.errors.alreadySeated'],
  [/^room not found or full/i, 'online.errors.roomUnavailable'],
  [/server is full right now/i, 'online.errors.serverFull'],
  [/already have the most tables open/i, 'online.errors.tableCap'],
  [/only the table opener|table opener or a club admin/i, 'online.errors.notController'],
];

function str(e: unknown, key: 'code' | 'message'): string {
  if (typeof e === 'string') return key === 'message' ? e : '';
  if (e && typeof e === 'object' && key in e) {
    const v = (e as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/** The table-specific message for `e`, or null when it is not one of these refusals. */
export function tableErrorMessage(e: unknown): Message | null {
  const byCode = BY_CODE[str(e, 'code')];
  if (byCode) return { key: byCode };
  const msg = str(e, 'message').trim();
  for (const [re, key] of BY_MESSAGE) if (re.test(msg)) return { key };
  return null;
}

/** The sentence to show for a table error, in the current language. */
export function tableError(e: unknown, t: Translate): string {
  const m = tableErrorMessage(e);
  return m ? t(m.key, m.params) : friendlyError(e, t);
}
