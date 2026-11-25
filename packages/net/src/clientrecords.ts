/**
 * What the table client keeps as evidence, hand by hand: what it saw of each deal's ceremony
 * (`CeremonyRecord`), every frame it was shown and every move it sent (`PlayRecord`), and the
 * shape of its saved copy (`SerializedClient`); with the guards that check what the host sends
 * before the client uses it, and the match snapshots a hand starts from.
 */
import { advanceMatch, sha256Hex, stableStringify, type Action, type BotSkill, type GameState, type MatchSnapshot, type RuleSet, type TableView } from '@mjm/engine';
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
  /** The links (epochs) besides `revealedEpoch` it sent its secret on again, when asked again (at most `MAX_REVEAL_LINKS`). */
  revealedOn?: number[];
}

/** The most links an attempt's record keeps of those its secret went out on again (`CeremonyAttempt.revealedOn`). */
export const MAX_REVEAL_LINKS = 8;

/** This device's secret for attempt `x` went out on link `epoch`: the first time (`revealedEpoch`) or again (`revealedOn`). */
export function sharedOn(x: { revealed: boolean; revealedEpoch?: number; revealedOn?: number[] }, epoch: number): boolean {
  return x.revealed && (x.revealedEpoch === epoch || (Array.isArray(x.revealedOn) && x.revealedOn.includes(epoch)));
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
  /**
   * It arrived behind a frame of its link that the host stamped more than `ORDER_SLACK_MS` later (an answer to a ping, a
   * clock frame, a later state): an honest host's stamps never go back on a link, so the host held it back
   * (`TableClient.noteOrder`). Only a frame this run of the app saw, or one restored intact, is judged by it.
   */
  behind?: boolean;
  /** This seat had a move to make in this view. */
  owes: boolean;
  deadline: number | null;
  timeBank: number;
  inBank: boolean;
  hash: string;
  /**
   * The digest of the view the frame showed this seat (`viewDigest`): at the audit it must be the view of the replayed
   * state at its turn (`viewFor`), as the hash must be that state's. Absent in records saved by older builds.
   */
  view?: string;
  /**
   * Restored from a saved record whose check figure for it still matched (`seenSum`): its figures are
   * the ones this device read, so it is judged as the run that saw it would judge it. False for a frame
   * restored without one (damaged, or saved before frames carried one); absent for a frame this run of
   * the app saw. Never saved.
   */
  kept?: boolean;
}

/**
 * A short digest of a seat's view as it travels (its JSON form, keys in a fixed order): SHA-256, 128 bits as hex. The
 * phone keeps one for each state it is shown, since the view itself is too large to keep, and the hash the host sends
 * covers hidden tiles the phone cannot check it against: the view is what the app shows and acts on, so the audit holds
 * it to the replay (`TableClient.replayChecked`). A collision would need some 2^64 tries.
 */
export function viewDigest(v: unknown): string {
  return sha256Hex(stableStringify(JSON.parse(JSON.stringify(v ?? null)) as unknown)).slice(0, 32);
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
  /**
   * Its place among the moves this client filed, over every run of the app (from 1), when it was handed to the app's
   * journal before it went out (`TableClientOptions.writeAhead`); absent for a move filed without one.
   */
  seq?: number;
  /** The host refused it (error code). */
  rejected?: string;
  /** The turn the host's own frames had reached when its refusal arrived. */
  refusedAt?: number;
  /** Matched to an entry of the hand's log during the audit. */
  used?: boolean;
}

/** The first ping a run of the app sent in one clock era of the host and run of this device's clock (`PlayRecord.pingedFrom`). */
export interface PingStart {
  era: number;
  run: string;
  seg: number;
  at: number;
}

/**
 * The strongest fixed point of the hands a run of the app audited in one clock era and run of this device's clock
 * (`TableClient.bestAnchor`, `bestPong`): what it was worth when its hand ended, and its round trip.
 */
export interface CarriedPoint {
  era: number;
  run: string;
  seg: number;
  value: number;
  at: number;
  rtt?: number;
}

/**
 * What a run of the app knew that the frames it saw are measured by, beyond the fixed points the hand records keep: the
 * strongest fixed points it carried from the hands before (`best`, and `bestPong` for the Fair play count) and the
 * stretches in which the app did not run (`pauses`). Saved with the record, so a turn that run saw is measured after
 * an app restart as that run would have measured it (`LateScope.earlier`).
 */
export interface RunScope {
  run: string;
  best: CarriedPoint | null;
  bestPong: CarriedPoint | null;
  pauses: Array<{ from: number; to: number }>;
}

/** What this client saw and did while one hand was played. */
export interface PlayRecord {
  hand: number;
  seen: SeenState[];
  sent: SentAction[];
  /**
   * Refusals of this seat's moves: the turn the move was made on (as the host echoed it), the turn the host's frames had
   * reached when the refusal came, and the link and run of the app it came on (absent in records saved by older builds).
   */
  refusals?: Array<{ tc: number; at: number; epoch?: number; run?: string }>;
  /**
   * Fixed points from the host's answers (`pong`) to the pings this device sent while the hand was on show, or its
   * deal was being agreed: one per `PONG_WINDOW_MS` of ping time, the one with the shortest round trip, at most
   * `MAX_PONGS`. Each holds only within the run of the app that measured it (its `run`; `holdsIn`), and measures only
   * the frames that run saw. They are saved with the record, each with a check figure (`entrySum`), so the turns a
   * run saw are measured after an app restart as that run would have measured them; one whose figure does not match
   * is not read back (`cleanPlay`).
   */
  pongs?: ClockAnchor[];
  /** Pings this device sent while the hand was on show, over every run of the app (saved with the record). */
  pinged?: number;
  /**
   * The first ping each run of the app sent while the hand was on show in each clock era of the host and run of this
   * device's clock: from then on an honest table's answers bound every frame of that scope. Saved like `pongs`.
   */
  pingedFrom?: PingStart[];
  /**
   * Turn counter from which every move the log credits to this seat's player must be one this client
   * sent (it watched the hand from there with its ledger intact). Null when it cannot vouch at all.
   */
  ledgerFrom: number | null;
  /**
   * Every move this client sent in this hand was handed to the app's journal before it went out (`writeAhead`): a client
   * restored from this record and the journal holds them all, so its ledger runs on across the restart (`TableClient.load`).
   * Saved under the ledger's check figure (`ledgerSum`).
   */
  whole?: true;
  /**
   * Earlier stretches of turns, each from `from` up to but not including `to`, for which the ledger
   * still vouches after it stopped (the seat was opened on another device): this client held the seat
   * on a link until it was shown the state of turn `to`, so every move before that turn was made while
   * it held the seat, and one credited to its player must be one it sent.
   */
  vouched?: LedgerSpan[];
  /**
   * Stretches of the hand in which the server said another device held the seat (a seat-taken notice, or a welcome
   * that says so, `welcome.elsewhere`): from the latest turn this device had been shown of the hand when it was told,
   * up to but not including the first state it was shown once welcomed again (`to` absent: not yet). A move the log
   * credits to the player there that this device did not send may be one made on that device: it is not held against
   * the table, but the hand is amber (`AUDIT_CAVEATS.otherDevice`) and the end of the match is not shown as verified.
   */
  otherDevice?: OtherDeviceSpan[];
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
  /** More states came in this hand than `MAX_SEEN`, so some were not kept (`keepSeen`): the hand is amber at best. */
  overflow?: boolean;
  /**
   * False when this record was restored from storage that changed the moves sent or the refusals of them (their check
   * figure, `movesSum`, did not match): the checks of the table's answers that rest on them (a legal move refused, a
   * move left unanswered or ignored) fail nothing, they make the hand amber (`damaged`). Saved as it is, so later
   * restarts read it the same way. Absent: whole, or saved by an earlier build, which kept no figure for them.
   */
  movesKept?: false;
}

/** A stretch of turns the ledger vouches for: from `from` up to but not including `to`. */
export interface LedgerSpan {
  from: number;
  to: number;
}

/** A stretch of turns another device held the seat in, as the server said (`PlayRecord.otherDevice`); `to` absent: still open. */
export interface OtherDeviceSpan {
  from: number;
  to?: number;
}

/** The most stretches of a hand `PlayRecord.otherDevice` keeps: past it the two oldest become one (wider, never dropped). */
export const MAX_OTHER_DEVICE = 16;

/** Whether turn `n` falls in a stretch the server said another device held the seat in (`PlayRecord.otherDevice`). */
export function otherDeviceAt(play: PlayRecord, n: number): boolean {
  return (play.otherDevice ?? []).some((v) => n >= v.from && (v.to === undefined || n < v.to));
}

/** `spans` with the closed stretch from `from` up to `to` added (past the cap the two oldest become one). */
export function closedOtherDevice(spans: readonly OtherDeviceSpan[] | undefined, from: number, to: number): OtherDeviceSpan[] {
  const out = [...(spans ?? []).map((v) => ({ ...v })), { from, to: Math.max(from, to) }];
  while (out.length > MAX_OTHER_DEVICE) {
    const [a, b] = out.splice(0, 2);
    out.unshift({ from: Math.min(a.from, b.from), ...(a.to === undefined || b.to === undefined ? {} : { to: Math.max(a.to, b.to) }) });
  }
  return out;
}

/** `spans` with one opened at turn `from`, unless one is open already (the earlier start covers more); past the cap the two oldest become one. */
export function openOtherDevice(spans: readonly OtherDeviceSpan[] | undefined, from: number): OtherDeviceSpan[] {
  const out = (spans ?? []).map((v) => ({ ...v }));
  if (out.some((v) => v.to === undefined)) return out;
  out.push({ from });
  while (out.length > MAX_OTHER_DEVICE) {
    const [a, b] = out.splice(0, 2);
    out.unshift({ from: Math.min(a.from, b.from), ...(a.to === undefined || b.to === undefined ? {} : { to: Math.max(a.to, b.to) }) });
  }
  return out;
}

/** The stretches of `x` that are well formed (`PlayRecord.otherDevice` as read back), at most `MAX_OTHER_DEVICE`. */
function cleanOtherDevice(x: unknown): OtherDeviceSpan[] {
  if (!Array.isArray(x)) return [];
  let out: OtherDeviceSpan[] = [];
  for (const v of x) if (isObject(v) && isCount(v.from) && (v.to === undefined || (isCount(v.to) && v.to >= v.from))) out = [...out, { from: v.from, ...(v.to === undefined ? {} : { to: v.to as number }) }];
  // (Stored past the cap: the oldest become one, as `openOtherDevice` keeps them.)
  while (out.length > MAX_OTHER_DEVICE) {
    const [a, b] = out.splice(0, 2);
    out.unshift({ from: Math.min(a.from, b.from), ...(a.to === undefined || b.to === undefined ? {} : { to: Math.max(a.to, b.to) }) });
  }
  return out;
}

/** Whether every move the log credits to this seat's player at turn `n` must be one this client sent (`ledgerFrom`, `vouched`). */
export function ledgerVouches(play: PlayRecord, n: number): boolean {
  return (play.ledgerFrom !== null && n >= play.ledgerFrom) || (play.vouched ?? []).some((v) => n >= v.from && n < v.to);
}

/**
 * One move as this client filed it before it went out, as the app's journal keeps it (`TableClientOptions.writeAhead`).
 * The app writes it before the move is sent, so a client restored from an older record of the table and the journal
 * holds every move this device sent (`TableClient.load`).
 */
export interface JournalEntry {
  /** The move's place among the moves this client filed, over every run of the app (from 1). */
  seq: number;
  /** The match and hand it was made in. */
  matchId: string;
  hand: number;
  /** The move as filed (`SentAction`). */
  tc: number;
  action: Action;
  epoch: number;
  at: number;
  run: string;
  seg: number;
  /** The turn from which the ledger vouched for the hand when the move was filed (`PlayRecord.ledgerFrom`; null: it did not). */
  from: number | null;
  /** Its check figure (`entrySum`): an entry storage changed is not read back. */
  sum: string;
}

/** The journal entry of move `x` of hand `hand`, filed while the ledger vouched from `from`. */
export function journalEntry(matchId: string, hand: number, x: SentAction & { seq: number; at: number; run: string; seg: number }, from: number | null): JournalEntry {
  return withSum({ seq: x.seq, matchId, hand, tc: x.tc, action: x.action, epoch: x.epoch, at: x.at, run: x.run, seg: x.seg, from: from !== null && Number.isFinite(from) ? from : null });
}

/**
 * The entries of match `matchId` in what the app's journal holds, oldest first, and the last place (`seq`) of any entry;
 * `ok` is false when one of them is not what a client wrote (its check figure does not match, or a figure is not one a
 * client files), or two of them share a place: the journal then vouches for nothing.
 */
export function cleanJournal(list: readonly unknown[], matchId: string): { ok: boolean; entries: JournalEntry[]; last: number } {
  const entries: JournalEntry[] = [];
  const seqs = new Set<number>();
  let last = 0;
  for (const x of list) {
    if (!summed(x) || !isInt(x.seq) || x.seq < 1 || typeof x.matchId !== 'string' || !isCount(x.hand) || !isCount(x.tc) || !isObject(x.action) || !isCount(x.epoch) || !finiteTime(x.at) || !isRun(x.run) || !isCount(x.seg) || !(x.from === null || isCount(x.from))) return { ok: false, entries: [], last: 0 };
    if (seqs.has(x.seq)) return { ok: false, entries: [], last: 0 };
    seqs.add(x.seq);
    last = Math.max(last, x.seq);
    if (x.matchId === matchId) entries.push(x as unknown as JournalEntry);
  }
  return { ok: true, entries: entries.sort((a, b) => a.seq - b.seq), last };
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
  // (`behind` too is a measure a damaged frame may hold anywhere: left out with the rest when the check figure does not match.)
  const { atLo, ref, wref, live, working, seg, run, onLink, behind: _behind, sum, kept: _kept, ...old } = f as SeenState & { sum?: unknown };
  void _kept;
  void _behind;
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
  const { sum: _s, kept: _k, behind: _b, ...clean } = f as SeenState & { sum?: unknown };
  void _s;
  void _k;
  void _b;
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
  return fnv(JSON.stringify(fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** FNV-1a over `text`, 32 bits as hex. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The check figure a saved entry other than a frame carries (an answer to a ping, the first ping of a scope, what a
 * run of the app carried: `PlayRecord.pongs`, `pingedFrom`, `RunScope`): FNV-1a over its fields, in a fixed order,
 * nested ones included, its own `sum` left out. As with a frame's (`seenSum`), damage to the stored copy changes it.
 */
export function entrySum(x: object): string {
  const { sum: _sum, ...rest } = x as { sum?: unknown };
  void _sum;
  return fnv(stableStringify(rest));
}

/** `x` as saved: with its check figure (`entrySum`). */
export function withSum<T extends object>(x: T): T & { sum: string } {
  return { ...x, sum: entrySum(x) };
}

/** A saved entry whose check figure still matches: what this device wrote. */
const summed = (x: unknown): x is Record<string, unknown> & { sum: string } => isObject(x) && typeof x.sum === 'string' && x.sum === entrySum(x);
const isRun = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64;
const isCount = (x: unknown): x is number => isInt(x) && x >= 0;

/** An answer to a ping from a saved record, when its check figure matches and its figures are a reading of the two clocks; else null (it is not read back). */
export function cleanPong(x: unknown): ClockAnchor | null {
  if (!summed(x) || !finiteTime(x.at) || !finiteTime(x.now) || !finiteTime(x.fat) || x.fat < x.at || !isCount(x.era) || !isRun(x.run) || !isCount(x.seg)) return null;
  return { at: x.at, now: x.now, era: x.era, run: x.run, seg: x.seg, fat: x.fat };
}

/** The first ping of a scope from a saved record, on the same terms (`cleanPong`). */
export function cleanPingStart(x: unknown): PingStart | null {
  if (!summed(x) || !finiteTime(x.at) || !isCount(x.era) || !isRun(x.run) || !isCount(x.seg)) return null;
  return { era: x.era, run: x.run, seg: x.seg, at: x.at };
}

/** A carried fixed point of run `run`, as `cleanRunScope` reads it (null: none, or not one this build writes). */
function cleanCarried(x: unknown, run: string): CarriedPoint | null | undefined {
  if (x === null) return null;
  if (!isObject(x) || x.run !== run || !isCount(x.era) || !isCount(x.seg) || !finiteTime(x.value) || !finiteTime(x.at)) return undefined;
  if (x.rtt !== undefined && !(finiteTime(x.rtt) && x.rtt >= 0)) return undefined;
  return { era: x.era, run, seg: x.seg, value: x.value, at: x.at, ...(typeof x.rtt === 'number' ? { rtt: x.rtt } : {}) };
}

/** What an earlier run of the app carried (`RunScope`), from a saved record: only when its check figure matches and every figure is what this build writes; else null. */
export function cleanRunScope(x: unknown, maxPauses: number): RunScope | null {
  if (!summed(x) || !isRun(x.run) || !Array.isArray(x.pauses) || x.pauses.length > maxPauses) return null;
  const run = x.run;
  const best = cleanCarried(x.best, run);
  const bestPong = cleanCarried(x.bestPong, run);
  if (best === undefined || bestPong === undefined) return null;
  const pauses: Array<{ from: number; to: number }> = [];
  for (const p of x.pauses) {
    if (!isObject(p) || !finiteTime(p.from) || !finiteTime(p.to) || p.from > p.to) return null;
    pauses.push({ from: p.from, to: p.to });
  }
  return { run, best, bestPong, pauses };
}

/**
 * The check figure a saved hand record carries for its ledger: the moves sent and the stretches the
 * ledger still vouches for (`PlayRecord.vouched`), and for a ledger kept whole (`PlayRecord.whole`) the turn it vouches
 * from as well (`rest`). Those hold a restored record to every move it lists, so they are read back only when the figure
 * still matches (`cleanPlay`): storage that changed a move must not make the table's log look forged.
 */
export function ledgerSum(sent: unknown, vouched: unknown, rest?: Record<string, unknown>): string {
  return fnv(stableStringify({ sent, vouched, ...(rest ?? {}) }));
}

/**
 * The check figure every saved hand record carries for the moves sent and the table's refusals of them, which the checks
 * of the table's answers rest on (a move refused while legal, one left unanswered or ignored): read back with a figure
 * that does not match, they fail nothing (`PlayRecord.movesKept`), as storage that changed one must not make an honest
 * table's answers look wrong.
 */
export function movesSum(sent: unknown, refusals: unknown): string {
  return fnv(stableStringify({ sent, refusals: refusals ?? [] }));
}

/** What a whole ledger's check figure covers beyond the moves and stretches (`ledgerSum`). */
const wholeRest = (p: { ledgerFrom?: unknown; whole?: unknown }): Record<string, unknown> => ({ ledgerFrom: p.ledgerFrom, whole: p.whole });

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
 * sent kept only when it is what this build writes. The answers to pings and the first pings of each
 * scope come back only where their check figure matches (`cleanPong`, `cleanPingStart`): each measures
 * only the frames of the run of the app that made it, as it did in that run. Throws when the record is
 * not one at all (its frames or moves are not lists of objects): the saved copy is damaged, and the
 * client is then built from its rejoin token alone, as for any damaged copy.
 */
export function cleanPlay(p: unknown): PlayRecord {
  if (!isObject(p) || !Array.isArray(p.seen) || !Array.isArray(p.sent) || !p.seen.every(isObject) || !p.sent.every(isObject)) throw new Error('damaged hand record');
  const { vouched, ledgerSum: sum, whole: savedWhole, pongs: savedPongs, pinged: savedPinged, pingedFrom: savedFrom, otherDevice: savedOther, movesSum: savedMoves, movesKept: savedKept, ...play } = p as unknown as Omit<PlayRecord, 'pongs' | 'pinged' | 'pingedFrom' | 'whole' | 'otherDevice' | 'movesKept'> & { ledgerSum?: unknown; whole?: unknown; pongs?: unknown; pinged?: unknown; pingedFrom?: unknown; otherDevice?: unknown; movesSum?: unknown; movesKept?: unknown };
  // The moves sent and the refusals of them as this device wrote them, unless the figure saved with them no longer matches
  // or an earlier restore found it did not (a record an earlier build saved carries none: read as before).
  const movesKept = savedKept === false || (savedMoves !== undefined && savedMoves !== movesSum(play.sent, play.refusals)) ? false : undefined;
  // A ledger kept whole, only from a record whose moves, stretches and first vouched turn storage left as they were: one that
  // did not keep them is read as one that was not kept whole (its moves are then held to the log only from the next state).
  const whole = savedWhole === true && typeof sum === 'string' && sum === ledgerSum(play.sent, vouched, wholeRest({ ledgerFrom: play.ledgerFrom, whole: true })) && (play.ledgerFrom === null || isCount(play.ledgerFrom));
  const intact = whole || (typeof sum === 'string' && sum === ledgerSum(play.sent, vouched));
  // The stretches the ledger vouches for, only from a record whose moves and stretches storage left as they were.
  const spans = Array.isArray(vouched) && intact && vouched.every((v) => isObject(v) && isInt(v.from) && isInt(v.to) && v.from < v.to) ? vouched : null;
  const pongs = Array.isArray(savedPongs) ? savedPongs.map(cleanPong).filter((k): k is ClockAnchor => k !== null) : [];
  const pingedFrom = Array.isArray(savedFrom) ? savedFrom.map(cleanPingStart).filter((k): k is PingStart => k !== null) : [];
  // (A stretch storage made up excuses no more than a move written as the table's would be: amber, the end unverified.)
  const otherDevice = cleanOtherDevice(savedOther);
  return {
    ...play,
    seen: play.seen.map(cleanSeen),
    sent: play.sent.map((x) => cleanRun(x, 'run', 'seg')),
    ...(spans ? { vouched: spans } : {}),
    ...(whole ? { whole: true as const } : {}),
    ...(otherDevice.length > 0 ? { otherDevice } : {}),
    ...(movesKept === false ? { movesKept } : {}),
    ...(pongs.length > 0 ? { pongs } : {}),
    ...(pingedFrom.length > 0 ? { pingedFrom } : {}),
    ...(isCount(savedPinged) && savedPinged < 1e9 ? { pinged: savedPinged } : {}),
  };
}

/**
 * A hand's record as it is saved: each frame with its check figure, the moves sent and their refusals with theirs
 * (`movesSum`; none once a restore found them changed, `movesKept`), and each answer to a ping and first ping with its
 * own (`entrySum`).
 */
export function savedPlay(p: PlayRecord): PlayRecord & { ledgerSum?: string; movesSum?: string } {
  const ledgerFrom = p.ledgerFrom === Number.POSITIVE_INFINITY ? null : p.ledgerFrom;
  return {
    ...p,
    seen: p.seen.map(savedSeen),
    ledgerFrom,
    ...(p.movesKept === false ? {} : { movesSum: movesSum(p.sent, p.refusals) }),
    ...(p.whole ? { ledgerSum: ledgerSum(p.sent, p.vouched, wholeRest({ ledgerFrom, whole: true })) } : p.vouched?.length ? { ledgerSum: ledgerSum(p.sent, p.vouched) } : {}),
    ...(p.pongs ? { pongs: p.pongs.map(withSum) } : {}),
    ...(p.pingedFrom ? { pingedFrom: p.pingedFrom.map(withSum) } : {}),
  };
}

/** A ceremony record from a saved copy, with the run of each reveal's time kept only when it is what this build writes. */
export function cleanCeremony(r: unknown): CeremonyRecord {
  if (!isObject(r) || !Array.isArray(r.attempts) || !r.attempts.every(isObject)) throw new Error('damaged ceremony record');
  const rec = r as unknown as CeremonyRecord;
  return {
    ...rec,
    attempts: rec.attempts.map((a) => {
      const x = cleanRun(a, 'revealedRun', 'revealedSeg');
      // (The links its secret went out on again: whole numbers only, as many as a record keeps.)
      const on = (x as { revealedOn?: unknown }).revealedOn;
      if (on === undefined) return x;
      const { revealedOn: _drop, ...rest } = x;
      void _drop;
      const links = Array.isArray(on) ? on.filter(isInt).slice(-MAX_REVEAL_LINKS) : [];
      return links.length > 0 ? { ...rest, revealedOn: links } : rest;
    }),
  };
}

/** Match fields a hand must start from, as the previous hand left them. */
export const CHAINED_FIELDS = ['scores', 'dealerSeat', 'dealerStreak', 'dealerRotations', 'prevailingWind'] as const;

/** Frames and sent moves remembered per hand (a hand is far shorter). */
export const MAX_SEEN = 600;
export const MAX_SENT = 300;

/**
 * Keep a hand's record of states within `MAX_SEEN` once a new one has been added. An honest table sends a seat well under
 * a hundred states in a hand, so only a table that sends the same states again and again fills it, and the record is then
 * no longer whole (`overflow`: amber at best). What gives way first is a copy that adds nothing the checks read
 * (`seenToDrop`): every turn's first copy on each link, its latest and the latest end any copy claimed stay while such a
 * copy is left, and every view and hash shown stays while anything else is. A copy that disagrees with another copy of
 * its turn has already failed the hand when it came (`noteState`).
 */
export function keepSeen(play: PlayRecord): void {
  if (play.seen.length <= MAX_SEEN) return;
  play.overflow = true;
  while (play.seen.length > MAX_SEEN) play.seen.splice(seenToDrop(play.seen), 1);
}

/** The end a state claims for the move it shows the seat owing, on the host's clock (minus infinity with no deadline). */
const endOf = (f: SeenState): number => (f.deadline === null ? Number.NEGATIVE_INFINITY : f.inBank ? f.deadline : f.deadline + f.timeBank * 1000);

/**
 * Which state a record that ran over gives up (`keepSeen`); never the one just added. First the oldest copy of a turn
 * shown again over the same link (the same turn, link and clock era) that is neither the first copy (which showed the
 * seat the turn, and whose arrival times it) nor the latest (the last frame before what came next), shows the same hash
 * and view as the first, and is not the only copy claiming the latest end any copy claimed (the end the app counts to
 * binds the table, `streakEnd`). Else the oldest state whose turn, hash and view another state also holds. Else the oldest.
 */
function seenToDrop(seen: SeenState[]): number {
  const newest = seen.length - 1;
  const group = (f: SeenState) => `${f.tc}|${f.epoch}|${f.era ?? 0}`;
  const first = new Map<string, SeenState>();
  const lastAt = new Map<string, number>();
  const ends = new Map<string, { max: number; n: number }>();
  seen.forEach((f, i) => {
    const k = group(f);
    if (!first.has(k)) first.set(k, f);
    lastAt.set(k, i);
    const e = endOf(f);
    const g = ends.get(k);
    if (!g || e > g.max) ends.set(k, { max: e, n: 1 });
    else if (e === g.max) g.n++;
  });
  for (let i = 0; i < newest; i++) {
    const f = seen[i];
    const k = group(f);
    const head = first.get(k) as SeenState;
    if (head === f || lastAt.get(k) === i || f.hash !== head.hash || f.view !== head.view) continue;
    const g = ends.get(k) as { max: number; n: number };
    if (endOf(f) === g.max && g.n === 1) continue;
    return i;
  }
  const shows = (f: SeenState) => `${f.tc}|${f.hash}|${f.view ?? ''}`;
  const held = new Map<string, number>();
  for (const f of seen) held.set(shows(f), (held.get(shows(f)) ?? 0) + 1);
  for (let i = 0; i < newest; i++) if ((held.get(shows(seen[i])) ?? 0) > 1) return i;
  return 0;
}

/** Version of `SerializedClient`; bump on any incompatible change. */
export const CLIENT_SNAPSHOT_VERSION = 2;

/** Everything a client needs to keep verifying a table after the app restarts. JSON-safe. */
export interface SerializedClient {
  version: typeof CLIENT_SNAPSHOT_VERSION;
  state: Omit<ClientState, 'chat' | 'emotes' | 'rttMs'>;
  /** The id this client gives the host as its device (`join.device`), kept across app restarts (absent in records saved by older builds). */
  device?: string;
  /** The table's count of the seat's moves from one device to another, as the last welcome this client took said it (`welcome.handovers`). */
  handovers?: number;
  secret: string | null;
  /** The set of the hand last published (`commitsHand`), as records saved before the sets were kept per hand hold it. */
  commits: Commitment[] | null;
  commitHand: number | null;
  /** The hand the client was on when a later hand's deal frame reached it (`TableClient.aheadOf`; absent in older records). */
  aheadOf?: number | null;
  commitsHand: number | null;
  /** The commitment set of each of the last few hands (absent in records saved by older builds: `commits` then). */
  commitSets?: Array<{ hand: number; commits: Commitment[] }>;
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
  /** The hand after one whose record did not replay (`TableClient.brokenHand`; absent in records saved by older builds). */
  brokenHand?: number | null;
  chainGap?: boolean;
  missedMoves?: boolean;
  rewinds: Array<{ hand: number; tc: number; undone: boolean }>;
  /** The hand on show when a restart notice last began a clock era (absent in records saved by older builds). */
  eraHand?: number | null;
  lapseHand: number | null;
  lapseDeal: boolean;
  /**
   * Where in `state.audits` the last audit is (`state.lastAudit` is then saved as null, so the record holds each audit once;
   * absent in records saved by older builds, which carry it whole).
   */
  lastAuditAt?: number;
  /**
   * The place (`SentAction.seq`) of the last move this client had filed when it wrote the record: the journal entries up to
   * it are in the record (absent in records saved by older builds, and by a client without a journal).
   */
  sentSeq?: number;
  /**
   * The server said another device held the seat, and this client had not been shown the hand since it was welcomed back
   * (`PlayRecord.otherDevice`; absent: no such stretch is open, and in records saved by older builds).
   */
  elsewhereOpen?: true;
  /** What this client knows about the host's clock and its own absences (absent in records saved by older builds). */
  clock?: {
    era: number;
    /** (`run` and `seg`: where it was measured, absent in records saved by older builds; see `holdsIn`.) */
    base: { era: number; run?: string; seg?: number; anchor: number | null; minOffset: number | null };
    lastStamp: GapStart | null;
    ownAbsences: number[];
    gapVerdicts: Array<{ at: number; ok: boolean }>;
    /** What each run of the app whose frames the record holds carried (`RunScope`), each with its check figure (absent in records saved by older builds). */
    runs?: Array<RunScope & { sum?: string }>;
  };
}

/**
 * The most characters of JSON the record of a table may take when the app saves it. An honest table's largest, over the
 * honest battery, is under 200 thousand; the platforms let one value take about 5 million (a browser's storage for the
 * whole site, Android's for the whole app), so the record, the records the app keeps of tables that left Home and every
 * other saved value fit together.
 */
export const RECORD_MAX_CHARS = 512_000;

/** Characters of `v` as JSON. */
function jsonChars(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0;
}

/**
 * `rec` as the app saves it: the last audit once, as the entry of the list it is (`lastAuditAt`), and within
 * `RECORD_MAX_CHARS`. Every part of the record is held to its own cap as it grows, and the frames it comes from to the
 * protocol's bounds (`intake`), but a server that sends many hands' records at the largest size the bounds allow, or
 * floods states, could still make it too large to be written. Then the record gives up, oldest first, audits that are
 * not red (never the last two), the records of hands that ended (`ended`), and red audits (never the last two; the app
 * keeps a list of the red hands apart, so a red verdict is not lost with them). The hand under way is never given up.
 */
export function fitRecord(rec: SerializedClient, ended: (hand: number) => boolean): SerializedClient {
  const last = rec.state.lastAudit;
  let audits = rec.state.audits;
  let plays = rec.plays;
  const build = (): SerializedClient => {
    let at = -1;
    if (last) for (let i = audits.length - 1; i >= 0 && at < 0; i--) if (audits[i].audit === last) at = i;
    const { lastAuditAt: _l, ...rest } = rec;
    void _l;
    return { ...rest, state: { ...rec.state, audits, lastAudit: at >= 0 ? null : last }, plays, ...(at >= 0 ? { lastAuditAt: at } : {}) };
  };
  let out = build();
  let size = jsonChars(out);
  const giveUp = (): boolean => {
    const keep = audits.length - 2;
    let i = audits.findIndex((a, k) => k < keep && a.status !== 'failed');
    if (i >= 0) {
      audits = audits.filter((_, k) => k !== i);
      return true;
    }
    i = plays.findIndex((p) => ended(p.hand));
    if (i >= 0) {
      plays = plays.filter((_, k) => k !== i);
      return true;
    }
    if (keep > 0) {
      audits = audits.slice(1);
      return true;
    }
    return false;
  };
  while (size > RECORD_MAX_CHARS && giveUp()) {
    out = build();
    size = jsonChars(out);
  }
  return out;
}

/** The last audit of a saved record's state: its own field, or the entry of its list that `lastAuditAt` names. */
export function lastAuditOf(st: { lastAudit?: unknown; audits?: unknown }, at: unknown): ClientState['lastAudit'] {
  if (isObject(st.lastAudit)) return st.lastAudit as unknown as ClientState['lastAudit'];
  const list = Array.isArray(st.audits) ? st.audits : [];
  const entry = isInt(at) && at >= 0 && at < list.length ? list[at] : null;
  return isObject(entry) && isAudit(entry.audit) ? entry.audit : null;
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
