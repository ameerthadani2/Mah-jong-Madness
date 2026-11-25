/**
 * The saved-table record is read back from device storage, where it can be cut short, hand-edited or left by
 * an older build. Home's Resume card and the resume code read its fields without asking, so a record is only
 * handed to them after every field they read has been checked here; anything else is treated as no saved table.
 */
import { DEFAULT_RULES, sanitizeRules } from '@mjm/engine';
import type { ActiveSession } from '../storage';

/**
 * A saved table older than this is stale: Home no longer offers it (the match it points at is long over at an honest
 * table). An online one that holds a match is not thrown away with it: the app keeps it in its archive
 * (`staleOnlineSession`, logic/tableArchive.ts), so a server that seats the account at that match later finds the phone
 * holding what it checked.
 */
export const SAVED_TABLE_MAX_AGE_MS = 12 * 3600_000;

const HOST_PHASES = ['lobby', 'commit', 'reveal', 'playing', 'hand_over', 'match_over'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const isFilled = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isSeat = (v: unknown): boolean => isCount(v) && v <= 3;
const isNumbers = (v: unknown, length?: number): boolean => Array.isArray(v) && (length === undefined || v.length === length) && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** The match position the Resume card prints (hand number) and the restored table starts from. */
function isSnapshot(v: unknown): boolean {
  return isObject(v) && isCount(v.handNumber) && isCount(v.dealerRotations) && isSeat(v.dealerSeat) && isCount(v.dealerStreak) && isSeat(v.prevailingWind) && isNumbers(v.scores, 4) && typeof v.matchOver === 'boolean';
}

/** The parts of a hand in play that the table draws from as soon as it opens. */
function isGame(v: unknown): boolean {
  return (
    isObject(v) &&
    isObject(v.rules) &&
    isText(v.seed) &&
    isCount(v.handNumber) &&
    isNumbers(v.scores, 4) &&
    isNumbers(v.wall) &&
    isCount(v.drawIndex) &&
    isCount(v.backIndex) &&
    Array.isArray(v.players) &&
    v.players.length === 4 &&
    v.players.every((p) => isObject(p) && Array.isArray(p.hand)) &&
    isSeat(v.turn) &&
    isText(v.phase) &&
    Array.isArray(v.actionLog) &&
    isCount(v.turnCounter)
  );
}

/** The offline table as the host wrote it (packages/net, SerializedHost): what its restore reads. */
function isSavedHost(v: unknown): boolean {
  if (!isObject(v) || v.version !== 1) return false;
  if (!isText(v.roomCode) || !isText(v.matchId) || !isObject(v.rules) || !isText(v.botSkill)) return false;
  if (!isText(v.phase) || !HOST_PHASES.includes(v.phase)) return false;
  if (!isSnapshot(v.snapshot)) return false;
  if (v.game !== null && !isGame(v.game)) return false;
  // A table that is playing or showing a result has a hand to show.
  if ((v.phase === 'playing' || v.phase === 'hand_over') && v.game === null) return false;
  if (!Array.isArray(v.seats) || v.seats.length !== 4 || !v.seats.every((s) => isObject(s) && isText(s.name) && typeof s.isBot === 'boolean')) return false;
  if (!isNumbers(v.banks) || !Array.isArray(v.audits)) return false;
  if (v.restarts !== undefined && !(Array.isArray(v.restarts) && v.restarts.every((r) => isObject(r) && Array.isArray(r.seats)))) return false;
  if (v.standIns !== undefined && !Array.isArray(v.standIns)) return false;
  if (v.handsWon !== undefined && !isNumbers(v.handsWon, 4)) return false;
  return true;
}

/** Rules a saved copy may lack and still be whole: an older build saved it before a few were added. */
const MISSING_RULES_ALLOWED = 3;

/**
 * A saved copy of the rules that can be used as it is: every value it holds is one the engine's sanitiser keeps,
 * and it lacks no more than MISSING_RULES_ALLOWED rules (those take the default, as for a table saved by an
 * older build). An emptied or hand-edited copy is damaged.
 */
export function rulesIntact(v: unknown): boolean {
  if (!isObject(v)) return false;
  const clean = sanitizeRules(v) as unknown as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_RULES);
  const missing = keys.filter((k) => v[k] === undefined).length;
  return missing <= MISSING_RULES_ALLOWED && keys.every((k) => v[k] === undefined || v[k] === clean[k]);
}

/**
 * The rules are read as numbers all through the table (the wall count is the wall less the dead wall), so an
 * emptied or hand-edited rules object would open a table showing NaN. The table keeps two copies (its own and the
 * hand in play's): when one is damaged and the other intact, both take the intact one. When both are damaged (or
 * the only one, between hands), they are sanitised as the engine sanitises any rules from outside (broken values
 * take the default), and the record says so (`rulesReset`), so the resumed table can tell the player.
 */
function withSaneRules(raw: Record<string, unknown>, host: Record<string, unknown>): Record<string, unknown> {
  const game = isObject(host.game) ? host.game : null;
  const tableOk = rulesIntact(host.rules);
  const gameOk = game !== null && rulesIntact(game.rules);
  const rules = tableOk ? sanitizeRules(host.rules) : gameOk ? sanitizeRules(game.rules) : sanitizeRules(host.rules);
  const gameRules = gameOk ? sanitizeRules(game.rules) : rules;
  const out: Record<string, unknown> = { ...raw, host: { ...host, rules, game: game ? { ...game, rules: gameRules } : host.game } };
  if (!tableOk && !gameOk) out.rulesReset = true;
  else delete out.rulesReset;
  return out;
}

/**
 * The record as the app may use it, or null when it is damaged or stale. An online record's saved
 * verification history is optional and the table client checks it itself, so a damaged one is dropped
 * and the seat is still resumable.
 */
export function validActiveSession(raw: unknown, now: number = Date.now()): ActiveSession | null {
  if (!isObject(raw)) return null;
  if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt) || now - raw.savedAt > SAVED_TABLE_MAX_AGE_MS) return null;
  if (!isFilled(raw.token) || !isText(raw.name) || !isText(raw.avatar)) return null;
  if (raw.kind === 'local') return isSavedHost(raw.host) ? (withSaneRules(raw, raw.host as Record<string, unknown>) as unknown as ActiveSession) : null;
  if (raw.kind !== 'online') return null;
  if (!isFilled(raw.signalUrl) || !isFilled(raw.roomCode)) return null;
  if (raw.clubCode !== undefined && !isText(raw.clubCode)) return null;
  if (raw.quickMatch !== undefined && typeof raw.quickMatch !== 'boolean') return null;
  if (raw.client !== undefined && !isObject(raw.client)) {
    const { client: _damaged, ...rest } = raw;
    return rest as unknown as ActiveSession;
  }
  return raw as unknown as ActiveSession;
}

/**
 * The saved record when it is a well-formed online one that is stale (older than SAVED_TABLE_MAX_AGE_MS) and holds a
 * match: Home does not offer it, and the app keeps it in its archive instead of throwing it away.
 */
export function staleOnlineSession(raw: unknown, now: number = Date.now()): Extract<ActiveSession, { kind: 'online' }> | null {
  if (!isObject(raw) || raw.kind !== 'online' || typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt) || now - raw.savedAt <= SAVED_TABLE_MAX_AGE_MS) return null;
  const s = validActiveSession(raw, raw.savedAt);
  if (s?.kind !== 'online') return null;
  const m = s.client?.state?.matchId;
  return typeof m === 'string' && m !== '' ? s : null;
}
