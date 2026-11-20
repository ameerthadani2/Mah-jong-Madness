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
import type { HostMessage } from './messages';

/** A check of one field's value (the whole frame is there for the checks that depend on another field). */
type Check = (v: unknown, frame: Record<string, unknown>) => boolean;

interface Field {
  check: Check;
  /** The field may be left out; when present it must pass `check`. */
  optional?: boolean;
  /** Left out, it is optional only when this says so (the frame's other fields decide). */
  optionalIf?: (frame: Record<string, unknown>) => boolean;
}

const text: Check = (v) => typeof v === 'string';
const filled: Check = (v) => typeof v === 'string' && v.length > 0;
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
      typeof s.name === 'string' &&
      (s.peerId === null || s.peerId === undefined || typeof s.peerId === 'string') &&
      typeof s.isBot === 'boolean' &&
      typeof s.connected === 'boolean' &&
      (s.avatar === undefined || typeof s.avatar === 'string') &&
      (s.userId === undefined || typeof s.userId === 'string') &&
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
    roomCode: { check: text },
    rules: { check: object },
    seats: { check: seats },
    matchId: { check: filled },
    token: { check: filled },
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
    view: { check: view },
    hash: { check: text },
    deadline: { check: finiteOrNull },
    timeBank: { check: finite },
    inTimeBank: { check: bool },
    now: { check: finite, optional: true },
  },
  hand_over: {
    result: { check: object },
    audit: { check: (v) => isAudit(v) },
    view: { check: view },
    now: { check: finite, optional: true },
    deadline: { check: finiteOrNull, optional: true },
  },
  match_over: { scores: { check: (v) => Array.isArray(v) && v.length === 4 && v.every((x) => finite(x, {})) }, view: { check: view } },
  hand_missed: { audit: { check: (v) => isAudit(v) } },
  restored: { handNumber: { check: count }, turnCounter: { check: (v) => isInt(v) && v >= -1 } },
  error: {
    code: { check: text },
    message: { check: text },
    turnCounter: { check: (v) => isInt(v) && v >= 0, optionalIf: (f) => !(typeof f.code === 'string' && MOVE_REFUSALS.has(f.code)) },
  },
  chat: { seat: { check: seatNo }, name: { check: text }, text: { check: text } },
  emote: { seat: { check: seatNo }, emote: { check: text } },
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
  return { ok: true, frame: m as unknown as HostMessage };
}
