/**
 * What the table client keeps as evidence, hand by hand: what it saw of each deal's ceremony
 * (`CeremonyRecord`), every frame it was shown and every move it sent (`PlayRecord`), and the
 * shape of its saved copy (`SerializedClient`); with the guards that check what the host sends
 * before the client uses it, and the match snapshots a hand starts from.
 */
import { advanceMatch, type Action, type BotSkill, type GameState, type MatchSnapshot, type RuleSet, type TableView } from '@mjm/engine';
import { SHARE_SEATS, type Commitment, type Reveal } from './fairness';
import type { Audit } from './messages';
import type { ClientState, PassedClaim, PassedClaimRecord } from './client';

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

/** The match's passed claims with hand `h`'s replaced by `found` (a hand checked again counts once). */
export function withPassed(all: PassedClaimRecord[], h: number, found: Array<{ turn: number; claim: PassedClaim }>): PassedClaimRecord[] {
  return [...all.filter((x) => x.hand !== h), ...found.map((f) => ({ hand: h, turn: f.turn, claim: f.claim }))].sort((a, b) => a.hand - b.hand || a.turn - b.turn);
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
  /** The link had already brought a stamp not more than `LATE_MS` late (a client's first link counts from the start). Absent, never false, in records saved by older builds. */
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
    base: { era: number; anchor: number | null; minOffset: number | null };
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
