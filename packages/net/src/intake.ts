/**
 * What an honest host sends in each frame, field by field: the protocol's contract for the frames that reach a seat
 * (`HostMessage`, as `TableHost` writes them), in one place. The table client puts every frame through `intake` before
 * it shows, acts on or files anything of it, so what the app shows and what the client files and later checks are the
 * same figures: a frame of a known type that does not meet its contract is malformed, and the client takes nothing
 * from it (`TableClient`, which fails the hand on show over it). A frame of a type the client does not know is not
 * read at all.
 *
 * A field marked `optional` may be left out (an older host left it out, or the frame does not always carry it); when it
 * is there it must have the type below. Every other field is one an honest host always sends.
 */
import { BOT_SKILLS } from '@mjm/engine';
import { isAudit, isCommitSet, isInt, isObject, isView } from './clientrecords';
import type { Audit, HostMessage, SeatInfo } from './messages';

/** A check of one field's value (the whole frame is there for the checks that depend on another field). */
type Check = (v: unknown, frame: Record<string, unknown>) => boolean;

interface Field {
  check: Check;
  /** The field may be left out; when present it must pass `check`. */
  optional?: boolean;
  /** Left out, it is optional only when this says so (the frame's other fields decide). */
  optionalIf?: (frame: Record<string, unknown>) => boolean;
}

/**
 * The most characters each kind of the server's word may run to, and the most a frame's nested parts may take as JSON.
 * An honest host's are far shorter (names of 24 characters, room codes of 4 to 8, tokens of 32 hex digits, a hand's audit
 * of 8 to 20 thousand, a view of 3 thousand): a frame that goes past one is malformed, so nothing a server sends can make
 * the record the app saves of a table grow past what an honest table's does by more than these allow.
 */
export const BOUNDS = { name: 64, id: 128, room: 64, hash: 128, text: 1_000, view: 32_000, result: 32_000, audit: 64_000, rules: 16_000 } as const;

/** Characters of `v` as JSON (Infinity when it cannot be written as JSON). */
function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
const within = (max: number): Check => (v) => typeof v === 'string' && v.length <= max;
const filledWithin = (max: number): Check => (v) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** `check`, and no more than `max` characters as JSON. */
const sized = (max: number, check: Check): Check => (v, f) => check(v, f) && jsonLength(v) <= max;
const text: Check = within(BOUNDS.text);
const bool: Check = (v) => typeof v === 'boolean';
/** A figure a clock gives: a number, and finite (JSON has no infinity; the text 1e400 reads as one). */
const finite: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const finiteOrNull: Check = (v) => v === null || finite(v, {});
const count: Check = (v) => isInt(v) && v >= 0;
const seatNo: Check = (v) => isInt(v) && v >= 0 && v <= 3;
const object: Check = (v) => isObject(v);
/** A seat's view, with the turn counter every check of the hand is keyed by. */
const view: Check = (v) => isView(v) && isInt(v.turnCounter) && v.turnCounter >= 0;
/** The seats as `TableHost.seatInfo` lists them: four, each a seat number, a name, whether it is a bot and connected. */
const seats: Check = (v) =>
  Array.isArray(v) &&
  v.length === 4 &&
  v.every(
    (s) =>
      isObject(s) &&
      seatNo(s.seat, {}) &&
      within(BOUNDS.name)(s.name, {}) &&
      (s.peerId === null || s.peerId === undefined || within(BOUNDS.id)(s.peerId, {})) &&
      typeof s.isBot === 'boolean' &&
      typeof s.connected === 'boolean' &&
      (s.avatar === undefined || within(BOUNDS.id)(s.avatar, {})) &&
      (s.userId === undefined || within(BOUNDS.id)(s.userId, {})) &&
      (s.timeBank === undefined || finite(s.timeBank, {})) &&
      (s.left === undefined || typeof s.left === 'boolean'),
  );
const skill: Check = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(BOT_SKILLS, v);
/** Refusal codes that answer a move of a seat that holds its seat on the link: the host echoes the turn of the view the move was made on. */
export const MOVE_REFUSALS: ReadonlySet<string> = new Set(['illegal', 'not_playing', 'wrong_seat']);

/** Every frame type a seat is sent, and the fields an honest host sends in it. */
export const FRAME_FIELDS: { readonly [T in HostMessage['t']]: Readonly<Record<string, Field>> } = {
  welcome: {
    seat: { check: seatNo },
    roomCode: { check: within(BOUNDS.room) },
    rules: { check: sized(BOUNDS.rules, object) },
    seats: { check: seats },
    matchId: { check: filledWithin(BOUNDS.id) },
    token: { check: filledWithin(BOUNDS.id) },
    botSkill: { check: skill, optional: true },
    clockMs: { check: (v) => isInt(v) && v > 0, optional: true },
    elsewhere: { check: bool, optional: true },
  },
  lobby: { seats: { check: seats } },
  commit_request: { handNumber: { check: count }, attempt: { check: (v) => isInt(v) && v >= 1, optional: true } },
  commits: { handNumber: { check: count }, commits: { check: (v) => isCommitSet(v) } },
  reveal_request: { handNumber: { check: count } },
  stand_in: { handNumber: { check: count }, attempt: { check: (v) => isInt(v) && v >= 1, optional: true } },
  disconnected: {},
  state: {
    view: { check: sized(BOUNDS.view, view) },
    hash: { check: within(BOUNDS.hash) },
    deadline: { check: finiteOrNull },
    timeBank: { check: finite },
    inTimeBank: { check: bool },
    now: { check: finite, optional: true },
  },
  hand_over: {
    result: { check: sized(BOUNDS.result, object) },
    audit: { check: sized(BOUNDS.audit, (v) => isAudit(v)) },
    view: { check: sized(BOUNDS.view, view) },
    now: { check: finite, optional: true },
    deadline: { check: finiteOrNull, optional: true },
  },
  match_over: { scores: { check: (v) => Array.isArray(v) && v.length === 4 && v.every((x) => finite(x, {})) }, view: { check: sized(BOUNDS.view, view) } },
  hand_missed: { audit: { check: sized(BOUNDS.audit, (v) => isAudit(v)) } },
  restored: { handNumber: { check: count }, turnCounter: { check: (v) => isInt(v) && v >= -1 } },
  error: {
    code: { check: within(BOUNDS.id) },
    message: { check: text },
    turnCounter: { check: (v) => isInt(v) && v >= 0, optionalIf: (f) => !(typeof f.code === 'string' && MOVE_REFUSALS.has(f.code)) },
  },
  chat: { seat: { check: seatNo }, name: { check: within(BOUNDS.name) }, text: { check: text } },
  emote: { seat: { check: seatNo }, emote: { check: within(BOUNDS.id) } },
  pong: { at: { check: finite }, now: { check: finite } },
  clock: { now: { check: finite }, hand: { check: count }, tc: { check: count } },
};

/** What `intake` makes of a frame: the frame, typed; or the first field that does not meet its contract; or null for a type the client does not know. */
export type Intake = { ok: true; frame: HostMessage } | { ok: false; t: HostMessage['t']; field: string } | null;

/** Whether `m` meets its type's contract (`FRAME_FIELDS`); null when it is not a frame of a type a seat is sent. */
export function intake(m: unknown): Intake {
  if (!isObject(m) || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(FRAME_FIELDS, m.t)) return null;
  const t = m.t as HostMessage['t'];
  for (const [name, field] of Object.entries(FRAME_FIELDS[t])) {
    const v = m[name];
    if (v === undefined && (field.optional || field.optionalIf?.(m))) continue;
    if (!field.check(v, m)) return { ok: false, t, field: name };
  }
  return { ok: true, frame: kept(m as unknown as HostMessage) };
}

/** `o`'s own fields named in `keys`, and no other (anything but an object stays as it is: the checks fail it). */
function only<T>(o: T, keys: readonly string[]): T {
  if (!isObject(o)) return o;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out as T;
}
const each = <T>(v: T, f: (x: unknown) => unknown): T => (Array.isArray(v) ? (v.map(f) as T) : v);

/**
 * A hand's audit with the fields the checks read and no other, at every level: what the client files and the app saves is
 * then no larger than an honest audit, whatever else the server adds (`restartReasons`, display text no check reads, is
 * kept empty). Nothing that is there is changed: a field of the wrong type stays, and fails its check.
 */
export function keptAudit(a: Audit): Audit {
  const x = only(a, ['matchId', 'handNumber', 'seed', 'commits', 'reveals', 'log', 'finalHash', 'rngVersion', 'ceremonyAttempts', 'restarts']);
  return {
    ...x,
    commits: each(x.commits, (c) => only(c, ['seat', 'hash'])),
    reveals: each(x.reveals, (r) => only(r, ['seat', 'secret'])),
    log: each(x.log, (e) => {
      const entry = only(e as Record<string, unknown>, ['n', 'seat', 'action', 'source']);
      return isObject(entry) && isObject(entry.action) ? { ...entry, action: only(entry.action, ['type', 'tile', 'tiles']) } : entry;
    }),
    restarts: each(x.restarts, (r) => only(r, ['attempt', 'seats', 'cause'])),
    restartReasons: [],
  };
}

/** The seats of a `welcome` or `lobby` frame with the fields a seat has (`SeatInfo`) and no other. */
const keptSeats = (seats: SeatInfo[]): SeatInfo[] => seats.map((s) => only(s, ['seat', 'name', 'peerId', 'isBot', 'connected', 'avatar', 'userId', 'timeBank', 'left']));

/** A frame that meets its contract, with the parts the client files cut to the fields it reads (`keptAudit`, `keptSeats`). */
function kept(m: HostMessage): HostMessage {
  switch (m.t) {
    case 'hand_over':
    case 'hand_missed':
      return { ...m, audit: keptAudit(m.audit) };
    case 'welcome':
    case 'lobby':
      return { ...m, seats: keptSeats(m.seats) };
    default:
      return m;
  }
}
