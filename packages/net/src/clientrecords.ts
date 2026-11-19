/**
 * What the table client keeps as evidence, hand by hand: what it saw of each deal's ceremony
 * (`CeremonyRecord`), every frame it was shown and every move it sent (`PlayRecord`), and the
 * shape of its saved copy (`SerializedClient`); with the guards that check what the host sends
 * before the client uses it, and the match snapshots a hand starts from.
 */
import { advanceMatch, type Action, type BotSkill, type GameState, type MatchSnapshot, type RuleSet, type TableView } from '@mjm/engine';
import { SHARE_SEATS, type Commitment, type Reveal } from './fairness';
import type { Audit } from './messages';
import type { ClientState, LateTurnRecord, PassedClaim, PassedClaimRecord } from './client';

const HEX64 = /^[0-9a-f]{64}$/;

export const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

function isPlayerView(p: unknown): boolean {
  return isObject(p) && isInt(p.handCount) && p.handCount >= 0 && p.handCount <= 17 && (p.hand === undefined || Array.isArray(p.hand)) && Array.isArray(p.melds) && Array.isArray(p.flowers) && Array.isArray(p.discards);
}

/** Enough of a seat view for the client and the engine helpers to use without throwing. */
export function isView(v: unknown): v is TableView {
  return isObject(v) && isInt(v.handNumber) && Array.isArray(v.players) && v.players.length === 4 && v.players.every(isPlayerView) && Array.isArray(v.scores) && v.scores.length === 4;
}

export function isAudit(a: unknown): a is Audit {
  return isObject(a) && isInt(a.handNumber) && Array.isArray(a.commits) && Array.isArray(a.reveals) && Array.isArray(a.log) && typeof a.seed === 'string';
}

/** Five commitments, one per seat 0–4, each a SHA-256 hex digest. */
/** The next deal's deadline a `hand_over` frame carries, if it is a finite time (hosts before it was added leave it out). */
export function nextDeal(m: { deadline?: unknown }): number | null {
  return typeof m.deadline === 'number' && Number.isFinite(m.deadline) ? m.deadline : null;
}

export function isCommitSet(c: unknown): c is Commitment[] {
  if (!Array.isArray(c) || c.length !== SHARE_SEATS) return false;
  const seats = new Set<number>();
  for (const x of c) {
    if (!isObject(x) || !isInt(x.seat) || x.seat < 0 || x.seat >= SHARE_SEATS || typeof x.hash !== 'string' || !HEX64.test(x.hash)) return false;
    seats.add(x.seat);
  }
  return seats.size === SHARE_SEATS;
}

/**
 * Five reveals, one per seat 0–4: nothing extra for the seed to absorb. Whether each secret matches
 * its commitment (and is hex, as deriveSeed requires) is checked separately.
 */
export function isRevealSet(r: unknown): r is Reveal[] {
  if (!Array.isArray(r) || r.length !== SHARE_SEATS) return false;
  const seats = new Set<number>();
  for (const x of r) {
    if (!isObject(x) || !isInt(x.seat) || x.seat < 0 || x.seat >= SHARE_SEATS || typeof x.secret !== 'string') return false;
    seats.add(x.seat);
  }
  return seats.size === SHARE_SEATS;
}

/** The same commitments, whatever their order. */
export function sameCommitSet(a: Commitment[], b: Commitment[]): boolean {
  const key = (set: Commitment[]) => set.map((c) => `${c.seat}=${c.hash}`).sort().join('|');
  return key(a) === key(b);
}

export function isPassedClaimRecord(x: unknown): x is PassedClaimRecord {
  return isObject(x) && isInt(x.hand) && isInt(x.turn) && (x.claim === 'pong' || x.claim === 'chow' || x.claim === 'kong');
}

export function isLateTurnRecord(x: unknown): x is LateTurnRecord {
  return isObject(x) && isInt(x.hand) && Array.isArray(x.late) && x.late.every(isInt) && isInt(x.of) && x.of >= x.late.length;
}

/** The match's late turns with hand `h`'s replaced by what its audit found (a hand checked again counts once; one with no turn measured is left out). */
export function withLateTurns(all: LateTurnRecord[], h: number, found: { turns: number[]; of: number }): LateTurnRecord[] {
  const rest = all.filter((x) => x.hand !== h);
  return (found.of > 0 ? [...rest, { hand: h, late: found.turns.slice(), of: found.of }] : rest).sort((a, b) => a.hand - b.hand);
}

/** The match's passed claims with hand `h`'s replaced by `found` (a hand checked again counts once). */
export function withPassed(all: PassedClaimRecord[], h: number, found: Array<{ turn: number; claim: PassedClaim; late?: boolean }>): PassedClaimRecord[] {
  return [...all.filter((x) => x.hand !== h), ...found.map((f) => ({ hand: h, turn: f.turn, claim: f.claim, ...(f.late ? { late: true } : {}) }))].sort((a, b) => a.hand - b.hand || a.turn - b.turn);
}

/** What this client saw of one ceremony attempt. */
export interface AttemptRecord {
  /** The attempt's number at this hand (1 for the first), as the host announced it. */
  n: number;
  /** We sent a commitment for this attempt. */
  committed: boolean;
  /** We sent our secret in this attempt. */
  revealed: boolean;
  /** The host told us it supplied our share in this attempt. */
  stoodIn: boolean;
  /** This device's clock, and its link epoch, when it sent its secret. */
  revealedAt?: number;
  revealedEpoch?: number;
  /** The run of the app and of this device's clock `revealedAt` was read in (fixed points are compared only within one). */
  revealedRun?: string;
  revealedSeg?: number;
}

/**
 * A fixed point between this device's clock and the host's: something the host did (`now`, on its
 * clock) that it cannot have done before this device sent what it answers (`at`, on this clock).
 */
export interface ClockAnchor {
  at: number;
  now: number;
  /** The clock era the host's stamp belongs to (see `TableClient.era`). */
  era: number;
  /** The run of the app and of this device's clock `at` was read in. */
  run?: string;
  seg?: number;
  /**
   * When the frame that answered it (the deal, or the first frame that shows the move made) reached
   * this device: `fat - at` is the round trip as this device measured it, which caps what the fixed
   * point is worth (see `fixedPoint`).
   */
  fat?: number;
}

/** A time-stamped frame as the start of a stretch without a link: when it arrived here, and the host's stamp on it. */
export interface GapStart {
  at: number;
  now: number;
  epoch: number;
  era: number;
}

/** What `clockTrack` works out for each frame of a hand. */
export interface ClockTrack {
  /** The earliest moment, on the host's clock, at which the seat could be out of time for the move it owes in the frame. */
  bound: Map<SeenState, number>;
  /** The seat's time bank as tracked up to the frame (null: not known). */
  bank: Map<SeenState, number | null>;
  /** Turns at which the first frame of a new link stated a bank lower than the time away allows. */
  bankTaken: number[];
  /** The same, where only what other runs of the app measured says so (the phone's clock may have been set in between): amber. */
  bankAcross: number[];
}

/** What this client saw of one hand's ceremony. */
export interface CeremonyRecord {
  hand: number;
  /** Every attempt this client heard of, in the order it heard of them. */
  attempts: AttemptRecord[];
  /** The first attempt this client heard of was attempt 1: it watched the deal from the start. */
  fromStart: boolean;
  /** This client's link dropped (or the seat was opened elsewhere) while the deal was being agreed. */
  linkLost: boolean;
  /** The hand has been dealt (a state or result for it arrived): later link losses are not about the deal. */
  dealt: boolean;
}

/** One state frame as this client received it. */
export interface SeenState {
  /** The view's turn counter (number of actions applied so far). */
  tc: number;
  /** Link epoch: changes on every link loss, so frames of one epoch arrived over one unbroken link. */
  epoch: number;
  /** Clock era of the host's stamp (absent in records saved by older builds: 0). */
  era?: number;
  /** This device's clock when the frame arrived. */
  at: number;
  /** The host's clock when it sent the frame, if it said. */
  now?: number;
  /**
   * The earliest this frame can have arrived: earlier than `at` only when it was handled just after
   * the app did not run (it may have waited in the device), and never before its link was bound.
   */
  atLo?: number;
  /** The least arrival offset (`at - now`) seen in this frame's scope (clock era and run of this device's clock) before it, allowing for drift; null when there was none. */
  ref?: number | null;
  /**
   * The link watch's reference when it arrived: the least arrival offset of the frames of its scope
   * that arrived in the `WATCH_WINDOW_MS` before it, never less than `ref` (null when there was none).
   * A live frame is held to `LATE_MS` against it, which is what the watch bounds.
   */
  wref?: number | null;
  /**
   * The frame came over a live link: a working one, while a hand was played, with the link watch
   * checking it within `RAN_GAP_MS`, not just after a pause and not in the watch's grace after one,
   * and measuring it without a break since before the frame was `2 × CLOCK_FRAME_MS + 2 s` late
   * against `wref`. No honest frame on a live link is more than `LATE_MS` late against `wref`.
   */
  live?: boolean;
  /** The link had already brought a state or a hand's end stamped not more than `LATE_MS` late (a client's first link counts from the start). Absent, never false, in records saved by older builds. */
  working?: boolean;
  /** The run of this device's clock it arrived in (a sleep correction starts a new one). */
  seg?: number;
  /** The client instance (run of the app) it arrived in. */
  run?: string;
  /** The link it came over had already brought an earlier state, or this device revealed its share for the hand on it. */
  onLink?: boolean;
  /** This seat had a move to make in this view. */
  owes: boolean;
  deadline: number | null;
  timeBank: number;
  inBank: boolean;
  hash: string;
  /**
   * Restored from a saved record whose check figure for it still matched (`seenSum`): its figures are
   * the ones this device read, so it is judged as the run that saw it would judge it. False for a frame
   * restored without one (damaged, or saved before frames carried one); absent for a frame this run of
   * the app saw. Never saved.
   */
  kept?: boolean;
}

/** One move this client sent. */
export interface SentAction {
  /** Turn counter of the view it acted on. */
  tc: number;
  action: Action;
  epoch: number;
  /** This device's clock when it sent the move. */
  at?: number;
  /** The run of the app and of this device's clock `at` was read in. */
  run?: string;
  seg?: number;
  /** The host refused it (error code). */
  rejected?: string;
  /** The turn the host's own frames had reached when its refusal arrived. */
  refusedAt?: number;
  /** Matched to an entry of the hand's log during the audit. */
  used?: boolean;
}

/** What this client saw and did while one hand was played. */
export interface PlayRecord {
  hand: number;
  seen: SeenState[];
  sent: SentAction[];
  /** Refusals of this seat's moves: the turn the move was made on (as the host echoed it) and the turn the host's frames had reached. */
  refusals?: Array<{ tc: number; at: number }>;
  /**
   * Turn counter from which every move the log credits to this seat's player must be one this client
   * sent (it watched the hand from there with its ledger intact). Null when it cannot vouch at all.
   */
  ledgerFrom: number | null;
  /**
   * The last stamped frame this client held before this hand's first frame, when that frame came
   * over an earlier link: the hand began, or went on, while this device had no link. Null when the
   * hand's first frame followed on the same link.
   */
  before?: GapStart | null;
  /**
   * The first turn whose state the host held back on a link that stayed open: a frame arrived after
   * one it had stamped later, or a `clock` frame showed a turn whose state had not arrived.
   */
  held?: number;
}

/** About 300 years in ms: no reading of this device's clock or the host's, nor the offset between the two, is that large. */
const TIME_LIMIT_MS = 1e13;
/** An honest deadline is within the longest turn clock and time bank of its stamp (minutes), never a day off. */
const DEADLINE_LIMIT_MS = 86_400_000;
/** No honest frame reaches this device an hour later than the least arrival offset before it allows: the watch drops a link long before. */
const LATE_LIMIT_MS = 3_600_000;

const finiteTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < TIME_LIMIT_MS;

/**
 * A frame from a saved record, as this build reads it. Each frame is saved with a check figure worked
 * out from all its fields (`seenSum`): a frame whose figure still matches is the one this device read,
 * whatever its figures say, so it is marked `kept` and judged as the run that saw it would judge it.
 * Any other frame (damaged, or saved before frames carried a figure) may be wrong anywhere, and the
 * fields this build added to judge how late a frame reached this device (`atLo`, `ref`, `wref`, `live`,
 * `working`, `seg`, `run`, `onLink`) can fail a hand when they are wrong, so they are kept only when
 * they are what this build writes: the measured ones together, with a stamp, `atLo` no later than `at`,
 * `wref` no lower than `ref` (both null, or both numbers no more than an hour below the frame's own
 * offset), `live` only on a working link, booleans and a run of the clock that are what they say; and
 * the frame's stamp and deadline are readings a clock can make. Otherwise all of them are dropped, so
 * the frame reads like one from a record saved before they were kept, which the rules that use them do
 * not ask; and a stamp no clock can make is dropped with them. Such a frame is marked `kept: false`, and
 * saved again without a figure (`savedSeen`), so it never comes to pass for one read intact; it is never
 * failed for having shown the seat its turn late on a link that stayed open (`seenHere`): it makes its
 * hand amber, not red.
 */
export function cleanSeen(f: SeenState): SeenState {
  const { atLo, ref, wref, live, working, seg, run, onLink, sum, kept: _kept, ...old } = f as SeenState & { sum?: unknown };
  void _kept;
  // A frame whose check figure still matches is as this device read it: storage did not change it,
  // so it is kept whole, however far its figures lie from what an honest host sends (a deadline a
  // day before its stamp is still a cut clock).
  if (typeof run === 'string' && typeof sum === 'string' && sum === seenSum(f)) {
    const { sum: _s, kept: _k, ...clean } = f as SeenState & { sum?: unknown };
    void _s;
    void _k;
    return { ...clean, kept: true };
  }
  const now = f.now;
  const stamped = typeof now === 'number' && Number.isFinite(now) && finiteTime(f.at) && Math.abs(f.at - now) < TIME_LIMIT_MS;
  if (now !== undefined && !stamped) delete old.now;
  const own = stamped && finiteTime(atLo) ? atLo - (now as number) : null;
  const near = (x: unknown) => x === null || (finiteTime(x) && own !== null && own - x <= LATE_LIMIT_MS);
  const measured = atLo !== undefined || ref !== undefined || wref !== undefined || live !== undefined || working !== undefined || seg !== undefined;
  const ok =
    (now === undefined || stamped) &&
    (f.deadline === null || (typeof f.deadline === 'number' && Number.isFinite(f.deadline) && (!stamped || Math.abs(f.deadline - (now as number)) < DEADLINE_LIMIT_MS))) &&
    (run === undefined || typeof run === 'string') &&
    (onLink === undefined || typeof onLink === 'boolean') &&
    (!measured ||
      (own !== null &&
        (atLo as number) <= f.at &&
        near(ref) &&
        near(wref) &&
        (ref === null) === (wref === null) &&
        (ref === null || (wref as number) >= (ref as number)) &&
        typeof live === 'boolean' &&
        typeof working === 'boolean' &&
        (!live || working) &&
        isInt(seg) &&
        seg >= 0));
  // Marked as not kept, so that no figure is saved for it again (`savedSeen`): a figure worked out over
  // what storage left would vouch for it after the next restart.
  if (!ok) return { ...old, kept: false };
  const { sum: _s, kept: _k, ...clean } = f as SeenState & { sum?: unknown };
  void _s;
  void _k;
  return { ...clean, kept: false };
}

/**
 * The check figure a saved frame carries (FNV-1a over its fields in a fixed order, 32 bits as hex):
 * damage to the stored copy changes it, so a restored frame whose figure still matches is the one
 * this device read. It is no seal against someone who edits the record on purpose, which the phone's
 * own owner can always do; it tells apart storage that changed a digit.
 */
export function seenSum(f: SeenState): string {
  // Fields left undefined are not saved (JSON drops them), so they are not counted either.
  const fields = Object.entries(f).filter(([k, v]) => v !== undefined && k !== 'kept' && k !== 'sum');
  const text = JSON.stringify(fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A clock figure from the host (a deadline, a time bank) as a frame keeps it. JSON has no infinity:
 * the wire text -1e400 reads as -Infinity, and a saved record would write that as null, which reads
 * back as no deadline at all. An infinite figure is kept as the largest finite one of its sign, which
 * every check reads as it reads the infinity; NaN, which no JSON text gives, as none.
 */
export function finiteFigure(x: number): number | null {
  return Number.isNaN(x) ? null : Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, x));
}

/**
 * A frame as it is saved: with its check figure (`seenSum`), and without the mark of a restored one. A
 * frame restored without a matching figure (`kept: false`) is saved without one, so it is read back as
 * not kept however often the app restarts.
 */
export function savedSeen(f: SeenState): SeenState & { sum?: string } {
  const { kept, ...rest } = f;
  return kept === false ? rest : { ...rest, sum: seenSum(f) };
}

/** The run of the app and of this device's clock a saved time was read in, kept only when both are what this build writes (else neither: it is then compared with nothing). */
function cleanRun<T extends object>(x: T, runKey: keyof T, segKey: keyof T): T {
  const r = x[runKey] as unknown;
  const s = x[segKey] as unknown;
  if ((r === undefined && s === undefined) || (typeof r === 'string' && isInt(s) && s >= 0)) return x;
  const out = { ...x };
  delete out[runKey];
  delete out[segKey];
  return out;
}

/**
 * A hand's record from a saved copy, with every frame cleaned (`cleanSeen`) and the run of each move
 * sent kept only when it is what this build writes. Throws when the record is not one at all (its
 * frames or moves are not lists of objects): the saved copy is damaged, and the client is then built
 * from its rejoin token alone, as for any damaged copy.
 */
export function cleanPlay(p: unknown): PlayRecord {
  if (!isObject(p) || !Array.isArray(p.seen) || !Array.isArray(p.sent) || !p.seen.every(isObject) || !p.sent.every(isObject)) throw new Error('damaged hand record');
  const play = p as unknown as PlayRecord;
  return { ...play, seen: play.seen.map(cleanSeen), sent: play.sent.map((x) => cleanRun(x, 'run', 'seg')) };
}

/** A ceremony record from a saved copy, with the run of each reveal's time kept only when it is what this build writes. */
export function cleanCeremony(r: unknown): CeremonyRecord {
  if (!isObject(r) || !Array.isArray(r.attempts) || !r.attempts.every(isObject)) throw new Error('damaged ceremony record');
  const rec = r as unknown as CeremonyRecord;
  return { ...rec, attempts: rec.attempts.map((a) => cleanRun(a, 'revealedRun', 'revealedSeg')) };
}

/** Match fields a hand must start from, as the previous hand left them. */
export const CHAINED_FIELDS = ['scores', 'dealerSeat', 'dealerStreak', 'dealerRotations', 'prevailingWind'] as const;

/** Frames and sent moves remembered per hand (a hand is far shorter). */
export const MAX_SEEN = 600;
export const MAX_SENT = 300;

/** Version of `SerializedClient`; bump on any incompatible change. */
export const CLIENT_SNAPSHOT_VERSION = 2;

/** Everything a client needs to keep verifying a table after the app restarts. JSON-safe. */
export interface SerializedClient {
  version: typeof CLIENT_SNAPSHOT_VERSION;
  state: Omit<ClientState, 'chat' | 'emotes' | 'rttMs'>;
  /** The id this client gives the host as its device (`join.device`), kept across app restarts (absent in records saved by older builds). */
  device?: string;
  secret: string | null;
  commits: Commitment[] | null;
  commitHand: number | null;
  commitsHand: number | null;
  standInHand: number | null;
  joinedHand: number | null;
  firstHand: number | null;
  noHistory: boolean;
  handsEnded: number[];
  tamper: Array<[number, string[]]>;
  handStart: MatchSnapshot | null;
  records: CeremonyRecord[];
  plays: PlayRecord[];
  expected: MatchSnapshot | null;
  chainChecked: number | null;
  frozenBots: number[] | null;
  pinnedRules: RuleSet | null;
  /** Absent in snapshots written before it was kept (restored as `unknown`). */
  pinnedSkill?: BotSkill | 'unknown' | 'unpublished' | null;
  epoch: number;
  ceremonyEpoch: number;
  quietSince: number;
  openHand: number | null;
  handEpoch: number;
  matchEnded: boolean;
  atStart: boolean;
  gapHand: number | null;
  chainGap?: boolean;
  missedMoves?: boolean;
  rewinds: Array<{ hand: number; tc: number; undone: boolean }>;
  lapseHand: number | null;
  lapseDeal: boolean;
  /** What this client knows about the host's clock and its own absences (absent in records saved by older builds). */
  clock?: {
    era: number;
    /** (`run` and `seg`: where it was measured, absent in records saved by older builds; see `holdsIn`.) */
    base: { era: number; run?: string; seg?: number; anchor: number | null; minOffset: number | null };
    lastStamp: GapStart | null;
    ownAbsences: number[];
    gapVerdicts: Array<{ at: number; ok: boolean }>;
  };
}

/** The match state the hand after `prev` starts from, or null when there is none. */
export function nextHand(prev: GameState): MatchSnapshot | null {
  if (prev.phase !== 'ended' || !prev.result) return null;
  try {
    return advanceMatch(prev);
  } catch {
    return null;
  }
}

/** Reconstruct the match snapshot at the start of a hand from a view of it. */
export function snapshotFromView(v: TableView, fromEnd = false): MatchSnapshot {
  const scores = v.scores.slice();
  if (fromEnd && v.result) for (let i = 0; i < 4; i++) scores[i] -= v.result.scoreDelta[i];
  return {
    handNumber: v.handNumber,
    dealerRotations: v.dealerRotations,
    dealerSeat: v.dealerSeat,
    dealerStreak: v.dealerStreak,
    prevailingWind: v.prevailingWind,
    scores,
    matchOver: false,
  };
}
