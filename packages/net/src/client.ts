/**
 * Table client: joins a host, takes part in the seed ceremony, sends actions,
 * keeps the latest seat view, and verifies every hand's audit.
 *
 * The client never takes the host's word for how the ceremony went: it records
 * what it saw itself (which hands it was asked to commit to, which attempts,
 * whether it was stood in, whether the commitments arrived before it revealed,
 * whether it revealed in each attempt, whether its link dropped, and where the
 * previous hand left the match) and checks the audit against that record. It
 * also binds the action log to its own play: every move it sent, every state
 * hash it was shown, and every move the table made for it.
 *
 * One client lives as long as the player sits at the table: a reconnect rebinds
 * it to the new link (`rebind`), and an app restart restores it from storage
 * (`serialize` / `TableClient.restore`), so the evidence survives both.
 *
 * Beside it: `clientrecords.ts` (the records it keeps and their saved form, and the guards on what
 * the host sends), `clientclock.ts` (its clock and what it knows of the host's) and `clientmoves.ts`
 * (the table's published move rule and the check of when the table may play this seat). Every
 * sentence a check can write stays in this file, with `AUDIT_CAVEATS` and `AUDIT_FAILURES`.
 */
import {
  dealFromSnapshot,
  hashState,
  legalActions,
  matchSnapshot,
  newGame,
  sanitizeRules,
  stableStringify,
  viewToState,
  WALL_RNG_VERSION,
  applyAction,
  type Action,
  type BotSkill,
  type GameState,
  type HandResult,
  type LoggedAction,
  type MatchSnapshot,
  type RuleSet,
  type TableView,
} from '@mjm/engine';
import { commitFor, deriveSeed, makeSecret, verifyReveals, type Commitment } from './fairness';
import { randomHex } from './sha256';
import type { Link } from './host';
import { CLOCK_FRAME_MS, RESTART_CAUSES, type Audit, type ClientMessage, type HostMessage, type SeatInfo } from './messages';
import { isFrame, type Transport, type Unsubscribe } from './transport';
import { BANK_ROUND_MS, clientClock, type ClockBase, DRIFT_CAP_MS, DRIFT_RATE, foldClock, LATE_MS, LINK_PAUSE_MS, MAX_PAUSES, MAX_PING_SCOPES, MAX_PINGS, MAX_RUN_SCOPES, MAX_PONGS, NO_ANSWER_PINGS, ORDER_SLACK_MS, ownClockFrom, PAUSE_GRACE_MS, PONG_WINDOW_MS, RAN_GAP_MS, RTT_PUBLISH_MS, SILENT_ANSWER_MS, STEADY_SLACK_MS, WATCH_WINDOW_MS, type OwnClock, type TableClientOptions } from './clientclock';
import { armedLate, clockTrack, firstSend, fixedPoint, flightAllowance, heldLive, isBotSkill, judgeTableMove, lateAnchor, lateBy, lateCountMs, lateLimitMs, lateRef, legalFor, ownRun, pausedIn, restartInRun, sameActionSafe, scopeOf, seatRun, seenHere, streakEnd, tableRule, turnLateBy, unanswered, unstamped, type LateScope, type MoveJudge, type PongClock } from './clientmoves';
import {
  CHAINED_FIELDS,
  cleanCeremony,
  cleanPlay,
  cleanRunScope,
  CLIENT_SNAPSHOT_VERSION,
  isAudit,
  finiteFigure,
  isCommitSet,
  isInt,
  isLateTurnRecord,
  isObject,
  isPassedClaimRecord,
  isRevealSet,
  isView,
  keepSeen,
  ledgerVouches,
  MAX_SENT,
  nextDeal,
  nextHand,
  sameCommitSet,
  savedPlay,
  snapshotFromView,
  withSum,
  withLateTurns,
  withPassed,
  type AttemptRecord,
  type CeremonyRecord,
  type ClockAnchor,
  type GapStart,
  type PlayRecord,
  type RunScope,
  type SeenState,
  type SerializedClient,
} from './clientrecords';

export { clientClock, SILENT_ANSWER_MS, steadyClock, type OwnClock, type TableClientOptions } from './clientclock';
export { tableRule } from './clientmoves';
export { CLIENT_SNAPSHOT_VERSION, type SerializedClient } from './clientrecords';

/**
 * `ok`: this device watched the whole deal in one attempt, its own share protected the seed, and
 * every check passed.
 * `partial`: every check on the log and the published shares passed, but the server could have
 * picked this deal: the host stood in for this seat, the seat joined mid-hand, the deal was
 * restarted, or this device lost its link while the deal was being agreed.
 * `failed`: a check failed or the host misbehaved during the hand.
 */
export type AuditStatus = 'ok' | 'partial' | 'failed' | 'unverified';

export interface AuditCheck {
  status: AuditStatus;
  failures: string[];
  caveats: string[];
}

/** Why a hand verified only as `partial`. The app translates these by key (see `caveatKey`). */
export const AUDIT_CAVEATS = {
  standIn: "The host supplied this seat's share",
  joined: 'Joined during this hand; log verified, share not used',
  restarted: 'The deal was restarted, so the server could have picked it',
  linkLost: 'This seat lost its connection while the deal was being agreed',
  missedAttempts: 'This seat did not see every attempt at the deal',
  away: 'This device was away when the hand ended; its record was checked afterwards, the play was not watched',
  gap: 'This device missed the hands before this one and was not shown their records, so the scores it started from could not be checked',
  serverRestart: 'The server restarted during this hand and some turns were played again',
  appRestart: 'This app was restarted around this deal, so it cannot vouch for all of it',
  tableMoved: 'The table played for this seat while its connection was down',
  // The same, on a turn whose state reached this device too late for its stamp to be believed (the
  // drop judgement's `downLate`), whether or not the link dropped: a delay looks the same as a drop.
  tableMovedLate: 'The table played for this seat on a turn that reached this device late, so it did not see that turn in time',
  // The claim the timeout rule passed for this seat while its link was down. An honest table does
  // this to a player who dropped; a server that cuts the link whenever the player could claim does
  // it every time, and the count over the match (`claimsPassedAway`) shows the pattern.
  passedPong: 'The table passed up a Pong this seat could make while its connection was down',
  passedChow: 'The table passed up a Chow this seat could make while its connection was down',
  passedKong: 'The table passed up a Kong this seat could make while its connection was down',
  // The same, on a turn that reached this device late (counted with `late` in `claimsPassedAway`).
  passedPongLate: 'The table passed up a Pong this seat could make on a turn that reached this device late',
  passedChowLate: 'The table passed up a Chow this seat could make on a turn that reached this device late',
  passedKongLate: 'The table passed up a Kong this seat could make on a turn that reached this device late',
  restartClock: 'The server restarted and then played for this seat before this device could check the time it had left',
  // The table's move for this seat is early only by what this device measured of the server's clock in
  // another run of the app, or of its clock (`across`): its own clock may have been set in between.
  appClock: "This device's clock was started afresh or set during this hand (the app restarted, or the phone's clock was changed), and the server's clock then no longer agreed with it as it had before, so this device cannot be sure the seat's time had run out when the table played for it",
  lateShown: "This seat's turn reached this device late, or after its connection had been down for much of it, so this device cannot vouch that it saw all of that turn",
  skillUnknown: 'This device restored the match from a save that did not keep how strong the table said its bots are, so the moves the table made for bots and for seats out of time were not checked',
  // Storage changed part of the saved record of the hand (a state whose check figure did not match when the
  // app restarted, `cleanSeen`): the checks that would rest on it are not held against the table.
  damaged: 'This app restarted with a damaged record of this hand, so the checks that rest on the damaged part were not made',
  // The table sent more states in this hand than the record keeps (`keepSeen`): no honest table comes near it.
  overflow: 'The table sent this device far more states in this hand than it keeps, so it could not keep them all and cannot vouch for the whole hand',
  // The table played for this seat over a legal move it sent with more of the turn's clock left than the
  // best round trip of the hand and `FLIGHT_SLACK_MS` explain losing on the way (`flightAllowance`).
  inFlight: 'The table played for this seat while a move it had sent in good time was still on its way',
  // This device pinged the table through the hand and no answer came back: nothing tied the table's clock to its own.
  noAnswer: "The table did not answer this device's timing checks during this hand",
} as const;

export type AuditCaveat = keyof typeof AUDIT_CAVEATS;

/** A claim on another seat's discard that the table can pass for a seat whose link is down. */
export type PassedClaim = 'pong' | 'chow' | 'kong';

/**
 * One hand's turns of this seat whose state reached this device late enough to be counted on the
 * Fair play screen (`lateCountMs`), out of the turns of the seat it could measure in that hand.
 */
export interface LateTurnRecord {
  hand: number;
  /** The turn counters of the seat's moves whose turn reached this device late. */
  late: number[];
  /** How many of the seat's turns in the hand this device could measure. */
  of: number;
}

/** One claim the table passed for this seat while its link was down: the hand and turn, and which claim. */
export interface PassedClaimRecord {
  hand: number;
  turn: number;
  claim: PassedClaim;
  /** On a turn that reached this device late (`downLate`), whether or not its link dropped. */
  late?: boolean;
}

const PASSED_CAVEAT: Record<PassedClaim, string> = { pong: AUDIT_CAVEATS.passedPong, chow: AUDIT_CAVEATS.passedChow, kong: AUDIT_CAVEATS.passedKong };
const PASSED_LATE_CAVEAT: Record<PassedClaim, string> = { pong: AUDIT_CAVEATS.passedPongLate, chow: AUDIT_CAVEATS.passedChowLate, kong: AUDIT_CAVEATS.passedKongLate };

/** The key of a caveat text produced by this client, or null for any other text. */
export function caveatKey(text: string): AuditCaveat | null {
  for (const [k, v] of Object.entries(AUDIT_CAVEATS)) if (v === text) return k as AuditCaveat;
  return null;
}

/**
 * Why a hand failed its checks, or what the host did that it must not. The sentences written in
 * the checks below stay as they are (tests and logs read them); the app shows each one in the
 * player's language by its key (see `failureKey`). An entry is the exact sentence, or a pattern
 * for a sentence that carries a number or a name, whose named groups are the values it carries.
 */
export const AUDIT_FAILURES = {
  // What the host did between hands and around the table.
  dealtPlayedHand: 'Host asked to deal a hand that was already played',
  startedBeforeEnd: 'Host started another hand before the one in progress had ended',
  dealtAfterMatch: 'Host dealt another hand after the match was over',
  dealtOutOfTurn: 'Host dealt a hand out of turn',
  matchStartChanged: /^The match started with (?<fields>[A-Za-z, ]+) different from a new match$/,
  handStartChanged: /^Hand started with (?<fields>[A-Za-z, ]+) different from where the previous hand left them$/,
  botsChanged: 'Host changed which seats are bots during the match',
  skillChanged: 'Host changed how strong its bots are during the match',
  skillUnpublished: 'The table did not say how strong its bots are, yet it made moves for bots or for seats out of time, so none of them could be checked',
  movedMatch: 'Host moved this seat into a different match mid-match',
  movedSeat: 'Host moved this seat to another seat mid-match',
  rulesChanged: 'Host changed the rules mid-match',
  redealt: 'Host re-dealt a hand in progress',
  wentBack: 'Host went back to a hand that had already ended',
  resentOtherMatch: 'Host re-sent a hand under a different match id',
  auditChanged: 'Host sent a different audit for a hand it had already ended',
  resultChanged: 'Host re-sent a different result for a hand it had already ended',
  endUnsupported: 'Host announced the end of the match, which the hands this device verified do not support',
  twoStates: /^Host showed two different states for turn (?<turn>-?\d+)$/,
  restartedTwice: 'Host said it restarted this hand more than once',
  // A frame naming a hand or turn an honest host would not name at that point: a clock frame for a turn other than the
  // one whose state it last sent the link, or a deal's frame for a hand other than the one being dealt.
  strayFrame: 'Host sent a frame about a hand or turn this device was not on',
  // A restart notice anywhere but on a new link, right after its welcome and the records of the hands missed: a restart
  // drops every link, and the restored table says so as its first word when each device joins again.
  restartMidLink: 'Host said it restarted, but not as its first word when this device joined again',
  // The hands this device was away for.
  missedOtherMatch: 'Host sent the record of a hand from a different match',
  missedBroken: 'The record of the hands this device missed does not follow from the last hand it verified',
  missedWhileConnected: 'Host reported a hand as missed although this device was connected throughout',
  awayHandFailed: /^The record of hand (?<hand>-?\d+), played while this device was away, failed its checks$/,
  // Agreeing the deal.
  skippedFirstAttempts: /^Host never asked this seat to commit to attempts 1–(?<last>-?\d+) of this hand$/,
  attemptTwice: /^Host ran attempt (?<n>-?\d+) of this hand's deal twice$/,
  skippedAttempt: /^Host never asked this seat to commit to attempt (?<n>-?\d+) of this hand$/,
  commitsMalformed: 'Host published a malformed set of commitments',
  commitsChanged: 'Host changed the commitments after publishing them',
  myCommitDiffers: 'Host published a different commitment for my seat',
  earlyReveal: 'Host asked for my secret before publishing all commitments',
  neverAskedToCommit: 'Host never asked this seat to commit',
  commitsNeverArrived: 'The commitments for this hand never arrived',
  // The record of a hand.
  noContext: 'No match context',
  auditMalformed: 'The audit is malformed',
  auditOtherMatch: 'The audit is for a different match than the one this seat is in',
  myCommitAltered: 'Host altered my commitment',
  mySecretAltered: 'Host altered my secret',
  commitChangedAfter: /^Commitment for seat (?<seat>-?\d+) changed after the fact$/,
  commitCount: 'Audit must list exactly one commitment for each of seats 0–4',
  revealCount: 'Audit must list exactly one secret for each of seats 0–4',
  revealsMismatch: /^Reveals do not match commitments for seats (?<seats>[\d, ]*)$/,
  seedMismatch: 'Seed was not derived from the revealed secrets',
  unknownShuffle: /^Unknown shuffle construction (?<version>[\s\S]*)$/,
  // Replaying the hand.
  replayMismatch: 'Replaying the action log does not reproduce the final state',
  replayFailed: /^Replay failed: (?<detail>[\s\S]*)$/,
  // Every check of this seat's own moves is keyed by the turn number each entry of the log carries: an entry numbered
  // other than the turn the replay is at would escape them.
  logTurn: /^The log numbers the move made at turn (?<turn>-?\d+) as another turn$/,
  resultDiffers: 'Announced result differs from the replayed hand',
  scoresDiffer: 'Announced scores differ from the replayed hand',
  myHandDiffers: 'My final hand differs from the replay',
  shownStateMissing: /^The state this seat was shown at turn (?<turn>-?\d+) is not in the replay$/,
  // This seat's own moves and the moves made for it.
  legalMoveRefused: /^The host refused a legal move this seat made \(turn (?<turn>[^)]*)\)$/,
  moveChanged: /^The log changed a move this seat made \(turn (?<turn>[^)]*)\)$/,
  moveInvented: /^The log shows a move this seat never made \(turn (?<turn>[^)]*)\)$/,
  passedUpWin: /^The table played for this seat and passed up its win \(turn (?<turn>[^)]*)\)$/,
  playedEarly: /^The table played for this seat while it was connected and its clock had not run out \(turn (?<turn>[^)]*)\)$/,
  heldFrame: /^The host held back its frames on a link that stayed open, then played for this seat \(turn (?<turn>[^)]*)\)$/,
  lateTurn: /^The host showed this seat its turn late, on a link that stayed open \(turn (?<turn>[^)]*)\)$/,
  playedWhileDown: /^The table played for this seat while its connection was down, before its clock could have run out \(turn (?<turn>[^)]*)\)$/,
  bankTaken: /^The table took time from this seat's time bank while its connection was down \(turn (?<turn>[^)]*)\)$/,
  moveIgnored: /^The table ignored a move this seat sent in good time and played its own instead \(turn (?<turn>[^)]*)\)$/,
  tableMoveDiffers: /^The table played for this seat a move other than the one its published rule gives \(turn (?<turn>[^)]*)\)$/,
  // The moves the table made for the other seats.
  botMoveDiffers: /^The bot in seat (?<seat>-?\d+) played a move other than the one its published rule gives \(turn (?<turn>[^)]*)\)$/,
  seatMoveDiffers: /^The table played for seat (?<seat>-?\d+) a move that neither of its published rules gives \(turn (?<turn>[^)]*)\)$/,
  // The account of how many times the deal was tried, and why.
  attemptsMissing: 'Audit does not say how many ceremonies were run',
  restartsMissing: 'Audit does not list the ceremony restarts',
  restartCount: /^Audit lists (?<restarts>-?\d+) restarts for (?<attempts>-?\d+) ceremony attempts$/,
  tooManyAttempts: /^(?<attempts>-?\d+) ceremony attempts is more than (?<most>-?\d+), the most an honest table with (?<humans>-?\d+) human seats needs$/,
  restartMalformed: /^Restart (?<n>-?\d+) is malformed$/,
  restartBadSeat: /^Restart (?<n>-?\d+) names seat (?<seat>[\s\S]*), which is not a player seat$/,
  restartBlamesBot: /^Restart (?<n>-?\d+) blames seat (?<seat>-?\d+), which is a bot$/,
  restartBlamesAgain: /^Restart (?<n>-?\d+) blames seat (?<seat>-?\d+) again after the host had stood it in$/,
  attemptsBelowSeen: /^Audit reports (?<attempts>-?\d+) ceremony attempts but this seat was asked to commit in attempt (?<seen>-?\d+)$/,
  attemptsNotSeen: /^Audit reports (?<attempts>-?\d+) ceremony attempts but this seat was asked to commit (?<times>-?\d+) times$/,
  restartBlamesNoOne: /^Restart (?<n>-?\d+) blames no seat, yet this seat saw every attempt without losing its link$/,
  restartBlamesMeStoodIn: /^Restart (?<n>-?\d+) blames this seat although the host had stood it in$/,
  restartBlamesMeRevealed: /^Restart (?<n>-?\d+) blames this seat although it revealed, and the host then asked it for a new share instead of standing it in$/,
  blamedButUsed: 'The audit blames this seat for a restart, yet the deal used a new share from it instead of standing it in',
} as const satisfies Record<string, string | RegExp>;

export type AuditFailure = keyof typeof AUDIT_FAILURES;

/**
 * The key of a failure text produced by this client and the values it carries (a turn, a seat, a
 * count: always as text), or null for any other text.
 */
export function auditFailure(text: string): { key: AuditFailure; params: Record<string, string> } | null {
  for (const [k, v] of Object.entries(AUDIT_FAILURES) as Array<[AuditFailure, string | RegExp]>) {
    if (typeof v === 'string') {
      if (v === text) return { key: k, params: {} };
      continue;
    }
    const m = v.exec(text);
    if (m) return { key: k, params: { ...(m.groups ?? {}) } };
  }
  return null;
}

/** The key of a failure text produced by this client, or null for any other text. */
export function failureKey(text: string): AuditFailure | null {
  return auditFailure(text)?.key ?? null;
}

export interface ChatLine {
  seat: number;
  name: string;
  text: string;
  at: number;
}

export interface ClientState {
  connected: boolean;
  seat: number | null;
  roomCode: string | null;
  matchId: string | null;
  rules: RuleSet | null;
  seats: SeatInfo[];
  view: TableView | null;
  stateHash: string | null;
  deadline: number | null;
  /**
   * Between hands: when the host deals the next hand on its own, on the host's clock like `deadline`
   * (null when the host did not say, or waits because nobody human is at the table).
   */
  intermissionDeadline: number | null;
  ceremony: 'idle' | 'committed' | 'revealed';
  lastResult: HandResult | null;
  lastAudit: Audit | null;
  auditStatus: AuditStatus;
  auditFailures: string[];
  /** Why the last hand verified only as `partial`. */
  auditCaveats: string[];
  matchOver: boolean;
  finalScores: number[] | null;
  /**
   * The end of the match and `finalScores` follow from the hands this device verified. False while
   * the match is on, and also when it ended but this device holds no chain of hands to check the
   * end against (it lost its record, or missed hands whose records it was never shown).
   */
  matchEndVerified: boolean;
  /**
   * A hand of this match failed its checks (red, or the table did something during the match that it must not):
   * this device caught the table out, so the final scores, reached through that hand, are the table's word and are
   * not shown as verified (`matchEndVerified` stays false).
   */
  matchFailed: boolean;
  /** Rejoin token from the host; persist it to resume after a crash. */
  token: string | null;
  /** Remaining time bank (seconds) and whether the clock is currently eating into it. */
  timeBank: number;
  inTimeBank: boolean;
  /** Audited hands of this match (the last MAX_AUDITS), newest last. */
  audits: Array<{ audit: Audit; status: AuditStatus; failures: string[]; caveats: string[] }>;
  /**
   * Every Pong, Chow or Kong the table passed for this seat while its link was down, or on a turn
   * that reached this device late (`late`), over this match (cleared when a new match starts). One
   * or two are what a dropped or slow connection costs; many, at the moments this seat could claim,
   * are the pattern of a server that cuts the link, or holds the turn back, to take them away.
   */
  claimsPassedAway: PassedClaimRecord[];
  /**
   * Hand by hand over this match (cleared when a new match starts), the turns of this seat that
   * reached this device later than half the turn clock (`lateCountMs`), out of those it could
   * measure. Never a verdict: a stall or a slow connection costs some, and the audit fails or
   * marks a hand only past 17 s. A count that rises with nearly every turn is what a server that
   * shows every turn late, inside those 17 s, leaves at the fast speeds, where the table then plays
   * the turns before the player sees them.
   */
  turnsShownLate: LateTurnRecord[];
  chat: ChatLine[];
  emotes: Array<{ seat: number; emote: string; at: number }>;
  lastError: string | null;
  /** The code of the table's last refusal (`already_seated`, `not_controller`, …), when it sent one. */
  lastErrorCode: string | null;
  rttMs: number | null;
  /** The host used a stand-in random share for us this hand (we committed too late, or were away). */
  standIn: boolean;
  /** The link to the host dropped; the session reconnects (or the player resumes from Home with the saved token). */
  disconnected: boolean;
  /** The seat was opened on another device: this one must not take it back. */
  kicked: boolean;
}

export function transportLink(transport: Transport, hostPeerId: string): Link {
  return {
    send: (msg) => transport.send(hostPeerId, msg),
    onMessage: (cb) => transport.onMessage((from, msg) => from === hostPeerId && cb(msg as HostMessage)),
    close: () => transport.close(),
    onClose: (cb) => transport.onClose?.(cb) ?? (() => undefined),
  };
}

/** Audits kept (and saved) per table. */
export const MAX_AUDITS = 50;
/** Hands whose play and ceremony records are kept: the one on show and the ones just before (see `trimHands`). */
const MAX_HAND_RECORDS = 3;
/** Hands whose flags are kept until they are audited (see `flag`). */
const MAX_FLAGGED_HANDS = 12;
/** Restart notices kept (see `noteRestore`): at most one begins a clock era per hand on show. */
const MAX_REWINDS = 4;
/** Frames that may come in a link's opening, between its `welcome` and a restart notice (`TableClient.opening`). */
const OPENING_FRAMES: ReadonlySet<string> = new Set(['hand_missed', 'lobby', 'pong', 'chat', 'emote', 'restored']);
/** A move sent this long before the table's own move for the same turn arrived, time the app did not run left out, was not lost to a slow network. */
export const MOVE_SLACK_MS = 30_000;
/** Marks, among the problems of a replay, a move the table made for this seat that is judged once the replay is done. */
const JUDGE_LATER = '\u0000table move ';

export class TableClient {
  state: ClientState = {
    connected: false,
    seat: null,
    roomCode: null,
    matchId: null,
    rules: null,
    seats: [],
    view: null,
    stateHash: null,
    deadline: null,
    intermissionDeadline: null,
    ceremony: 'idle',
    lastResult: null,
    lastAudit: null,
    auditStatus: 'unverified',
    auditFailures: [],
    auditCaveats: [],
    matchOver: false,
    finalScores: null,
    matchEndVerified: false,
    matchFailed: false,
    token: null,
    timeBank: 0,
    inTimeBank: false,
    audits: [],
    claimsPassedAway: [],
    turnsShownLate: [],
    chat: [],
    emotes: [],
    lastError: null,
    lastErrorCode: null,
    rttMs: null,
    standIn: false,
    disconnected: false,
    kicked: false,
  };
  private secret: string | null = null;
  private commits: Commitment[] | null = null;
  /** Hand our current secret was committed for. */
  private commitHand: number | null = null;
  /** Hand the stored commitment set belongs to (cleared on every new attempt). */
  private commitsHand: number | null = null;
  /** Hand for which the host says it supplied our share. */
  private standInHand: number | null = null;
  /** The hand already under way when we first saw the table (we could not take part in its deal). */
  private joinedHand: number | null = null;
  /** First hand this client saw any message about. */
  private firstHand: number | null = null;
  /** Built from a rejoin token alone, with no record of what came before. */
  private noHistory = false;
  /** Hands whose `hand_over` we received. */
  private handsEnded = new Set<number>();
  /** Host misbehaviour seen during each hand. */
  private tamper = new Map<number, string[]>();
  /** Match snapshot at the start of the current hand, needed to replay the audit. */
  private handStart: MatchSnapshot | null = null;
  /** Ceremony records of the last few hands. */
  private records: CeremonyRecord[] = [];
  /** What this client saw and sent while the last few hands were played. */
  private plays: PlayRecord[] = [];
  /** Where the last verified hand left the match: the next hand must start exactly there. */
  private expected: MatchSnapshot | null = null;
  /** Hand number already compared against `expected`. */
  private chainChecked: number | null = null;
  /** Bot seats as they stood at the match's first commit request; nobody becomes or stops being a bot after it. */
  private frozenBots: number[] | null = null;
  /** The rules as they stood at the match's first commit request. */
  private pinnedRules: RuleSet | null = null;
  /** The table's bot strength as its last welcome gave it; null when that welcome did not say (an older host). */
  private tableSkill: BotSkill | null = null;
  /**
   * The bot strength as it stood at the match's first commit request, or null before then. The
   * table's moves for seats are recomputed with it (`tableRule`). `unpublished`: the host did not
   * say, and a hand in which the table moved for a bot or a seat out of time fails. `unknown`: this
   * client was restored from a save written before the strength was kept, so it cannot know what
   * the table said, and such hands stay amber.
   */
  private pinnedSkill: BotSkill | 'unknown' | 'unpublished' | null = null;
  /** Link epoch: bumped on every link loss, rebind and restore. */
  private epoch = 0;
  /**
   * Clock era: the host's clock is one clock for as long as the host runs, whatever happens to
   * this device's links, so what this client learns about it holds across links and hands. Only a
   * restart the host announces begins a new era, since its clock may have started afresh.
   */
  private era = 0;
  /** What the hands of this match already audited established about the host's clock in one era (see `offsetFloor`). */
  private clockBase: ClockBase = { era: 0, anchor: null, minOffset: null };
  /** The last time-stamped frame received: a state, or a hand's end. */
  private lastStamp: GapStart | null = null;
  /**
   * While a hand is played, the longest the host may leave this seat without a frame: the protocol's
   * `CLOCK_FRAME_MS`, or less when the `welcome` announces less. A welcome cannot lengthen it, and one
   * that says nothing leaves it at `CLOCK_FRAME_MS`: the bound is this client's, not the server's.
   */
  private clockMs = CLOCK_FRAME_MS;
  /** When the watch asked the link in use for a `pong` because its stamps had fallen behind (see `checkLink`); null when it has not. */
  private probedAt: number | null = null;
  /**
   * The least arrival offset (`at - now`: this device's clock when a stamped frame arrived, less the
   * host's stamp on it) seen in this clock era and run of this device's clock (`clientClock`'s
   * `segment`), and when it was seen. It is how far ahead of the host's clock this device's is, plus
   * the shortest one-way delay seen; the audit measures the frames after it against it, and the
   * watch's reference (`watchRefAt`) is never less.
   */
  private lagRef: { lag: number; at: number; era: number; seg: number } | null = null;
  /** The highest stamp received in that scope: the watch measures how far it trails this device's clock (see `checkLink`). */
  private stampHigh: number | null = null;
  /**
   * The arrival offsets of the stamped frames of that scope that arrived in the last
   * `WATCH_WINDOW_MS` (and of the last frame before them), the least of each second: the watch
   * measures against the least of them (`watchRefAt`). Frames handled just after a pause are left
   * out (they may have waited in the device).
   */
  private lagWin: Array<{ from: number; at: number; lag: number }> = [];
  /** With no `lagRef` to measure against (a new clock era, or this device's clock just followed a sleep), when the watch began to wait. */
  private waitFrom: number | null = null;
  /** This run of the app (a restored client is a new run, its clock read from the wall anew): fixed points are compared only within one. */
  private readonly runId = randomHex(4);
  /**
   * Pings this run sent that no pong has answered yet, by the `at` each carried (the host echoes it),
   * with the run of this device's clock it was read in and the hand it was sent for (`handOnShow`; null:
   * none). Never saved: a pong is a fixed point only within the run of the app and of its clock that sent
   * the ping.
   */
  private readonly pings = new Map<number, { seg: number; hand: number | null }>();
  /** The last `MAX_PAUSES` stretches of this run in which the app did not run (see `ran`; saved with the record, `runScopes`): no frame's lateness and no move's wait is the server's doing while they last. */
  private readonly pauses: Array<{ from: number; to: number }> = [];
  /** When this client last published a round trip (`rttMs`; see `RTT_PUBLISH_MS`). */
  private rttAt: number | null = null;
  /**
   * The id this client gives the host as its device (`join.device`): the first run's id, kept across
   * app restarts. On a rejoin the host says whether another device held the seat since (`welcome.elsewhere`).
   */
  private deviceId: string = this.runId;
  /** This client (this run of the app) has been welcomed at the table: a later welcome is a rejoin. */
  private welcomed = false;
  /**
   * The link in use has brought a frame this client handled. An honest host answers a join with its
   * welcome before anything else, so only a welcome that is a link's first frame is a rejoin's.
   */
  private heardOnLink = false;
  /** The strongest fixed point of the hands audited in this era, run of the app and run of this device's clock (see `lateAnchor`). */
  private bestAnchor: LateScope['best'] = null;
  /** The same, of their pongs alone, each weighed less `DRIFT_RATE` for every ms since it was taken: what the Fair play count measures the next hand's first turns against. */
  private bestPong: LateScope['best'] = null;
  /**
   * What the earlier runs of the app whose frames the record holds carried (their strongest fixed points and their
   * pauses), as each saved it: a frame such a run saw is measured in its scope, as that run measured it
   * (`LateScope.earlier`). Restored from the record; this run's own is saved beside them (`serialize`).
   */
  private earlier: RunScope[] = [];
  /** When this app last ran: it handled a frame, checked the link, bound a link or sent a move. */
  private ranAt: number | null = null;
  /** The last stretch of more than `RAN_GAP_MS` in which this app did not run (the phone slept, or the app was in the background). */
  private pause: { from: number; to: number } | null = null;
  /** After the watch finds that this app was not running, it neither probes nor calls the link silent before this. */
  private graceUntil = Number.NEGATIVE_INFINITY;
  /** When the link in use was bound: nothing on it arrived earlier. */
  private boundAt = Number.NEGATIVE_INFINITY;
  /** The earliest the frame being handled can have arrived: earlier than now only just after a pause, when it may have waited in the device. */
  private frameAtLo: number | null = null;
  /** The link epoch that has brought a state or a hand's end stamped not late against `lagRef` (-1: none yet). A client's first link counts from the start. */
  private workingEpoch = -1;
  private firstLink = true;
  /** The link in use has brought a stamped frame: the watch measures it from then (a link that brings nothing is the heartbeat's to drop). */
  private linkStamped = false;
  /**
   * The link in use has not closed. What this device measures of the table (the pings, the link watch) runs while
   * it holds a seat on such a link, whether or not the table has welcomed it there (`connected`): an honest host
   * welcomes a link before it sends anything else on it, and one that never does must not turn the measures off.
   */
  private linkOpen = true;
  /**
   * The link on which this client learnt that its seat was opened on another device (`seatTaken`): it takes nothing
   * more from it. An honest host sends nothing more to a link once another device takes its seat, so a frame that comes
   * there anyway is not shown, played on or measured; the player takes the seat back from Home, on a new link.
   */
  private kickedLink: Link | null = null;
  /** When `checkLink` last ran. */
  private checkedAt: number | null = null;
  /**
   * When the watch began to measure the link in use without a break: null while it does not (no hand
   * is played, the app did not run, the watch's grace after that, a link that has brought no stamp),
   * and restarted when its checks were more than `RAN_GAP_MS` apart. A frame counts as live only if
   * the watch measured it long enough to have dropped the link before an honest frame was that late.
   */
  private watchFrom: number | null = null;
  /** The latest stamp on a frame of the link in use (its epoch and the host's clock era). */
  private linkStamp: { epoch: number; era: number; now: number } | null = null;
  /** The last state frame of the link in use: its hand and turn. */
  private linkShown: { epoch: number; hand: number; tc: number } | null = null;
  /**
   * Link epochs that ended by this device's own doing, or with its record in doubt: it left the
   * table, its seat was opened on another device, or the app restarted. What the table played for
   * the seat after one of them is noted, never judged: the table plays at once for a player who left.
   */
  private ownAbsences: number[] = [];
  /**
   * Stretches without a link in which the table played for this seat, by the arrival time of the
   * last frame before them, and whether the first such move came after a whole clock. Later moves
   * in the same stretch, in the same hand or the next, are covered by the first.
   */
  private gapVerdicts: Array<{ at: number; ok: boolean }> = [];
  /** Epoch of the last commit request. */
  private ceremonyEpoch = -1;
  /** Epoch in which the view on show arrived. */
  private viewEpoch = -1;
  /** Epoch in which this client last watched a hand end (or first sat down): no link loss since means it saw everything after. */
  private quietSince = -1;
  /**
   * The hand this client is on: the one it was last asked to commit to or shown, until that hand's
   * result arrives. While it is set, the table has no business with any other hand.
   */
  private openHand: number | null = null;
  /** Epoch of the last message about `openHand`: no link loss since means the hand cannot have ended unseen. */
  private handEpoch = -1;
  /** The match ended, and the hands this client verified say so (see `matchEndVerdict`). */
  private matchEnded = false;
  /**
   * This client sat down in the lobby and has not yet seen a hand end: the first hand it is dealt
   * must be the match's first, from the rules' starting position, whatever number the host gives it.
   */
  private atStart = false;
  /** A hand reached after hands this client missed with no record of them: its starting scores cannot be checked. */
  private gapHand: number | null = null;
  /**
   * Some hand of this match began from scores this client could not check (see `noteGap`). The hands
   * after it chain from it, so the final scores rest on it: the end of the match may be real, but
   * its scores are not shown as verified.
   */
  private chainGap = false;
  /**
   * A hand this device missed carries moves credited to its seat. The device watched none of
   * them, so the end of the match may be checked, but it is not shown as verified.
   */
  private missedMoves = false;
  /** The entry `failNow` last put on the list of audits (so the next failure about the same hand adds to it). */
  private liveFailure: ClientState['audits'][number] | null = null;
  /**
   * Hands the host said it resumed from a snapshot after a restart, and the turn it resumed at
   * (-1: before the deal). `undone`: this client had been shown more than that, and dropped it.
   */
  private rewinds: Array<{ hand: number; tc: number; undone: boolean }> = [];
  /**
   * The hand on show (`activeHand`) when a restart notice last began a clock era: a server may announce one restart
   * per hand, so a second notice while the same hand is on show, for another hand, begins none (`noteRestore`).
   */
  private eraHand: number | null = null;
  /**
   * The link in use opened as a returning seat's does: its first frame was the `welcome`, and only the records of the
   * hands it missed (and frames that name no hand) have followed. A restarted table's notice comes here and nowhere
   * else (`TableHost.onJoin`), once per link.
   */
  private opening = false;
  /**
   * This client was restored from a saved record, which may be a moment older than the last thing
   * the app did before it stopped, or built from a rejoin token with no record at all: `lapse`
   * until it next hears of a hand, then `lapseHand` is that hand, whose deal it may have taken
   * part in without a note of it surviving.
   */
  private lapse = false;
  private lapseHand: number | null = null;
  /** The restored record did not show `lapseHand` as dealt: its deal was agreed, or may have begun, around the restart. */
  private lapseDeal = false;
  private readonly listeners = new Set<(s: ClientState) => void>();
  private unsubMessage: Unsubscribe = () => undefined;
  private unsubClose: Unsubscribe = () => undefined;
  private link: Link;
  private readonly now: () => number;

  constructor(
    link: Link,
    private readonly name: string,
    private readonly avatar?: string,
    private readonly identity: { token?: string; userId?: string } = {},
    opts: TableClientOptions = {},
  ) {
    this.link = link;
    this.now = clientClock(opts);
    this.bind(link);
    if (identity.token) {
      this.state = { ...this.state, token: identity.token };
      this.noHistory = true;
      // Whatever an earlier run of the app did at this table is unknown: the deal of the first hand
      // this client hears of may have been agreed, in part, before it existed.
      this.lapse = true;
    }
  }

  /**
   * A client for a table this device was already verifying, from `serialize()`. Its records carry
   * on; the link it saved on is gone, so it counts as lost. An unknown or damaged snapshot gives a
   * client built from the token alone (no history).
   */
  static restore(saved: unknown, link: Link, name: string, avatar?: string, identity: { token?: string; userId?: string } = {}, opts: TableClientOptions = {}): TableClient {
    const c = new TableClient(link, name, avatar, identity, opts);
    if (!isObject(saved) || saved.version !== CLIENT_SNAPSHOT_VERSION || !isObject(saved.state)) return c;
    try {
      // A copy: the client goes on to change its records, and the caller may restore from `saved` again.
      c.load(JSON.parse(JSON.stringify(saved)) as SerializedClient);
    } catch {
      return new TableClient(link, name, avatar, identity, opts);
    }
    return c;
  }

  private load(d: SerializedClient): void {
    if (typeof d.device === 'string' && /^[\w-]{6,64}$/.test(d.device)) this.deviceId = d.device;
    const st = d.state;
    this.state = {
      ...this.state,
      ...st,
      rules: st.rules ? sanitizeRules(st.rules) : null,
      audits: Array.isArray(st.audits) ? st.audits.slice(-MAX_AUDITS) : [],
      claimsPassedAway: Array.isArray(st.claimsPassedAway) ? st.claimsPassedAway.filter(isPassedClaimRecord).map((x) => ({ hand: x.hand, turn: x.turn, claim: x.claim, ...(x.late === true ? { late: true } : {}) })) : [],
      turnsShownLate: Array.isArray(st.turnsShownLate) ? st.turnsShownLate.filter(isLateTurnRecord).map((x) => ({ hand: x.hand, late: x.late.slice(), of: x.of })) : [],
      token: this.identity.token ?? st.token ?? null,
      connected: false,
      disconnected: true,
      kicked: false,
      chat: [],
      emotes: [],
      rttMs: null,
      lastError: null,
      lastErrorCode: null,
    };
    this.secret = d.secret;
    this.commits = d.commits;
    this.commitHand = d.commitHand;
    this.commitsHand = d.commitsHand;
    this.standInHand = d.standInHand;
    this.joinedHand = d.joinedHand;
    this.firstHand = d.firstHand;
    this.noHistory = d.noHistory === true;
    this.handsEnded = new Set((d.handsEnded ?? []).filter(isInt));
    this.tamper = new Map(d.tamper ?? []);
    this.handStart = d.handStart;
    // The fields that judge how late a frame came are kept only when they are what this build writes (see `cleanSeen`).
    this.records = Array.isArray(d.records) ? d.records.map(cleanCeremony) : [];
    this.plays = Array.isArray(d.plays) ? d.plays.map(cleanPlay) : [];
    this.expected = d.expected;
    this.chainChecked = d.chainChecked;
    this.frozenBots = d.frozenBots;
    this.pinnedRules = d.pinnedRules ? sanitizeRules(d.pinnedRules) : null;
    this.pinnedSkill = isBotSkill(d.pinnedSkill) || d.pinnedSkill === 'unknown' || d.pinnedSkill === 'unpublished' ? d.pinnedSkill : this.pinnedRules ? 'unknown' : null;
    this.epoch = isInt(d.epoch) ? d.epoch : 0;
    this.ceremonyEpoch = isInt(d.ceremonyEpoch) ? d.ceremonyEpoch : -1;
    this.quietSince = isInt(d.quietSince) ? d.quietSince : -1;
    this.openHand = isInt(d.openHand) ? d.openHand : null;
    this.handEpoch = isInt(d.handEpoch) ? d.handEpoch : -1;
    this.matchEnded = d.matchEnded === true;
    this.atStart = d.atStart === true;
    this.gapHand = isInt(d.gapHand) ? d.gapHand : null;
    this.chainGap = d.chainGap === true || this.gapHand !== null;
    this.missedMoves = d.missedMoves === true;
    // (A record saved before the flag was kept says so by the audits it holds of this match.)
    const matchFailed = st.matchFailed === true || this.state.audits.some((a) => isObject(a) && a.status === 'failed' && isObject(a.audit) && a.audit.matchId === this.state.matchId);
    this.state = { ...this.state, matchFailed, matchEndVerified: this.matchEnded && !this.chainGap && !this.missedMoves && !matchFailed && this.state.matchOver };
    this.rewinds = Array.isArray(d.rewinds) ? d.rewinds.filter((x) => isObject(x) && isInt(x.hand) && isInt(x.tc)) : [];
    this.eraHand = isInt(d.eraHand) ? d.eraHand : null;
    this.lapseHand = isInt(d.lapseHand) ? d.lapseHand : null;
    this.lapseDeal = d.lapseDeal === true;
    const k = isObject(d.clock) ? d.clock : null;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const stamp = (x: unknown): GapStart | null => (isObject(x) && num(x.at) !== null && num(x.now) !== null && isInt(x.epoch) && isInt(x.era) ? { at: x.at as number, now: x.now as number, epoch: x.epoch, era: x.era } : null);
    this.era = k && isInt(k.era) ? k.era : 0;
    // Kept with the run of the app it was measured in: it holds for the hand that spans this restart, and no further (`holdsIn`).
    this.clockBase = k && isObject(k.base) && isInt(k.base.era) ? { era: k.base.era, ...(typeof k.base.run === 'string' ? { run: k.base.run } : {}), ...(isInt(k.base.seg) && k.base.seg >= 0 ? { seg: k.base.seg } : {}), anchor: num(k.base.anchor), minOffset: num(k.base.minOffset) } : { era: this.era, anchor: null, minOffset: null };
    this.lastStamp = k ? stamp(k.lastStamp) : null;
    this.ownAbsences = k && Array.isArray(k.ownAbsences) ? k.ownAbsences.filter(isInt) : [];
    this.gapVerdicts = k && Array.isArray(k.gapVerdicts) ? k.gapVerdicts.filter((g) => isObject(g) && num(g.at) !== null).map((g) => ({ at: g.at, ok: g.ok === true })) : [];
    // What the earlier runs carried, where its check figure matches (one that does not is not read back: those runs'
    // frames are then not measured by fixed points, as before such figures were kept).
    this.earlier = k && Array.isArray(k.runs) ? k.runs.map((x) => cleanRunScope(x, MAX_PAUSES)).filter((x): x is RunScope => x !== null && x.run !== this.runId).slice(-MAX_RUN_SCOPES) : [];
    // What this device did before the app stopped is not all on record (it may have left the table).
    this.noteOwnAbsence();
    this.lapse = true;
    // The app stopped: the link it had is gone. Moves sent just before the last save may be missing
    // from the ledger, so it vouches for the log of a hand still under way only from the next state it sees.
    // (Every such hand, whichever record was made last.)
    this.noteLinkLost();
    for (const play of this.plays) if (!this.handsEnded.has(play.hand)) play.ledgerFrom = Number.POSITIVE_INFINITY;
  }

  /** Everything needed to carry on verifying after an app restart (see `TableClient.restore`). */
  serialize(): SerializedClient {
    const { chat: _c, emotes: _e, rttMs: _r, ...state } = this.state;
    void _c;
    void _e;
    void _r;
    return {
      version: CLIENT_SNAPSHOT_VERSION,
      state: { ...state, audits: state.audits.slice(-MAX_AUDITS) },
      device: this.deviceId,
      secret: this.secret,
      commits: this.commits,
      commitHand: this.commitHand,
      commitsHand: this.commitsHand,
      standInHand: this.standInHand,
      joinedHand: this.joinedHand,
      firstHand: this.firstHand,
      noHistory: this.noHistory,
      handsEnded: [...this.handsEnded].sort((a, b) => a - b).slice(-MAX_AUDITS),
      tamper: [...this.tamper.entries()].slice(-8),
      handStart: this.handStart,
      records: this.records,
      // Each frame goes with its check figure, so a restored record can tell a damaged frame (`cleanSeen`), and so
      // does each answer to a ping and first ping of a scope: each measures only the frames of the run that made it.
      plays: this.plays.map(savedPlay),
      expected: this.expected,
      chainChecked: this.chainChecked,
      frozenBots: this.frozenBots,
      pinnedRules: this.pinnedRules,
      pinnedSkill: this.pinnedSkill,
      epoch: this.epoch,
      ceremonyEpoch: this.ceremonyEpoch,
      quietSince: this.quietSince,
      openHand: this.openHand,
      handEpoch: this.handEpoch,
      matchEnded: this.matchEnded,
      atStart: this.atStart,
      gapHand: this.gapHand,
      chainGap: this.chainGap,
      missedMoves: this.missedMoves,
      rewinds: this.rewinds,
      eraHand: this.eraHand,
      lapseHand: this.lapseHand,
      lapseDeal: this.lapseDeal,
      clock: { era: this.era, base: { ...this.clockBase }, lastStamp: this.lastStamp, ownAbsences: this.ownAbsences.slice(), gapVerdicts: this.gapVerdicts.slice(), runs: this.runScopes().map(withSum) },
    };
  }

  private bind(link: Link): void {
    this.link = link;
    this.probedAt = null;
    // A client's first link follows no drop. A later one does not count as working (its frames
    // as timely) until it brings a stamp that is not late against the clock relation seen so far,
    // and the watch measures it from its first stamped frame (see `checkLink`).
    this.workingEpoch = this.firstLink ? this.epoch : -1;
    this.firstLink = false;
    this.heardOnLink = false;
    this.opening = false;
    this.waitFrom = null;
    this.linkStamped = false;
    this.linkOpen = true;
    this.watchFrom = null;
    // Binding a link is this app running, and nothing on the link can have arrived before it.
    this.boundAt = this.now();
    this.ran(this.boundAt);
    this.unsubMessage = link.onMessage((m) => {
      // Not a frame at all (not an object with a type): dropped before anything reads it.
      if (!isFrame(m)) return;
      // The seat was opened on another device on this link: this client takes nothing more from it (`kickedLink`).
      if (this.state.kicked && this.kickedLink === link) return;
      // Any frame shows this app running; only stamps feed the watch (see `noteStamp`), so chat,
      // emotes and stamps that crawl or stand still do not keep the link alive. A frame handled
      // just after the app did not run may have waited in the device through the pause, though
      // never from before its link was bound.
      const t = this.now();
      this.ran(t);
      this.frameAtLo = this.afterPause(t) ? Math.max(this.pause!.from, this.boundAt) : t;
      try {
        this.onMessage(m);
      } catch (e) {
        this.update({ lastError: `Ignored a malformed message from the table (${(e as Error).message}).`, lastErrorCode: null });
      } finally {
        if (this.link === link) this.heardOnLink = true;
      }
    });
    this.unsubClose =
      link.onClose?.(() => {
        if (this.link !== link) return;
        this.linkOpen = false;
        this.noteLinkLost();
        this.update({ connected: false, disconnected: true, lastError: 'Connection to the table was lost.', lastErrorCode: null });
      }) ?? (() => undefined);
  }

  /**
   * Move this client onto a new link to the same table (after a reconnect). The old link's
   * subscriptions are dropped; everything this client recorded stays. Call `join()` next.
   */
  rebind(link: Link): void {
    this.unsubMessage();
    this.unsubClose();
    if (this.link !== link) this.noteLinkLost();
    this.bind(link);
  }

  /** Ask the host to start (server-hosted tables have no local host UI). */
  requestStart(): void {
    this.send({ t: 'start' });
  }

  requestBot(): void {
    this.send({ t: 'add_bot' });
  }

  onChange(cb: (s: ClientState) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  join(wantSeat?: number): void {
    const token = this.state.token ?? this.identity.token;
    this.send({ t: 'join', name: this.name, avatar: this.avatar, wantSeat, token, userId: this.identity.userId, have: this.have(), device: this.deviceId });
    // A ping right behind the join, so the table's answer ties its clock to this device's from the first
    // frames of the link. Sent once `join` has returned: a transport that delivers at once must not be
    // entered again from inside it.
    const link = this.link;
    const later = (f: () => void) => (typeof queueMicrotask === 'function' ? queueMicrotask(f) : void Promise.resolve().then(f));
    later(() => {
      if (this.link === link) this.ping();
    });
  }

  /** The last hand of this match whose end this client holds (-1: none yet, but it watched from the lobby). */
  private have(): number | undefined {
    if (this.state.matchId === null) return undefined;
    if (this.handsEnded.size > 0) return Math.max(...this.handsEnded);
    return this.atStart ? -1 : undefined;
  }

  act(action: Action): void {
    // Nor does it send a move once its seat was opened on another device: the player takes the seat back from Home first.
    if (this.state.seat === null || this.state.kicked) return;
    // A view from before the link was lost says nothing about the table now: wait for the first state on this link.
    if (this.viewEpoch !== this.epoch) return;
    const v = this.state.view;
    const tc = v && isInt(v.turnCounter) ? v.turnCounter : undefined;
    if (v && tc !== undefined) {
      const play = this.playFor(v.handNumber);
      const at = this.now();
      this.ran(at);
      play.sent.push({ tc, action, epoch: this.epoch, at, run: this.runId, seg: this.seg() });
      if (play.sent.length > MAX_SENT) play.sent.splice(0, play.sent.length - MAX_SENT);
    }
    this.send({ t: 'action', seat: this.state.seat, action, expectHash: this.state.stateHash ?? undefined, turnCounter: tc });
  }

  ready(): void {
    this.send({ t: 'ready' });
  }

  chat(text: string): void {
    this.send({ t: 'chat', text });
  }

  emote(emote: string): void {
    this.send({ t: 'emote', emote });
  }

  /**
   * Ask the table for its clock (`pong`). The ping carries this device's clock (`at`), which the table
   * echoes: its answer, stamped after the ping reached it, is a fixed point between the two clocks
   * (`notePong`). One ping per reading of the clock; while a hand is on show it is counted for that hand
   * (`PlayRecord.pinged`), so a table that answers none of them makes the hand amber (`noAnswer`), and the first
   * one of each clock era of the host and run of this device's clock is kept (`PlayRecord.pingedFrom`): a turn
   * that reaches this device well after it, when the table has answered none of that scope's pings, is not timely
   * (`unanswered`).
   */
  ping(): void {
    const at = this.now();
    if (this.pings.has(at)) return;
    const play = this.handOnShow();
    const seg = this.seg();
    this.pings.set(at, { seg, hand: play ? play.hand : null });
    if (this.pings.size > MAX_PINGS) this.pings.delete(this.pings.keys().next().value as number);
    if (play) {
      play.pinged = (play.pinged ?? 0) + 1;
      const from = (play.pingedFrom ??= []);
      if (!from.some((p) => p.era === this.era && p.run === this.runId && p.seg === seg)) {
        from.push({ era: this.era, run: this.runId, seg, at });
        if (from.length > MAX_PING_SCOPES) from.shift();
      }
    }
    this.send({ t: 'ping', at });
  }

  /**
   * The record of the hand on show while it is played (a view, no result yet, the hand not ended), or of the
   * hand whose deal is being agreed (its first turns come right after the deal, and the deal's own fixed point
   * holds the time the table waited for every share); null otherwise.
   */
  private handOnShow(): PlayRecord | null {
    const v = this.state.view;
    if (v && this.state.lastResult === null && !this.handsEnded.has(v.handNumber)) return this.plays.find((p) => p.hand === v.handNumber) ?? null;
    const h = this.openHand;
    return h !== null && this.state.ceremony !== 'idle' && !this.handsEnded.has(h) ? this.playFor(h) : null;
  }

  /**
   * The table's answer to a ping: a fixed point between its clock and this device's (`ClockAnchor`): it
   * stamped the answer (`now`) after the ping this device sent at `at` reached it, and the answer
   * reached this device at `fat`. Only an answer to a ping this run sent, read in the run of this
   * device's clock it is in now, and only the first answer to each: anything else is ignored. The hand
   * the ping was sent for keeps it while it is still that hand's time (`handOnShow`, `PlayRecord.pongs`),
   * one per `PONG_WINDOW_MS` of ping time (the one with the shortest round trip), and the first of each clock
   * era of the host and run of this device's clock as well: every frame of that scope after it is measured
   * against something (`lateBy`, `unanswered`). Its audit measures every state against them.
   */
  private notePong(at: unknown, now: unknown): void {
    if (typeof at !== 'number' || !Number.isFinite(at) || typeof now !== 'number' || !Number.isFinite(now)) return;
    const sent = this.pings.get(at);
    if (sent === undefined) return;
    this.pings.delete(at);
    const fat = this.now();
    const seg = sent.seg;
    if (seg !== this.seg() || fat < at) return;
    // Nothing on screen reads the round trip: publishing it with every pong would re-render the table and save the record each second.
    if (this.rttAt === null || fat - this.rttAt >= RTT_PUBLISH_MS) {
      this.rttAt = fat;
      this.update({ rttMs: fat - at });
    }
    const play = this.handOnShow();
    if (!play || play.hand !== sent.hand) return;
    const k: ClockAnchor = { at, now, era: this.era, run: this.runId, seg, fat };
    const pongs = (play.pongs ??= []);
    const last = pongs[pongs.length - 1];
    const same = (x: ClockAnchor | undefined): boolean => !!x && x.run === k.run && x.era === k.era && (x.seg ?? 0) === seg;
    // (The first of a scope stays, whatever its round trip: a frame that came before the next one is bound by it alone.)
    if (same(last) && same(pongs[pongs.length - 2]) && Math.floor(last.at / PONG_WINDOW_MS) === Math.floor(at / PONG_WINDOW_MS)) {
      if (fat - at < (last.fat as number) - last.at) pongs[pongs.length - 1] = k;
    } else pongs.push(k);
    if (pongs.length > MAX_PONGS) pongs.splice(0, pongs.length - MAX_PONGS);
  }

  /**
   * Call about once a second while the link is up (the online session does). While a hand is played,
   * an honest host never leaves this seat without a stamped frame for longer than the protocol's
   * clock-frame period (`CLOCK_FRAME_MS`, 3 s), whatever its `welcome` says: a host that sends no
   * clock frames, or announces a longer period, is held to it all the same.
   *
   * The watch does not count frames: it measures how far the host's stamps have fallen behind this
   * device's clock. Its reference (`watchRefAt`) is the least arrival offset (arrival less stamp) of
   * the frames that arrived in the last `WATCH_WINDOW_MS`, never less than `lagRef`, the least seen in
   * this clock era and run of this device's clock (with `DRIFT_RATE` allowed for since it was seen, at most `DRIFT_CAP_MS`).
   * A frame the host stamped `s` and sent at once has arrived by about `s` plus the reference; at
   * `now` the stamps are `now - (stampHigh + reference)` behind, the deficit. Stamps that crawl a
   * millisecond at a time leave the deficit growing whatever frames keep arriving, and so does a link
   * that brings nothing: the least offset of the last 20 s stays where the crawl began until the
   * deficit has reached 13 s. A network delay that rose and stayed up is in the reference once it has
   * lasted 20 s, so a link that has grown slower is not dropped over and over. A delay that rises
   * slowly, or stamps that run slow, can be taken in the same way: the audit measures every frame
   * against `lagRef` all the same (`lateRef`), and the order of the stamps (`noteOrder`) and the
   * state that starts each turn (`armedLate`) catch a turn held back under them. When the deficit
   * reaches `2 × CLOCK_FRAME_MS + 2 s` this client asks for a `pong` (which counts only through its
   * stamp); when the ping has been out `SILENT_ANSWER_MS` and the deficit has reached
   * `2 × CLOCK_FRAME_MS + 2 s + SILENT_ANSWER_MS`, the answer is 'silent'. The session then drops the
   * link, and the time without one is judged as a drop: the table may move for the seat in it only
   * when its clock could have run out. A host that answers at once, while it holds back what it sent
   * before, is caught by the order of the stamps (`noteOrder`) or by the audit of the turn's state
   * (`judgeTableMove`). The one link kept at that point is one that still brings frames at the pace
   * of their stamps, behind by a delay that has held steady (`steadyBehind`): a network delay that
   * rose in a step and stayed up, which the reference takes in once it has lasted `WATCH_WINDOW_MS`
   * (and which may be too slow for the app to connect again). The watch then measures it afresh from
   * the next check, so no frame on it counts as live before it would on a link just joined.
   *
   * While this scope has no `lagRef` yet (a new clock era, or this device's clock has just followed a
   * sleep), the deficit is the time since the watch began to wait. A new link is watched from its
   * first stamped frame; until then it is the heartbeat's to drop. A gap between calls longer than
   * `LINK_PAUSE_MS` means this app was not running (the phone slept, or the app was in the
   * background): for `2 × CLOCK_FRAME_MS + 2 s` after it the link is not blamed, so that frames that
   * waited in the device are handled first; the first call starts the same way.
   *
   * The watch measures only while a hand is played, and only from its first check that measures
   * (`watchFrom`): not while a result or the deal's ceremony is shown, not in its grace, not on a link
   * that has brought no stamp, and afresh after checks more than `RAN_GAP_MS` apart. So a frame counts
   * as live (`noteStamp`) only when the watch had been measuring its link since before the frame was
   * `2 × CLOCK_FRAME_MS + 2 s` late: frames that piled up while it was not (a stall across a deal, the
   * app back from the background) are judged as late, never as held back on a live link.
   */
  checkLink(): 'ok' | 'silent' {
    const now = this.now();
    this.ran(now);
    const verdict = this.watchLink(now);
    // A ping a second while this device holds a seat on a link that is up, whatever the watch found:
    // every answer is a fixed point between the table's clock and this device's (`notePong`). Whether
    // the table has welcomed the link does not matter (`linkOpen`).
    if (this.holdsSeat()) this.ping();
    return verdict;
  }

  /** The link watch's check at `now` (see `checkLink`). */
  private watchLink(now: number): 'ok' | 'silent' {
    // The first call, or the first after a pause: the wait starts now.
    const since = this.checkedAt === null ? Number.POSITIVE_INFINITY : now - this.checkedAt;
    const paused = since > LINK_PAUSE_MS;
    this.checkedAt = now;
    if (!this.playing()) {
      this.probedAt = null;
      this.watchFrom = null;
      return 'ok';
    }
    const probeAt = this.probeAt();
    if (paused) {
      this.graceUntil = now + probeAt;
      this.probedAt = null;
      this.watchFrom = null;
      return 'ok';
    }
    if (now < this.graceUntil) return 'ok';
    // A new link is watched from its first stamped frame (a link that brings nothing is the heartbeat's to drop).
    if (!this.linkStamped) {
      this.probedAt = null;
      this.watchFrom = null;
      return 'ok';
    }
    // The watch measures the link from here; a break in its checks starts the stretch again.
    if (this.watchFrom === null || since > RAN_GAP_MS) this.watchFrom = now;
    const ref = this.watchRefAt(now);
    let deficit: number;
    if (this.stampHigh !== null && ref !== null) {
      deficit = now - (this.stampHigh + ref);
      this.waitFrom = null;
    } else {
      // No reference in this scope yet (a new clock era, or this device's clock just jumped): waited for from the first check.
      if (this.waitFrom === null) this.waitFrom = now;
      deficit = now - this.waitFrom;
    }
    if (deficit < probeAt) {
      this.probedAt = null;
      return 'ok';
    }
    if (this.probedAt === null) {
      this.probedAt = now;
      this.ping();
    }
    if (now - this.probedAt < SILENT_ANSWER_MS || deficit < probeAt + SILENT_ANSWER_MS) return 'ok';
    // Frames still come at the pace of their stamps, behind by a delay that holds steady: a network
    // delay that rose in a step and stayed up, which the reference takes in once it has lasted
    // `WATCH_WINDOW_MS`. The link is kept, but measured afresh from the next check: no frame that
    // arrives before then counts as live (`noteStamp`), so none of them can fail a hand as held back.
    if (this.steadyBehind(now)) {
      this.watchFrom = null;
      return 'ok';
    }
    return 'silent';
  }

  /**
   * The link keeps bringing frames at the pace of their stamps, behind by a delay that holds steady:
   * one arrived within a clock-frame period and a second, and the frames of the last `probeAt()`
   * arrived with offsets within `STEADY_SLACK_MS` of one another. Not a link that brings nothing,
   * nor one whose stamps crawl or stand still (each of its frames arrives later after its stamp
   * than the one before it, by the time between them).
   */
  private steadyBehind(now: number): boolean {
    const last = this.lagWin[this.lagWin.length - 1];
    if (!last || now - last.at > this.clockMs + 1_000) return false;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const e of this.lagWin) {
      if (e.at < now - this.probeAt()) continue;
      lo = Math.min(lo, e.lag);
      hi = Math.max(hi, e.lag);
    }
    return hi - lo <= STEADY_SLACK_MS;
  }

  /** This app ran at `t` (a frame, a check, a new link, a move): a gap of more than `RAN_GAP_MS` since it last ran was a pause. */
  private ran(t: number): void {
    if (this.ranAt !== null && t - this.ranAt > RAN_GAP_MS) {
      this.pause = { from: this.ranAt, to: t };
      this.pauses.push(this.pause);
      if (this.pauses.length > MAX_PAUSES) this.pauses.shift();
    }
    this.ranAt = t;
  }

  /** How far the host's stamps may fall behind this device's clock before the watch asks for a `pong`: `2 × CLOCK_FRAME_MS + 2 s`, or less when the welcome announced a shorter clock-frame period. */
  private probeAt(): number {
    return 2 * this.clockMs + 2_000;
  }

  /** `t` falls within `PAUSE_GRACE_MS` after a pause: a frame handled then may have waited in the device through it. */
  private afterPause(t: number): boolean {
    return this.pause !== null && t - this.pause.to <= PAUSE_GRACE_MS;
  }

  /** The link in use has brought a state: only then are its clock frames and pongs believed. */
  private stateHere(): boolean {
    return this.linkShown !== null && this.linkShown.epoch === this.epoch;
  }

  /**
   * This device holds a seat on a link that is up: one it has not left, that has not closed, and on which its seat
   * was not opened on another device. Not whether the table has welcomed it there (`connected`): an honest host
   * welcomes a link before it sends anything else on it, so a table that sends frames on a link it never welcomed
   * is measured as on any other (`linkOpen`).
   */
  private holdsSeat(): boolean {
    return this.state.seat !== null && !this.state.kicked && this.linkOpen;
  }

  /** A hand is being played at this seat over a link that is up (`holdsSeat`). */
  private playing(): boolean {
    const st = this.state;
    return this.holdsSeat() && !st.matchOver && st.view !== null && st.lastResult === null && st.ceremony === 'idle';
  }

  /** The run of this device's clock (see `clientClock`): it moves on when the clock follows the wall across a sleep. */
  private seg(): number {
    return (this.now as unknown as { segment?: number }).segment ?? 0;
  }

  /** The least arrival offset of this clock era and run of this device's clock at `t`, allowing for drift since it was seen, at most `DRIFT_CAP_MS` (null: none yet). */
  private refAt(t: number): number | null {
    const r = this.lagRef;
    if (!r || r.era !== this.era || r.seg !== this.seg()) return null;
    return r.lag + Math.min(DRIFT_CAP_MS, DRIFT_RATE * Math.max(0, t - r.at));
  }

  /**
   * The link watch's reference at `t`: the least arrival offset of the frames of this scope that
   * arrived in the `WATCH_WINDOW_MS` before it (or of the last one, when none did), never less than
   * `refAt(t)`; null while the scope has no reference. A network delay that rose and stayed up is in
   * it once it has lasted that long; stamps that crawl are not, before the watch drops the link.
   */
  private watchRefAt(t: number): number | null {
    const ref = this.refAt(t);
    if (ref === null) return null;
    let low = Number.POSITIVE_INFINITY;
    for (const e of this.lagWin) if (e.at >= t - WATCH_WINDOW_MS) low = Math.min(low, e.lag);
    const last = this.lagWin[this.lagWin.length - 1];
    if (low === Number.POSITIVE_INFINITY && last) low = last.lag;
    return low === Number.POSITIVE_INFINITY ? ref : Math.max(ref, low);
  }

  /** Keep the arrival offset `lag` of a frame that arrived at `at` for the watch's reference (one entry a second, the least). */
  private noteLag(at: number, lag: number): void {
    const last = this.lagWin[this.lagWin.length - 1];
    if (last && at - last.from < 1_000) {
      last.at = at;
      last.lag = Math.min(last.lag, lag);
    } else this.lagWin.push({ from: at, at, lag });
    while (this.lagWin.length > 1 && this.lagWin[0].at < at - WATCH_WINDOW_MS) this.lagWin.shift();
  }

  /**
   * Note the stamp `now` of a frame (a state, a hand's end, a clock frame or a pong): what it says of
   * the host's clock against this device's. A frame that arrived with the least offset yet seen in
   * its scope becomes the reference (`lagRef`); every frame's offset feeds the watch's reference
   * (`watchRefAt`), and the highest stamp the watch's deficit (`checkLink`).
   * Returns when the frame arrived, the earliest it can have arrived (`atLo`), the reference before
   * it (`ref`, null while the scope has none) and the watch's (`wref`), whether its link was working
   * (it had brought a state or a hand's end stamped not more than `LATE_MS` late against `ref`: a
   * clock frame or a pong vouches for no state, so it never makes a link working; `opens` says the
   * frame is one that can) and whether it was live:
   * working, while a hand is played, with the watch checking it within the last `RAN_GAP_MS`, not just
   * after a pause and not in the watch's grace after one, and measured by the watch without a break
   * since before it was `2 × CLOCK_FRAME_MS + 2 s` late against `wref`. No honest frame on a live link
   * is more than `LATE_MS` late against `wref`: the watch drops a link before its stamps fall that far
   * behind.
   */
  private noteStamp(now: unknown, opens = false): { at: number; atLo: number; ref: number | null; wref: number | null; live: boolean; working: boolean; seg: number } | null {
    if (typeof now !== 'number' || !Number.isFinite(now)) return null;
    const at = this.now();
    const seg = this.seg();
    if (!this.lagRef || this.lagRef.era !== this.era || this.lagRef.seg !== seg) {
      if (this.lagRef) this.waitFrom = null;
      this.lagRef = null;
      this.stampHigh = null;
      this.lagWin = [];
    }
    const atLo = Math.min(at, this.frameAtLo ?? at);
    const ref = this.refAt(atLo);
    const wref = this.watchRefAt(atLo);
    const working = this.workingEpoch === this.epoch;
    const excess = ref === null ? 0 : atLo - now - ref;
    // Live: the watch was measuring this link, and had been since before the frame was `probeAt` late
    // by its reference, so it would have dropped the link before an honest frame was later than `LATE_MS`.
    const late = wref === null ? 0 : atLo - now - wref;
    const watched = this.watchFrom !== null && late <= at - this.watchFrom + this.probeAt();
    const live = working && watched && this.playing() && this.checkedAt !== null && at - this.checkedAt <= RAN_GAP_MS && !this.afterPause(at) && at >= this.graceUntil;
    const lag = at - now;
    const cur = this.refAt(at);
    if (cur === null || lag <= cur) this.lagRef = { lag, at, era: this.era, seg };
    if (!this.afterPause(at)) this.noteLag(at, lag);
    if (this.stampHigh === null || now > this.stampHigh) this.stampHigh = now;
    this.linkStamped = true;
    if (opens && excess <= LATE_MS) this.workingEpoch = this.epoch;
    return { at, atLo, ref, wref, live, working, seg };
  }

  leave(): void {
    this.noteOwnAbsence();
    this.linkOpen = false;
    this.send({ t: 'leave' });
    this.unsubMessage();
    this.unsubClose();
    this.link.close();
  }

  /** Match snapshot at the start of the current/last hand (for local replay and review). */
  handSnapshot(): MatchSnapshot | null {
    return this.handStart;
  }

  /** Engine-shaped state for running hints/bots locally on the visible information. */
  localState(): GameState | null {
    return this.state.view ? viewToState(this.state.view) : null;
  }

  /**
   * This seat's clock for the move it owes, on this device's clock (`clockNow`): when its turn clock
   * ends, and when its time bank after it does; null when it owes no move with a clock. It is the clock
   * the audit holds the table to, counted by this device itself (`ownClockFrom`): from the states that
   * showed the seat the move (`ownRun`), placed on this device's clock by the strongest fixed point it
   * holds, never later than the first of them allows counted from its arrival. It ends where the audit
   * holds the table to (`streakEnd`): never before the rules' clock as this device tracks it, and at any
   * later end a state of the move showed, even one a later state took back. It goes on to the bank
   * when the turn clock ends without waiting for the table to say so, and a wrong wall clock on the
   * phone does not move it. The app shows it for the seat's own move.
   */
  ownClock(): OwnClock | null {
    const v = this.state.view;
    const rules = this.pinnedRules ?? this.state.rules;
    if (!v || !rules || this.state.seat === null || this.state.lastResult !== null || this.handsEnded.has(v.handNumber)) return null;
    const play = this.plays.find((p) => p.hand === v.handNumber);
    const run = play ? ownRun(play, rules) : [];
    if (!play || run.length === 0) return null;
    const at = this.now();
    const deal = this.dealFixed(v.handNumber);
    const points = [...(deal ? [deal] : []), ...(play.pongs ?? [])];
    // The end the audit holds the table to (`streakEnd`): the rules' clock as this device tracks it for the
    // latest state, or a later end any state of the streak claimed, each stated bank less the host's rounding.
    const last = play.seen.length - 1;
    const bound = clockTrack(this.clockBase, this.recordFor(v.handNumber), play, rules, points).bound.get(play.seen[last]);
    const end = streakEnd(play, last, rules, bound, BANK_ROUND_MS);
    return ownClockFrom(run, end, points, this.bestAnchor, this.refAt(at), at, { era: this.era, run: this.runId, seg: this.seg() });
  }

  /**
   * The deal of hand `h` as a fixed point between the two clocks, when this device revealed its share in
   * the attempt that was dealt and the hand's first frame came after it, over the same link: the host
   * cannot have dealt from that share before this device sent it. (The audit also holds the deal to the
   * share it revealed: a deal without it fails, `runAudit`.) Null otherwise.
   */
  private dealFixed(h: number): ClockAnchor | null {
    if (this.commitHand !== h || this.standInHand === h || !this.secret) return null;
    const last = this.recordFor(h)?.attempts.slice(-1)[0];
    const first = this.plays.find((p) => p.hand === h)?.seen[0];
    // (Not from a state restored damaged: its stamp may be anything, `cleanSeen`.)
    if (!last?.revealed || typeof last.revealedAt !== 'number' || !first || first.kept === false || typeof first.now !== 'number' || first.epoch !== last.revealedEpoch || first.at < last.revealedAt) return null;
    return { at: last.revealedAt, now: first.now, era: first.era ?? 0, run: last.revealedRun, seg: last.revealedSeg, fat: first.at };
  }

  /** This device's clock as the table client reads it (`clientClock`): what `ownClock` is measured against. */
  clockNow(): number {
    return this.now();
  }

  private send(msg: ClientMessage): void {
    this.link.send(msg);
  }

  private update(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private flag(hand: number, problem: string): void {
    const list = this.tamper.get(hand) ?? [];
    if (!list.includes(problem)) list.push(problem);
    this.tamper.set(hand, list);
    // Only hands not yet audited need their flags; keep the map small, never at the cost of the hand this client is on.
    if (this.tamper.size > MAX_FLAGGED_HANDS) {
      const keys = [...this.tamper.keys()];
      const drop = this.handToDrop(keys, (k) => k, hand);
      if (drop !== null) this.tamper.delete(drop);
    }
  }

  /**
   * The hand this client is on, which every problem seen now belongs to: the one it was last asked to commit to or
   * shown, until that hand's result arrives (`openHand`), else the one on show, else the next one to be dealt.
   */
  private activeHand(): number {
    if (this.openHand !== null && !this.handsEnded.has(this.openHand)) return this.openHand;
    const v = this.state.view;
    if (v && !this.handsEnded.has(v.handNumber)) return v.handNumber;
    if (this.expected) return this.expected.handNumber;
    const ended = [...this.handsEnded];
    return ended.length > 0 ? Math.max(...ended) + 1 : 0;
  }

  /**
   * Which entry a per-hand collection that has grown past its cap gives up: the oldest of a hand that has ended, else
   * the oldest of any other hand but the one this client is on (`activeHand`) and `keep`. A frame about a hand the table
   * has no business naming makes no entry (see `onMessage`); this keeps the hand on show whatever else comes.
   */
  private handToDrop<T>(list: readonly T[], handOf: (x: T) => number, keep: number | null = null): T | null {
    const on = this.activeHand();
    return list.find((x) => this.handsEnded.has(handOf(x))) ?? list.find((x) => handOf(x) !== on && handOf(x) !== keep) ?? null;
  }

  /**
   * Whether a frame about the deal of hand `h` (its commitments, a share the host made for this seat) is one an honest
   * host could send now: it names the hand this client is on (`activeHand`), being dealt or played, or a later one on
   * a link that has brought nothing about that hand yet (the table may have played on while this device had no link,
   * and a returning seat is told about the deal in progress); never another hand that has ended. The hand this client
   * was last asked to commit to or shown (`openHand`) counts whatever came of it: a deal of a hand already played is
   * failed when the table turns to it (`enterHand`), and its frames are then taken as that deal's.
   */
  private dealsHand(h: number): boolean {
    if (h === this.openHand) return true;
    const on = this.activeHand();
    return !this.handsEnded.has(h) && (h === on || (h > on && this.handEpoch !== this.epoch));
  }

  /** Keep `list` (entries of hands, oldest first) to `max` entries without giving up the hand this client is on (`handToDrop`). */
  private trimHands<T>(list: T[], max: number, handOf: (x: T) => number): void {
    while (list.length > max) {
      const drop = this.handToDrop(list, handOf);
      list.splice(drop === null ? 0 : list.indexOf(drop), 1);
    }
  }

  /** The first state of a hand we were never asked to commit to: we arrived after its deal. */
  private noteHand(hand: number): void {
    if (this.firstHand !== null) return;
    this.firstHand = hand;
    if (this.commitHand !== hand && this.standInHand !== hand) this.joinedHand = hand;
  }

  /** The link dropped (or was replaced): a new epoch, and a ceremony under way was not watched whole. */
  private noteLinkLost(): void {
    this.epoch++;
    const rec = this.records[this.records.length - 1];
    if (rec && !rec.dealt) rec.linkLost = true;
  }

  /** The link in use (or the one of `epoch`) ends by this device's own doing, or with its record in doubt (see `ownAbsences`). */
  private noteOwnAbsence(epoch = this.epoch): void {
    if (!this.ownAbsences.includes(epoch)) this.ownAbsences.push(epoch);
    if (this.ownAbsences.length > 16) this.ownAbsences.shift();
  }

  /**
   * The seat was opened on another device: what was played there is not this client's to vouch for,
   * and it stops (the player resumes the table from Home to take the seat back).
   */
  private seatTaken(): void {
    this.noteOwnAbsence();
    this.noteLinkLost();
    // Every hand still under way, whichever record was made last.
    for (const play of this.plays) {
      if (this.handsEnded.has(play.hand)) continue;
      this.closeLedger(play);
      play.ledgerFrom = Number.POSITIVE_INFINITY;
    }
    this.kickedLink = this.link;
    this.update({ connected: false, kicked: true, lastError: 'This seat was opened on another device.' });
  }

  /**
   * The ledger stops vouching for `play` from here on (the seat was opened on another device), but not
   * for the turns before the last state this client was shown while it held the seat: every move before
   * that state was made while this device held the seat (an honest host stops sending to a link once
   * another device takes its seat), so a notice that comes after it cannot excuse one this device never
   * sent. The ledger began vouching in this run of the app, so only states this run saw count.
   */
  private closeLedger(play: PlayRecord): void {
    const from = play.ledgerFrom;
    if (from === null || !Number.isFinite(from) || this.handsEnded.has(play.hand)) return;
    let to = from;
    for (const f of play.seen) if (f.run === this.runId && f.tc > to) to = f.tc;
    if (to <= from) return;
    (play.vouched ??= []).push({ from, to });
    if (play.vouched.length > 8) play.vouched.shift();
  }

  /**
   * The host says, on this client's rejoin, that another device held the seat since its last link
   * (`welcome.elsewhere`): the 'disconnected' that ended that link never arrived. The time between
   * that link and this one was spent elsewhere, and from here on it is as if the notice had come.
   * A server that says so falsely gains no more than one that sends 'disconnected': the client stops.
   */
  private takenElsewhere(): void {
    this.noteOwnAbsence(this.epoch - 1);
    this.seatTaken();
  }

  private recordFor(hand: number): CeremonyRecord | null {
    return this.records.find((r) => r.hand === hand) ?? null;
  }

  private playFor(hand: number): PlayRecord {
    let play = this.plays.find((p) => p.hand === hand);
    if (!play) {
      play = { hand, seen: [], sent: [], ledgerFrom: null };
      this.plays.push(play);
      this.trimHands(this.plays, MAX_HAND_RECORDS, (p) => p.hand);
    }
    return play;
  }

  /** The attempt the host is currently running for `hand`, as this client recorded it. */
  private currentAttempt(hand: number): AttemptRecord | null {
    const rec = this.recordFor(hand);
    return rec?.attempts[rec.attempts.length - 1] ?? null;
  }

  /** The match state hand 0 starts from, derived from the rules exactly as a new game makes it. */
  private anchor(): MatchSnapshot | null {
    const rules = this.pinnedRules ?? this.state.rules;
    if (!rules) return null;
    try {
      return matchSnapshot(newGame('anchor', rules, 0));
    } catch {
      return null;
    }
  }

  /**
   * Where hand `h` must start: where the previous verified hand left the match (advanceMatch of its
   * replay), or, for hand 0 and for the first hand of a match this client watched from the lobby,
   * where a new match starts. Null when this client holds nothing to chain from (it sat down
   * mid-match from a token alone, the previous hand failed its replay, or it missed hands).
   */
  private chainBase(h: number): MatchSnapshot | null {
    if (this.expected) return this.expected;
    if (this.gapHand !== null) return null;
    return this.atStart || h === 0 ? this.anchor() : null;
  }

  /**
   * The table has turned to hand `h` (a commit request, a state or a result for it). Hands follow
   * one another: never one already played, never a new one while the hand this client is on has not
   * ended, and only the hand the last verified one leads to. A jump is honest only when this
   * client's link was down in between (the table plays on without it); then the hands it missed
   * are a gap, noted on this hand's audit, unless the host has shown their records (see `missed`).
   */
  private enterHand(h: number): void {
    if (this.lapse) {
      this.lapse = false;
      // A second restart during the same hand does not make its deal any better watched.
      const before = this.lapseHand === h && this.lapseDeal;
      this.lapseHand = h;
      this.lapseDeal = before || !this.recordFor(h)?.dealt;
    }
    if (this.openHand === h) {
      this.handEpoch = this.epoch;
      return;
    }
    const base = this.chainBase(h);
    if ([...this.handsEnded].some((e) => e >= h)) {
      this.flag(h, 'Host asked to deal a hand that was already played');
      if (this.expected && this.expected.handNumber !== h) this.flag(this.expected.handNumber, 'Host asked to deal a hand that was already played');
    } else if (this.openHand !== null) {
      // The hand this client is on never ended, as far as it has seen.
      this.carryFlags(this.openHand, h);
      if (this.handEpoch === this.epoch) {
        const problem = 'Host started another hand before the one in progress had ended';
        this.flag(h, problem);
        this.failNow(problem);
      } else this.noteGap(h);
    } else if (base?.matchOver) this.flag(h, 'Host dealt another hand after the match was over');
    else if (base ? h !== base.handNumber : this.handsEnded.size > 0 && this.gapHand === null && h !== Math.max(...this.handsEnded) + 1) {
      this.carryFlags(base ? base.handNumber : Math.max(...this.handsEnded) + 1, h);
      if (this.quietSince === this.epoch) this.flag(h, 'Host dealt a hand out of turn');
      else this.noteGap(h);
    } else if (!base && this.noHistory && this.handsEnded.size === 0 && h > 0) {
      // Sat down from a token alone, part-way through the match: nothing this client holds says where this hand should start.
      this.noteGap(h);
    }
    this.noteOpenHand(h);
  }

  /** Hands were played while this client's link was down and it holds no record of them: nothing chains into `h`. */
  private noteGap(h: number): void {
    this.gapHand = h;
    this.chainGap = true;
    this.expected = null;
    this.chainChecked = null;
    this.atStart = false;
  }

  /** What the host did wrong about a hand that will never be audited counts against the hand it moved on to. */
  private carryFlags(from: number, to: number): void {
    if (from === to) return;
    for (const p of this.tamper.get(from) ?? []) this.flag(to, p);
    this.tamper.delete(from);
  }

  /**
   * A hand must start with the scores, dealer, streak, rotations and wind its chain base gives
   * (see `chainBase`); the hand number itself is checked when the table turns to the hand.
   */
  private checkChain(start: MatchSnapshot): void {
    const h = start.handNumber;
    if (this.chainChecked === h) return;
    const e = this.chainBase(h);
    if (!e) return;
    this.chainChecked = h;
    if (e.matchOver || e.handNumber !== h) return;
    const first = this.expected === null;
    const changed = CHAINED_FIELDS.filter((k) => stableStringify(start[k]) !== stableStringify(e[k]));
    if (changed.length > 0) this.flag(h, first ? `The match started with ${changed.join(', ')} different from a new match` : `Hand started with ${changed.join(', ')} different from where the previous hand left them`);
  }

  /** Forget the previous match's verification record (its audits stay on the list). */
  private resetMatch(): void {
    this.secret = null;
    this.commits = null;
    this.commitHand = null;
    this.commitsHand = null;
    this.standInHand = null;
    this.joinedHand = null;
    this.firstHand = null;
    this.handsEnded = new Set();
    this.tamper = new Map();
    this.handStart = null;
    this.records = [];
    this.plays = [];
    this.expected = null;
    this.chainChecked = null;
    this.frozenBots = null;
    this.pinnedRules = null;
    this.pinnedSkill = null;
    this.quietSince = this.epoch;
    this.openHand = null;
    this.handEpoch = -1;
    this.matchEnded = false;
    this.atStart = false;
    this.gapHand = null;
    this.chainGap = false;
    this.missedMoves = false;
    this.rewinds = [];
    this.eraHand = null;
    this.lapse = false;
    this.lapseHand = null;
    this.lapseDeal = false;
    // A new match is played at a new table, whose clock may not be the last one's (each table keeps its own): the
    // era count runs on, so nothing learned of the last table's clock, nor any tie to it, counts in the new match.
    this.era++;
    this.clockBase = { era: this.era, anchor: null, minOffset: null };
    this.bestAnchor = null;
    this.bestPong = null;
    this.lastStamp = null;
    this.ownAbsences = [];
    this.gapVerdicts = [];
    this.state = { ...this.state, matchOver: false, finalScores: null, matchEndVerified: false, matchFailed: false, view: null, lastResult: null, claimsPassedAway: [], turnsShownLate: [] };
  }

  /** This client holds a record of the match being played: there is something a reset would wipe. */
  private hasEvidence(): boolean {
    return this.firstHand !== null || this.handsEnded.size > 0 || this.records.length > 0;
  }

  /** This client is on `hand` now (asked to commit to it, or shown it). */
  private noteOpenHand(hand: number): void {
    this.openHand = hand;
    this.handEpoch = this.epoch;
  }

  /**
   * Whether a `match_over` can be believed. `verified`: the last hand this client verified ends the
   * match with exactly these scores. `unverified`: this client cannot know (it holds no record of
   * the match, or its link was down, the table may have played on without it, and it has no chain
   * of hands to follow: the last hand already failed its audit, or it missed hands whose records
   * it was not shown); the end is shown, but the match stays pinned. `refuse`: the hands this
   * client verified say the match is not over, or not with these scores. That holds after a lost
   * link too: an honest host first sends a returning seat the record of every hand it missed, so
   * a client with a chain to follow has followed it to the end before the `match_over` arrives.
   */
  private matchEndVerdict(scores: unknown[], view: TableView): 'verified' | 'unverified' | 'refuse' {
    const same = (a: unknown[], b: number[]) => a.length === b.length && b.every((x, i) => a[i] === x);
    const e = this.expected;
    const between = this.openHand === null;
    if (e?.matchOver && between) return same(scores, e.scores) && same(view.scores, e.scores) ? 'verified' : 'refuse';
    if (!this.hasEvidence()) return 'unverified';
    if (between ? this.quietSince !== this.epoch : this.handEpoch !== this.epoch) return e || (this.atStart && this.gapHand === null) ? 'refuse' : 'unverified';
    if (!e && between && this.handsEnded.size > 0) {
      // The last hand failed its replay, so nothing chains from it: go by the rules' hand count and the result it showed.
      const v = this.state.view;
      const r = this.state.lastResult;
      const rules = this.pinnedRules ?? this.state.rules;
      const last = Math.max(...this.handsEnded);
      if (v && r && rules && v.handNumber === last && !r.dealerContinues && v.dealerRotations + 1 >= rules.handsPerMatch && same(scores, v.scores)) return 'unverified';
    }
    return 'refuse';
  }

  /** Put a failure on show at once (not waiting for a hand to end), and keep it on the list of audits. */
  private failNow(problem: string): void {
    const last = this.state.lastAudit;
    const failures = this.state.auditStatus === 'failed' ? [...this.state.auditFailures.filter((f) => f !== problem), problem] : [problem];
    let audits = this.state.audits;
    const tail = audits[audits.length - 1];
    if (last && tail && tail === this.liveFailure && tail.audit === last) {
      if (!tail.failures.includes(problem)) tail.failures.push(problem);
    } else if (last) {
      this.liveFailure = { audit: last, status: 'failed', failures: [problem], caveats: [] };
      audits = [...audits, this.liveFailure].slice(-MAX_AUDITS);
    }
    this.update({ auditStatus: 'failed', auditFailures: failures, auditCaveats: [], audits, matchFailed: true, matchEndVerified: false });
  }

  /** The bot seats as listed now; once frozen, any change is the host's doing. */
  private checkBots(seats: SeatInfo[]): void {
    if (this.frozenBots === null || this.state.matchOver) return;
    const bots = seats.filter((s) => isObject(s) && s.isBot === true && isInt(s.seat)).map((s) => s.seat).sort((a, b) => a - b);
    if (bots.join(',') !== this.frozenBots.join(',')) this.flag(this.activeHand(), 'Host changed which seats are bots during the match');
  }

  private onMessage(m: HostMessage): void {
    if (!isObject(m) || typeof m.t !== 'string') return;
    // A link's opening ends at its first frame about the table's play (`opening`).
    if (!OPENING_FRAMES.has(m.t)) this.opening = false;
    switch (m.t) {
      case 'welcome': {
        if (!isInt(m.seat) || m.seat < 0 || m.seat > 3 || typeof m.matchId !== 'string') {
          this.update({ lastError: 'The table sent a malformed welcome.', lastErrorCode: null });
          return;
        }
        const seats = Array.isArray(m.seats) ? m.seats : [];
        // The rejoin token: a welcome that carries none (or an empty one) leaves the one this client holds, as an honest
        // table always gives one and the app keeps the table's record under it. The table's room code is pinned from the
        // first welcome: the app keeps the record under the room it joined, which a welcome does not move.
        const token = typeof m.token === 'string' && m.token !== '' ? m.token : this.state.token;
        const roomCode = this.state.roomCode ?? (typeof m.roomCode === 'string' ? m.roomCode : null);
        // The seat and the match are pinned from the first deal this client hears of until the hands
        // it verified say the match is over. Before that there is nothing a new seat could undo.
        const pinned = this.state.matchId !== null && this.state.seat !== null && this.hasEvidence() && !this.matchEnded;
        if (pinned && (m.matchId !== this.state.matchId || m.seat !== this.state.seat)) {
          // Same table, same match, same token: an honest host returns the same seat in the same match.
          const problem = m.matchId !== this.state.matchId ? 'Host moved this seat into a different match mid-match' : 'Host moved this seat to another seat mid-match';
          this.flag(this.activeHand(), problem);
          this.update({ connected: true, disconnected: false, kicked: false, seats, token, lastError: null });
          // With no hand left to audit, the flag would never be seen.
          if (this.state.matchOver) this.failNow(problem);
          return;
        }
        // A new match at this table (after the last one verifiably ended) starts a fresh record.
        if (this.state.matchId !== null && m.matchId !== this.state.matchId) this.resetMatch();
        const rules = sanitizeRules(m.rules);
        if (this.pinnedRules && stableStringify(rules) !== stableStringify(this.pinnedRules)) this.flag(this.activeHand(), 'Host changed the rules mid-match');
        if (this.state.matchId === null) {
          this.quietSince = this.epoch;
          // Without a token the host seats nobody after the first deal, so this client is in the lobby.
          this.atStart = !this.noHistory;
        }
        this.checkBots(seats);
        // A host that stops saying (an older build after a restart) keeps the strength it had.
        this.tableSkill = isBotSkill(m.botSkill) ? m.botSkill : null;
        // Informative only: a table that leaves it out, or announces more than the protocol's period, is held to that period.
        this.clockMs = isInt(m.clockMs) && m.clockMs > 0 && m.clockMs < CLOCK_FRAME_MS ? m.clockMs : CLOCK_FRAME_MS;
        if (this.tableSkill && isBotSkill(this.pinnedSkill) && this.tableSkill !== this.pinnedSkill && !this.state.matchOver) this.flag(this.activeHand(), 'Host changed how strong its bots are during the match');
        this.update({ connected: true, disconnected: false, kicked: false, seat: m.seat, roomCode, rules: this.pinnedRules ?? rules, seats, matchId: m.matchId, token, lastError: null });
        // A rejoin to a seat another device took in between: the 'disconnected' that said so never came.
        // (The first welcome of a client restored from its record is no rejoin: the restore noted its absence.
        // Nor is a welcome after the first frame of its link: what this device was shown on the link already
        // is not to be excused after the fact, as the time before it would be.)
        if (m.elsewhere === true && this.welcomed && !this.heardOnLink) this.takenElsewhere();
        this.welcomed = true;
        // A welcome that is its link's first frame opens it: a restarted table's notice may follow (`opening`).
        this.opening = !this.heardOnLink;
        return;
      }
      case 'lobby':
        if (Array.isArray(m.seats)) {
          this.checkBots(m.seats);
          this.update({ seats: m.seats });
        }
        return;
      case 'commit_request': {
        if (!isInt(m.handNumber)) return;
        const h = m.handNumber;
        const v = this.state.view;
        if (v && v.handNumber === h && v.phase !== 'ended' && this.state.lastResult === null && this.state.ceremony === 'idle') {
          // A hand with this number is already being played: a fresh ceremony now would be a re-deal.
          this.flag(h, 'Host re-dealt a hand in progress');
          return;
        }
        this.enterHand(h);
        if (this.firstHand === null) this.firstHand = h;
        // The bot seats and the rules are fixed from the match's first deal on.
        if (this.frozenBots === null) this.frozenBots = this.state.seats.filter((s) => s.isBot).map((s) => s.seat).sort((a, b) => a - b);
        if (this.pinnedRules === null && this.state.rules) this.pinnedRules = this.state.rules;
        if (this.pinnedSkill === null) this.pinnedSkill = this.tableSkill ?? 'unpublished';
        let rec = this.recordFor(h);
        const last = rec?.attempts[rec.attempts.length - 1];
        const n = isInt(m.attempt) && m.attempt >= 1 ? m.attempt : (last?.n ?? 0) + 1;
        // A commitment lost with the link never reached the host, which asks for it again when the seat
        // returns. That is harmless as long as this client has not revealed in the attempt: nothing of
        // its share has been seen. After a reveal, the same attempt again would be a second deal.
        const again = !!last && n === last.n && !last.revealed && !last.stoodIn && this.ceremonyEpoch !== this.epoch;
        if (!rec) {
          // Watched from the start only when the first request it hears of is attempt 1.
          rec = { hand: h, attempts: [], fromStart: n === 1, linkLost: false, dealt: false };
          this.records.push(rec);
          this.trimHands(this.records, MAX_HAND_RECORDS, (r) => r.hand);
          if (n !== 1 && !this.noHistory && this.quietSince === this.epoch) this.flag(h, `Host never asked this seat to commit to attempts 1–${n - 1} of this hand`);
        } else if (again) {
          // The same attempt, asked again after a lost link: a fresh secret takes the place of the one that never arrived.
        } else if (last && n <= last.n) this.flag(h, `Host ran attempt ${n} of this hand's deal twice`);
        else if (last && n !== last.n + 1 && this.ceremonyEpoch === this.epoch) this.flag(h, `Host never asked this seat to commit to attempt ${last.n + 1} of this hand`);
        if (again && last) last.committed = true;
        else rec.attempts.push({ n, committed: true, revealed: false, stoodIn: false });
        this.ceremonyEpoch = this.epoch;
        this.secret = makeSecret();
        this.commits = null;
        this.commitsHand = null;
        this.commitHand = h;
        if (this.standInHand === h) this.standInHand = null;
        // Record the commitment before sending it: the host may answer at once.
        this.update({ ceremony: 'committed', standIn: false });
        this.send({ t: 'commit', hash: commitFor(this.secret) });
        return;
      }
      case 'stand_in': {
        if (!isInt(m.handNumber)) return;
        const h = m.handNumber;
        // Only the hand being dealt: a stand-in for any other is the server's own making, and makes no record. (A
        // returning seat is told again between hands about the hand that has just ended: nothing to note.)
        if (!this.dealsHand(h)) {
          if (!this.handsEnded.has(h)) this.flag(this.activeHand(), 'Host sent a frame about a hand or turn this device was not on');
          return;
        }
        const rec = this.recordFor(h);
        const cur = this.currentAttempt(h);
        const n = isInt(m.attempt) && m.attempt >= 1 ? m.attempt : (cur?.n ?? 1);
        // Our secret is kept either way: the audit must still show it was not used.
        if (h === this.commitHand && this.state.ceremony === 'committed' && cur && n === cur.n && !cur.revealed) {
          // While this attempt's commitments are still being collected.
          cur.stoodIn = true;
        } else if (this.standInHand === h && rec?.attempts.some((a) => a.n === n && a.stoodIn)) {
          return; // told again on a rejoin
        } else if (this.ceremonyEpoch !== this.epoch && !this.handsEnded.has(h) && !rec?.dealt && !(cur && n < cur.n) && !rec?.attempts.some((a) => a.n === n && a.revealed)) {
          // Back after a lost link: the host made our share for an attempt we may never have heard of.
          const r = rec ?? { hand: h, attempts: [], fromStart: false, linkLost: true, dealt: false };
          if (!rec) {
            this.records.push(r);
            this.trimHands(this.records, MAX_HAND_RECORDS, (x) => x.hand);
          }
          const at = r.attempts.find((a) => a.n === n);
          if (at) at.stoodIn = true;
          else {
            r.attempts.push({ n, committed: false, revealed: false, stoodIn: true });
            // Commitments we hold belong to an earlier attempt, not to the one this stand-in is for.
            this.commits = null;
            this.commitsHand = null;
          }
          r.attempts.sort((a, b) => a.n - b.n);
        } else return;
        this.standInHand = h;
        this.update({ standIn: true });
        return;
      }
      case 'disconnected':
        // The seat was opened on another device. Moves there are not ours to vouch for.
        this.seatTaken();
        return;
      case 'commits': {
        if (!isInt(m.handNumber)) return;
        const h = m.handNumber;
        if (!isCommitSet(m.commits)) {
          // Never honest, whatever hand it names: it counts against the hand this client is on.
          this.flag(this.activeHand(), 'Host published a malformed set of commitments');
          this.update({ lastError: 'The table sent a malformed set of commitments.' });
          return;
        }
        // Published for the hand being dealt only (a returning seat is sent it again): a set for any other hand is the
        // server's own making, and takes the place of nothing this client holds.
        if (!this.dealsHand(h)) {
          this.flag(this.activeHand(), 'Host sent a frame about a hand or turn this device was not on');
          return;
        }
        if (this.commits && this.commitsHand === h) {
          // Published once per attempt; only a new commit_request opens the next set. An honest host
          // re-sends the same set (to a returning seat); a different one would let it re-pick its
          // own share after seeing ours.
          if (!sameCommitSet(this.commits, m.commits)) this.flag(h, 'Host changed the commitments after publishing them');
          return;
        }
        if (this.secret && this.commitHand === h && this.standInHand !== h) {
          const mine = m.commits.find((c) => c.seat === this.state.seat);
          if (!mine || mine.hash !== commitFor(this.secret)) {
            this.flag(h, 'Host published a different commitment for my seat');
            return;
          }
        }
        this.commits = m.commits;
        this.commitsHand = h;
        return;
      }
      case 'reveal_request': {
        const h = m.handNumber;
        // Stood in, or holding no secret for this hand (we arrived mid-ceremony): nothing to reveal.
        if (this.standInHand === h || !this.secret || this.commitHand !== h) return;
        const attempt = this.currentAttempt(h);
        // This attempt's share went out and the hand has been dealt: an honest host asks for nothing more,
        // and answering would move the time the share was sent, which the deal's fixed point is measured from.
        if (attempt?.revealed && this.recordFor(h)?.dealt) return;
        if (this.commitsHand !== h) {
          // Revealing first would let the host pick its own share after seeing ours.
          this.flag(h, 'Host asked for my secret before publishing all commitments');
          return;
        }
        if (attempt) {
          // The host may hold the share from the first time it went out, and deal from it whenever it likes:
          // asked again, on this link or a new one, this device sends the share again but keeps that first
          // time. A deal that then comes on another link has no fixed point from the share, which is sound.
          if (!(attempt.revealed && typeof attempt.revealedAt === 'number')) {
            attempt.revealedAt = this.now();
            attempt.revealedEpoch = this.epoch;
            attempt.revealedRun = this.runId;
            attempt.revealedSeg = this.seg();
          }
          attempt.revealed = true;
        }
        this.send({ t: 'reveal', secret: this.secret });
        this.update({ ceremony: 'revealed' });
        return;
      }
      case 'state': {
        if (!isView(m.view)) {
          this.update({ lastError: 'The table sent a malformed state.' });
          return;
        }
        const v = m.view;
        const h = v.handNumber;
        if (this.handsEnded.has(h)) {
          // A hand whose result this client holds is over: nothing more is played in it.
          const problem = 'Host went back to a hand that had already ended';
          this.flag(this.activeHand(), problem);
          this.failNow(problem);
          return;
        }
        this.enterHand(h);
        this.noteHand(h);
        const first = !this.state.view || this.state.view.handNumber !== h || this.state.lastResult !== null;
        if (first || !this.handStart || this.handStart.handNumber !== h) {
          this.handStart = snapshotFromView(v);
          this.checkChain(this.handStart);
        }
        const rec = this.recordFor(h);
        if (rec) rec.dealt = true;
        const stamped = this.noteStamp(m.now, true);
        this.noteOrder(m.now, h, v.turnCounter);
        // An honest host sends every turn's state to every seat it has a link to, so a link that
        // stayed up brings every turn: one skipped on it was held back. The first state of a hand
        // is its deal, on a link that was up before the deal (it brought an earlier hand, or this
        // device revealed its share for this hand over it).
        const shownHere = this.linkShown && this.linkShown.epoch === this.epoch ? this.linkShown : null;
        const revealedHere = !!this.recordFor(h)?.attempts.some((x) => x.revealed && x.revealedEpoch === this.epoch);
        if (isInt(v.turnCounter)) {
          if (shownHere && shownHere.hand === h && v.turnCounter > shownHere.tc + 1) this.noteHeld(h, shownHere.tc + 1);
          else if (v.turnCounter > 0 && ((shownHere && shownHere.hand !== h) || (!shownHere && revealedHere))) this.noteHeld(h, 0);
          // An honest host stamps every state. One with no stamp, on a link that has brought a state, a
          // stamp or this device's share, would escape every check of when it was shown: it is not
          // believed, and counts as held back (on a new link it is judged as shown late; see `unstamped`).
          if (!stamped && (shownHere || revealedHere || this.linkStamped)) this.noteHeld(h, v.turnCounter);
        }
        this.noteState(v, m, stamped, shownHere !== null || revealedHere);
        if (isInt(v.turnCounter)) this.linkShown = { epoch: this.epoch, hand: h, tc: v.turnCounter };
        this.viewEpoch = this.epoch;
        this.update({ view: v, stateHash: m.hash, deadline: m.deadline, timeBank: m.timeBank, inTimeBank: m.inTimeBank, lastResult: null, lastError: null, ceremony: 'idle', intermissionDeadline: null });
        return;
      }
      case 'hand_over': {
        if (!isView(m.view) || !isAudit(m.audit) || !isObject(m.result)) {
          this.update({ lastError: 'The table sent a malformed hand result.' });
          return;
        }
        const h = m.audit.handNumber;
        const stampedEnd = this.noteStamp(m.now, true);
        this.noteOrder(m.now, null, null);
        if (this.handsEnded.has(h)) {
          // A returning seat is sent the result again. Whatever this frame carries, the result, view
          // and audit this client verified stay; a frame that differs from them is kept as a failure.
          const prior = this.state.audits.find((a) => a.audit.handNumber === h && a.audit.matchId === this.state.matchId);
          const held = this.state.lastAudit?.handNumber === h && this.state.lastResult !== null && this.state.view !== null;
          let problem: string | null = null;
          if (m.audit.matchId !== this.state.matchId) problem = 'Host re-sent a hand under a different match id';
          else if (prior && stableStringify(prior.audit) !== stableStringify(m.audit)) problem = 'Host sent a different audit for a hand it had already ended';
          else if (held && (stableStringify(m.result) !== stableStringify(this.state.lastResult) || stableStringify(m.view.scores) !== stableStringify(this.state.view!.scores))) problem = 'Host re-sent a different result for a hand it had already ended';
          if (problem === null) {
            if (held) this.update({ deadline: null, intermissionDeadline: nextDeal(m) });
            return;
          }
          // One failed entry per offending hand: a failure already on show for it is folded into this one.
          const live = this.liveFailure && this.liveFailure.audit.handNumber === h ? this.liveFailure : null;
          const failures = [...new Set([...(this.tamper.get(h) ?? []), ...(live?.failures ?? []), problem])];
          const audits = [...this.state.audits.filter((a) => a !== live), { audit: m.audit, status: 'failed' as const, failures, caveats: [] }].slice(-MAX_AUDITS);
          this.liveFailure = null;
          this.update({ auditStatus: 'failed', auditFailures: failures, auditCaveats: [], deadline: null, audits, matchFailed: true, matchEndVerified: false });
          return;
        }
        this.enterHand(h);
        this.noteHand(h);
        const rec = this.recordFor(h);
        if (rec) rec.dealt = true;
        // A hand that ended at the deal sends no state first: check where it started from its end.
        if (!this.handStart || this.handStart.handNumber !== h) this.checkChain(snapshotFromView(m.view, true));
        this.handsEnded.add(h);
        if (this.openHand === h) this.openHand = null;
        this.atStart = false;
        const end: SeenState = { tc: Number.POSITIVE_INFINITY, epoch: this.epoch, era: this.era, at: this.now(), now: typeof m.now === 'number' && Number.isFinite(m.now) ? m.now : undefined, run: this.runId, seg: this.seg(), owes: false, deadline: null, timeBank: 0, inBank: false, hash: '', ...(stampedEnd ? { atLo: stampedEnd.atLo, ref: stampedEnd.ref, wref: stampedEnd.wref, live: stampedEnd.live, seg: stampedEnd.seg } : {}) };
        const { check, replayed, anchors, passed, late } = this.runAudit(m.audit, m.view, m.result, end);
        this.clockBase = foldClock(this.clockBase, this.era, { run: this.runId, seg: this.seg() }, this.plays.find((p) => p.hand === h) ?? null, end, anchors);
        // The strongest fixed point of this era, run of the app and run of this device's clock, for the
        // hands after this one: each worth no more than its round trip allows against the least arrival
        // offset known now (see `fixedPoint`), and kept with its round trip to be capped again later.
        // The pongs are weighed as they are used, each less `DRIFT_RATE` for every ms since it was taken:
        // on a phone whose clock runs a little slow the oldest answer has the highest figure of its own,
        // and kept for hours it would make the first turns of a hand look late to the Fair play count.
        {
          const seg = this.seg();
          const at = this.now();
          const ref = this.refAt(at);
          const strongest = (best: LateScope['best'], points: ClockAnchor[], aged: boolean): LateScope['best'] => {
            const worth = (b: NonNullable<LateScope['best']>) => b.value - (aged ? DRIFT_RATE * Math.max(0, at - b.at) : 0);
            let out = best && best.era === this.era && best.seg === seg ? best : null;
            for (const k of points) {
              if (k.era !== this.era || k.run !== this.runId || (k.seg ?? 0) !== seg) continue;
              const b = { era: this.era, run: this.runId, seg, value: fixedPoint(k, ref), at: k.at, ...(typeof k.fat === 'number' ? { rtt: k.fat - k.at } : {}) };
              if (!out || worth(b) > worth(out)) out = b;
            }
            return out;
          };
          this.bestAnchor = strongest(this.bestAnchor, anchors, false);
          this.bestPong = strongest(this.bestPong, this.plays.find((p) => p.hand === h)?.pongs ?? [], true);
        }
        if (typeof end.now === 'number') this.lastStamp = { at: end.at, now: end.now, epoch: this.epoch, era: this.era };
        const { status, failures, caveats } = check;
        // The next hand must start where this one, as replayed, left the match.
        this.expected = replayed && hashState(replayed) === m.audit.finalHash ? nextHand(replayed) : null;
        this.chainChecked = null;
        this.quietSince = this.epoch;
        this.tamper.delete(h);
        if (this.gapHand === h) this.gapHand = null;
        const audits = [...this.state.audits, { audit: m.audit, status, failures, caveats }].slice(-MAX_AUDITS);
        this.update({ view: m.view, lastResult: m.result, lastAudit: m.audit, auditStatus: status, auditFailures: failures, auditCaveats: caveats, deadline: null, intermissionDeadline: nextDeal(m), audits, claimsPassedAway: withPassed(this.state.claimsPassedAway, h, passed), turnsShownLate: withLateTurns(this.state.turnsShownLate, h, late), ...(status === 'failed' ? { matchFailed: true } : {}) });
        return;
      }
      case 'hand_missed':
        if (isAudit(m.audit)) this.auditMissed(m.audit);
        return;
      case 'restored': {
        if (!isInt(m.handNumber) || !isInt(m.turnCounter) || m.turnCounter < -1) return;
        // Once per link, in its opening only: anywhere else a notice is the server's own making, and changes nothing.
        const opening = this.opening;
        this.opening = false;
        if (!opening) {
          this.flag(this.activeHand(), 'Host said it restarted, but not as its first word when this device joined again');
          return;
        }
        this.noteRestore(m.handNumber, m.turnCounter);
        return;
      }
      case 'match_over':
        if (!isView(m.view) || !Array.isArray(m.scores)) {
          this.update({ lastError: 'The table sent a malformed match result.' });
          return;
        }
        {
          const verdict = this.matchEndVerdict(m.scores, m.view);
          if (verdict === 'refuse') {
            // Never taken on trust: a false end would unpin the match and let the next welcome wipe the record.
            const problem = 'Host announced the end of the match, which the hands this device verified do not support';
            this.flag(this.activeHand(), problem);
            this.failNow(problem);
            this.update({ lastError: 'The table announced the end of the match, but the hands this device checked do not support it.', lastErrorCode: null });
            return;
          }
          if (verdict === 'verified') this.matchEnded = true;
          // No hand is left to carry what was flagged since the last audit: put it on show now.
          for (const p of this.tamper.get(this.activeHand()) ?? []) this.failNow(p);
          // The end itself is checked (and frees the record for a new match), but scores that rest on a hand whose start
          // could not be checked, or that a hand this device caught the table out in led to, are not shown as verified.
          const matchEndVerified = this.matchEnded && !this.chainGap && !this.missedMoves && !this.state.matchFailed;
          // The last hand's verified view stays on show; the host's is used only when this device holds none.
          const own = this.state.view;
          const view = own && this.state.lastResult !== null && own.handNumber === m.view.handNumber ? own : m.view;
          this.update({ view, matchOver: true, finalScores: m.scores.slice(), matchEndVerified, deadline: null, intermissionDeadline: null });
        }
        return;
      case 'chat':
        if (typeof m.text !== 'string') return;
        this.update({ chat: [...this.state.chat.slice(-99), { seat: m.seat, name: m.name, text: m.text, at: this.now() }] });
        return;
      case 'emote':
        if (typeof m.emote !== 'string') return;
        this.update({ emotes: [...this.state.emotes.slice(-20), { seat: m.seat, emote: m.emote, at: this.now() }] });
        return;
      case 'error':
        this.noteRefusal(m);
        this.update({ lastError: typeof m.message === 'string' ? m.message : 'The table reported an error.', lastErrorCode: typeof m.code === 'string' ? m.code : null });
        return;
      case 'pong':
        // On a link that has brought no state, a pong's stamp does not feed the watch: an honest host sends
        // the state first. As a fixed point it counts on any link (`notePong`).
        if (this.stateHere()) {
          this.noteStamp(m.now);
          this.noteOrder(m.now, null, null);
        }
        this.notePong(m.at, m.now);
        return;
      case 'clock': {
        if (!isInt(m.hand) || !isInt(m.tc)) return;
        // Nor a clock frame: an honest host sends one only to a seat it has sent the turn's state.
        if (!this.stateHere()) return;
        const shown = this.linkShown as NonNullable<TableClient['linkShown']>;
        // It names the turn whose state it last sent this link (`TableHost.sendClockFrames`): that turn, or a later one of
        // the same hand when it held that turn's state back. Any other hand or turn is the server's own making: the hand
        // this client is on fails, and nothing of the frame is taken (no record of another hand, no stamp, no order).
        if (m.hand !== shown.hand || m.tc < shown.tc) {
          this.flag(this.activeHand(), 'Host sent a frame about a hand or turn this device was not on');
          return;
        }
        this.noteStamp(m.now);
        this.noteOrder(m.now, m.hand, m.tc);
        // A turn this link was never shown the state of: the host sent that state and held it back.
        if (m.tc > shown.tc) this.noteHeld(m.hand, shown.tc + 1);
        return;
      }
      default:
        return;
    }
  }

  /**
   * One WebSocket is one ordered stream, and an honest host's stamps never go back (`TableHost.stamp`),
   * so its frames arrive in the order of their stamps. A frame of hand `hand` at turn `tc` that
   * arrives after one stamped later than it (beyond `ORDER_SLACK_MS`) was held back by the host:
   * this is what catches a state held back while the stamps of the frames sent past it run slow, a
   * delay the watch's reference may take in (`watchRefAt`). It only keeps the order: it does not feed
   * the link watch, which measures the stamps against this device's clock instead (`noteStamp`,
   * `checkLink`), so a stamp that moves on by a millisecond does not count as hearing from the table.
   */
  private noteOrder(now: unknown, hand: number | null, tc: number | null): void {
    if (typeof now !== 'number' || !Number.isFinite(now)) return;
    const last = this.linkStamp;
    const same = last !== null && last.epoch === this.epoch && last.era === this.era;
    if (same && now < last.now - ORDER_SLACK_MS && hand !== null && tc !== null && isInt(tc)) this.noteHeld(hand, tc);
    if (!same || now > last.now) this.linkStamp = { epoch: this.epoch, era: this.era, now };
  }

  /** The host held back the state of turn `tc` of hand `hand` (or of an earlier turn already noted). */
  private noteHeld(hand: number, tc: number): void {
    if (this.handsEnded.has(hand)) return;
    const play = this.playFor(hand);
    play.held = Math.min(play.held ?? Number.POSITIVE_INFINITY, tc);
  }

  /** Record a state frame of the hand being played: its hash, timing and whether we owed a move. */
  private noteState(v: TableView, m: Extract<HostMessage, { t: 'state' }>, stamped: { at: number; atLo: number; ref: number | null; wref: number | null; live: boolean; working: boolean; seg: number } | null = null, onLink = false): void {
    if (!isInt(v.turnCounter) || typeof m.hash !== 'string') return;
    const play = this.playFor(v.handNumber);
    // (A state restored damaged may hold any hash, `cleanSeen`: it is not compared.)
    const prior = play.seen.find((s) => s.tc === v.turnCounter && s.kept !== false);
    if (prior && prior.hash !== m.hash) this.flag(v.handNumber, `Host showed two different states for turn ${v.turnCounter}`);
    // From here on this client watched the hand, so every move credited to its player must be one it sent.
    if (play.ledgerFrom === null || (play.ledgerFrom === Number.POSITIVE_INFINITY && !this.state.kicked)) play.ledgerFrom = v.turnCounter;
    const me = this.state.seat;
    let owes = false;
    if (me !== null) {
      try {
        owes = legalActions(viewToState(v), me).length > 0;
      } catch {
        owes = false;
      }
    }
    const at = this.now();
    // Kept as figures a saved record holds as they are: a stamp that is no reading of a clock is no stamp (as `noteStamp` takes it).
    const now = typeof m.now === 'number' && Number.isFinite(m.now) ? m.now : undefined;
    // The hand's first frame over a later link than the last frame before it: the hand began without this device.
    if (play.before === undefined) play.before = play.seen.length === 0 && this.lastStamp && this.lastStamp.epoch !== this.epoch ? { ...this.lastStamp } : null;
    if (now !== undefined) this.lastStamp = { at, now, epoch: this.epoch, era: this.era };
    play.seen.push({
      tc: v.turnCounter,
      epoch: this.epoch,
      era: this.era,
      at,
      now,
      ...(stamped ? { atLo: stamped.atLo, ref: stamped.ref, wref: stamped.wref, live: stamped.live, working: stamped.working, seg: stamped.seg } : {}),
      run: this.runId,
      onLink,
      owes,
      deadline: typeof m.deadline === 'number' ? finiteFigure(m.deadline) : null,
      timeBank: typeof m.timeBank === 'number' ? (finiteFigure(m.timeBank) ?? 0) : 0,
      inBank: m.inTimeBank === true,
      hash: m.hash,
    });
    keepSeen(play);
  }

  /**
   * The host says it was restored from a snapshot (the server restarted) and resumed hand `h` at
   * turn `r`, or before its deal (-1). A snapshot is written a moment after the fact, so the
   * players may have been shown turns it does not hold; those are played again. This client drops
   * what it was shown beyond `r`, but only what reached it over an earlier link (a restart drops
   * every link) and only once per hand: anything else is a rewind and fails as before. A hand
   * with turns undone this way can only be `partial`. A hand whose result this client holds stays
   * ended whatever the notice says.
   *
   * The notice comes only in a returning link's opening (`opening`), and names the hand this client is on
   * (`activeHand`) or, when the table played on while this device had no link, a later one (at -1, the next hand
   * to be dealt, when the restored table was between hands): a hand before that is the server's own making. A
   * restarted table may keep time anew, so a notice begins a new clock era, once per hand on show (`eraHand`): a
   * second notice, for another hand, while the same hand is on show is a second restart.
   */
  private noteRestore(h: number, r: number): void {
    if (this.handsEnded.has(h)) return;
    const on = this.activeHand();
    const known = this.rewinds.find((x) => x.hand === h);
    if (known) {
      // Every rejoin during the hand brings the same notice again; a different one is a second restart.
      if (known.tc !== r) this.flag(on, 'Host said it restarted this hand more than once');
      return;
    }
    if (h < on) {
      this.flag(on, 'Host sent a frame about a hand or turn this device was not on');
      return;
    }
    if (this.eraHand === on) {
      this.flag(on, 'Host said it restarted this hand more than once');
      return;
    }
    const play = this.plays.find((p) => p.hand === h);
    const rec = this.recordFor(h);
    const fresh = (epoch: number) => epoch >= this.epoch;
    let undone = false;
    if (r >= 0) {
      if (play) {
        if (play.seen.some((f) => f.tc > r && fresh(f.epoch))) return;
        const kept = play.seen.filter((f) => f.tc <= r);
        undone = kept.length !== play.seen.length;
        play.seen = kept;
        // Moves made on the turns undone are gone with them, and the turns played again may be another device's.
        play.sent = play.sent.filter((x) => x.tc < r || fresh(x.epoch));
        if (play.vouched) play.vouched = play.vouched.map((v) => ({ from: v.from, to: Math.min(v.to, r) })).filter((v) => v.to > v.from);
        if (play.refusals) play.refusals = play.refusals.filter((x) => x.at <= r);
      }
    } else {
      // Back to before the deal: the attempts this client saw, and any play, are void.
      if ((play && play.seen.some((f) => fresh(f.epoch))) || (this.commitHand === h && this.ceremonyEpoch === this.epoch)) return;
      undone = (rec !== null && rec.attempts.length > 0) || (play !== undefined && play.seen.length > 0);
      if (rec) {
        rec.attempts = [];
        rec.linkLost = true;
        rec.dealt = false;
      }
      this.plays = this.plays.filter((p) => p.hand !== h);
      if (this.commitHand === h) {
        this.commitHand = null;
        this.secret = null;
      }
      if (this.commitsHand === h) {
        this.commits = null;
        this.commitsHand = null;
      }
      if (this.standInHand === h) this.standInHand = null;
      if (this.handStart?.handNumber === h) this.handStart = null;
      if (this.chainChecked === h) this.chainChecked = null;
      if (this.state.view?.handNumber === h && this.state.lastResult === null) this.update({ view: null, stateHash: null, deadline: null, intermissionDeadline: null, ceremony: 'idle', standIn: false });
    }
    // The host that restarted may keep time afresh: what was learned about its clock stops here.
    this.era++;
    this.eraHand = on;
    this.rewinds.push({ hand: h, tc: r, undone });
    this.trimHands(this.rewinds, MAX_REWINDS, (x) => x.hand);
  }

  /** The host refused a move: mark it in the ledger so the audit does not expect it in the log. */
  private noteRefusal(m: Extract<HostMessage, { t: 'error' }>): void {
    const code = typeof m.code === 'string' ? m.code : 'error';
    if (!['illegal', 'not_playing', 'wrong_seat', 'not_seated'].includes(code)) return;
    // A refusal answers a move this seat made in the hand being played, the one on show (`act` files each move
    // under it), never the hand of whichever record was made last.
    const v = this.state.view;
    const play = v && !this.handsEnded.has(v.handNumber) ? this.plays.find((p) => p.hand === v.handNumber) : undefined;
    if (!play || !v) return;
    const open = play.sent.filter((s) => !s.rejected && (!isInt(m.turnCounter) || s.tc === m.turnCounter));
    const target = open[open.length - 1];
    // Every state the host reached before it refused has arrived before the refusal (frames come in order).
    const at = isInt(v.turnCounter) ? v.turnCounter : undefined;
    if (target) {
      target.rejected = code;
      target.refusedAt = at;
    }
    // Only a refusal of a move made in this hand counts here (a stray answer to an older hand's move does not).
    if (target && isInt(m.turnCounter) && at !== undefined) {
      play.refusals = [...(play.refusals ?? []), { tc: m.turnCounter, at }].slice(-MAX_SENT);
    }
  }

  /**
   * The audit of a hand that ended while this client's link was down. It is checked as far as a
   * device that was not there can check it: the shares and the seed, a replay from where the last
   * verified hand left the match, the ceremony accounting, and whatever this client did see of the
   * hand before it left (its own reveal, the states it was shown, the moves it sent). A hand that
   * passes is `partial` (this device did not watch it) and the next hand chains onto it; one that
   * fails also fails the hand now on the table. The host cannot use this path for a hand this
   * client watched over an unbroken link.
   */
  private auditMissed(audit: Audit): void {
    const h = audit.handNumber;
    const rules = this.pinnedRules ?? this.state.rules;
    if (!rules || !this.state.matchId) return;
    if (audit.matchId !== this.state.matchId) {
      this.flag(this.activeHand(), 'Host sent the record of a hand from a different match');
      return;
    }
    if (this.handsEnded.has(h)) {
      const prior = this.state.audits.find((a) => a.audit.handNumber === h && a.audit.matchId === this.state.matchId);
      if (prior && stableStringify(prior.audit) !== stableStringify(audit)) {
        const problem = 'Host sent a different audit for a hand it had already ended';
        this.flag(this.activeHand(), problem);
        this.update({ audits: [...this.state.audits, { audit, status: 'failed' as const, failures: [problem], caveats: [] }].slice(-MAX_AUDITS), matchFailed: true, matchEndVerified: false });
      }
      return;
    }
    const base = this.chainBase(h);
    // Nothing to chain from: the hands in between stay a gap, noted on the next hand this client sees.
    if (!base) return;
    if (base.matchOver || base.handNumber !== h) {
      this.flag(this.activeHand(), 'The record of the hands this device missed does not follow from the last hand it verified');
      return;
    }
    const away = this.openHand === null ? this.quietSince !== this.epoch : this.handEpoch !== this.epoch;
    if (!away) {
      const problem = 'Host reported a hand as missed although this device was connected throughout';
      this.flag(h, problem);
      this.failNow(problem);
      return;
    }
    const failures: string[] = [...(this.tamper.get(h) ?? [])];
    const caveats: string[] = [AUDIT_CAVEATS.away];
    const notes: ReplayNotes = { tableMoved: false };
    // A hand this device saw nothing of is judged from the last frame it held before it went away.
    const unseen: PlayRecord | undefined = this.lastStamp ? { hand: h, seen: [], sent: [], ledgerFrom: null, before: { ...this.lastStamp } } : undefined;
    const me = this.state.seat;
    const { commitsOk, revealsOk } = this.checkShareSets(audit, failures);
    this.checkSeed(audit, commitsOk && revealsOk, failures);
    // This client's own share counts only when it revealed in the attempt that was dealt: after
    // any other attempt an honest host stands the absent seat in.
    const rec = this.recordFor(h);
    const last = rec?.attempts[rec.attempts.length - 1];
    if (last && last.n === audit.ceremonyAttempts && this.commitHand === h) {
      if (last.committed && last.revealed && !last.stoodIn && this.secret) {
        const mine = commitsOk ? audit.commits.find((c) => c.seat === me) : undefined;
        if (!mine || mine.hash !== commitFor(this.secret)) failures.push('Host altered my commitment');
        const myReveal = revealsOk ? audit.reveals.find((r) => r.seat === me) : undefined;
        if (!myReveal || myReveal.secret !== this.secret) failures.push('Host altered my secret');
      }
      if (this.commits && this.commitsHand === h) {
        for (const c of this.commits) {
          const a = commitsOk ? audit.commits.find((x) => x.seat === c.seat) : undefined;
          if (!a || a.hash !== c.hash) failures.push(`Commitment for seat ${c.seat} changed after the fact`);
        }
      }
    }
    let replayed: GameState | null = null;
    const end: SeenState = { tc: Number.POSITIVE_INFINITY, epoch: this.epoch, era: this.era, at: this.now(), run: this.runId, seg: this.seg(), owes: false, deadline: null, timeBank: 0, inBank: false, hash: '' };
    if (me !== null && Array.isArray(audit.log) && audit.log.some((e) => isObject(e) && e.seat === me)) this.missedMoves = true;
    try {
      replayed = this.replayChecked(base, audit.seed, rules, audit.log, h, end, failures, [], notes, unseen);
      if (hashState(replayed) !== audit.finalHash) failures.push('Replaying the action log does not reproduce the final state');
    } catch (e) {
      failures.push(`Replay failed: ${(e as Error).message}`);
    }
    failures.push(...this.checkAccounting(audit));
    if (isInt(audit.ceremonyAttempts) && audit.ceremonyAttempts > 1) caveats.push(AUDIT_CAVEATS.restarted);
    caveats.push(...tableMoveCaveats(notes));
    if (notes.lateShown) caveats.push(AUDIT_CAVEATS.lateShown);
    if (notes.appClock) caveats.push(AUDIT_CAVEATS.appClock);
    if (notes.skillUnknown) caveats.push(AUDIT_CAVEATS.skillUnknown);
    if (notes.damaged) caveats.push(AUDIT_CAVEATS.damaged);
    if (notes.overflow) caveats.push(AUDIT_CAVEATS.overflow);
    if (notes.inFlight) caveats.push(AUDIT_CAVEATS.inFlight);
    if (notes.noAnswer) caveats.push(AUDIT_CAVEATS.noAnswer);
    const status: AuditStatus = failures.length > 0 ? 'failed' : 'partial';
    this.handsEnded.add(h);
    if (this.openHand === h) this.openHand = null;
    this.atStart = false;
    this.expected = replayed && hashState(replayed) === audit.finalHash ? nextHand(replayed) : null;
    this.chainChecked = null;
    this.tamper.delete(h);
    // A record that fails is the host's doing now, not then: the hand on the table carries it too.
    if (status === 'failed') this.flag(this.activeHand(), `The record of hand ${h + 1}, played while this device was away, failed its checks`);
    this.update({ audits: [...this.state.audits, { audit, status, failures, caveats }].slice(-MAX_AUDITS), claimsPassedAway: withPassed(this.state.claimsPassedAway, h, notes.passedClaims ?? []), turnsShownLate: withLateTurns(this.state.turnsShownLate, h, { turns: notes.lateTurns ?? [], of: notes.turnsMeasured ?? 0 }), ...(status === 'failed' ? { matchFailed: true } : {}) });
  }

  /** Exactly one commitment and one secret per seat 0–4: an extra share would let the host move the seed. */
  private checkShareSets(audit: Audit, failures: string[]): { commitsOk: boolean; revealsOk: boolean } {
    const commitsOk = isCommitSet(audit.commits);
    const revealsOk = isRevealSet(audit.reveals);
    if (!commitsOk) failures.push('Audit must list exactly one commitment for each of seats 0–4');
    if (!revealsOk) failures.push('Audit must list exactly one secret for each of seats 0–4');
    return { commitsOk, revealsOk };
  }

  /** Every secret matches its commitment, and the seed is derived from them under this match's id. */
  private checkSeed(audit: Audit, setsOk: boolean, failures: string[]): void {
    if (setsOk) {
      const rv = verifyReveals(audit.commits, audit.reveals);
      if (!rv.ok) failures.push(`Reveals do not match commitments for seats ${rv.badSeats.join(', ')}`);
      let seed: string | null = null;
      try {
        seed = deriveSeed(`${this.state.matchId}:${audit.handNumber}`, audit.reveals);
      } catch {
        seed = null;
      }
      if (seed !== audit.seed) failures.push('Seed was not derived from the revealed secrets');
    }
    if (audit.rngVersion !== WALL_RNG_VERSION) failures.push(`Unknown shuffle construction ${audit.rngVersion}`);
  }

  /**
   * Verify a hand audit against what this client saw: misbehaviour recorded during the hand, whether
   * we took part in the deal, our own share, the commitments we were shown, the reveals, the seed,
   * a replay of the log against our own moves and the states we were shown, and the ceremony
   * accounting.
   */
  verifyAudit(audit: Audit, finalView: TableView, announced?: HandResult): AuditCheck {
    return this.runAudit(audit, finalView, announced, null).check;
  }

  /** verifyAudit, plus the replayed final state when the replay ran (to chain the next hand onto). */
  private runAudit(audit: Audit, finalView: TableView, announced: HandResult | undefined, end: SeenState | null): { check: AuditCheck; replayed: GameState | null; anchors: ClockAnchor[]; passed: Array<{ turn: number; claim: PassedClaim; late?: boolean }>; late: { turns: number[]; of: number } } {
    const failures: string[] = [];
    const caveats: string[] = [];
    let replayed: GameState | null = null;
    const anchors: ClockAnchor[] = [];
    const notes: ReplayNotes = { tableMoved: false };
    const rules = this.pinnedRules ?? this.state.rules;
    const none = { turns: [], of: 0 };
    if (!rules || !this.state.matchId) return { check: { status: 'unverified', failures: ['No match context'], caveats }, replayed, anchors, passed: [], late: none };
    if (!isAudit(audit) || !isView(finalView)) return { check: { status: 'failed', failures: ['The audit is malformed'], caveats }, replayed, anchors, passed: [], late: none };
    const h = audit.handNumber;
    const me = this.state.seat;

    // 1. Anything the host did wrong while the hand was under way, and an audit for some other match.
    failures.push(...(this.tamper.get(h) ?? []));
    if (audit.matchId !== this.state.matchId) failures.push('The audit is for a different match than the one this seat is in');

    // 2. Exactly one commitment and one secret per seat 0–4.
    const { commitsOk, revealsOk } = this.checkShareSets(audit, failures);

    // 3. Participation: we committed, or the host told us it made our share.
    const stoodIn = this.standInHand === h;
    // A record restored after an app restart may lack the last thing the app did: if it holds no
    // note of the attempt that was dealt, this client cannot say whether its share was used.
    const rec = this.recordFor(h);
    const forgot = this.lapseHand === h && !stoodIn && !rec?.attempts.some((a) => a.n === audit.ceremonyAttempts);
    const tookPart = (this.commitHand === h && !forgot) || stoodIn;
    const joined = !tookPart && this.joinedHand === h;
    if (joined) caveats.push(AUDIT_CAVEATS.joined);
    else if (forgot) caveats.push(AUDIT_CAVEATS.appRestart);
    else if (!tookPart) failures.push('Host never asked this seat to commit');

    // 4. Our own share.
    if (tookPart && stoodIn) caveats.push(AUDIT_CAVEATS.standIn);
    else if (tookPart && this.secret) {
      const mine = commitsOk ? audit.commits.find((c) => c.seat === me) : undefined;
      if (!mine || mine.hash !== commitFor(this.secret)) failures.push('Host altered my commitment');
      const myReveal = revealsOk ? audit.reveals.find((r) => r.seat === me) : undefined;
      if (!myReveal || myReveal.secret !== this.secret) failures.push('Host altered my secret');
    }

    // 5. The commitments we were shown before revealing (only our own share depended on them).
    if (forgot) {
      // Whatever set this client holds belongs to an attempt before the one that was dealt.
    } else if (this.commits && this.commitsHand === h) {
      for (const c of this.commits) {
        const a = commitsOk ? audit.commits.find((x) => x.seat === c.seat) : undefined;
        if (!a || a.hash !== c.hash) failures.push(`Commitment for seat ${c.seat} changed after the fact`);
      }
    } else if (tookPart && !stoodIn) {
      if (this.lapseHand === h) caveats.push(AUDIT_CAVEATS.appRestart);
      else failures.push('The commitments for this hand never arrived');
    }

    // 6. Reveals, seed and replay.
    this.checkSeed(audit, commitsOk && revealsOk, failures);
    const start = this.handStart && this.handStart.handNumber === h ? this.handStart : snapshotFromView(finalView, true);
    // The deal used this device's secret, so the hand's first frame was made after the secret was sent.
    const mySecret = revealsOk ? audit.reveals.find((r) => r.seat === me)?.secret : undefined;
    const deal = tookPart && !stoodIn && mySecret === this.secret ? this.dealFixed(h) : null;
    if (deal) anchors.push(deal);
    try {
      replayed = this.replayChecked(start, audit.seed, rules, audit.log, h, end, failures, anchors, notes);
      if (hashState(replayed) !== audit.finalHash) failures.push('Replaying the action log does not reproduce the final state');
      // The result and scores the host announced must be the ones the replay produces.
      if (announced && stableStringify(replayed.result) !== stableStringify(announced)) failures.push('Announced result differs from the replayed hand');
      if (replayed.scores.join(',') !== finalView.scores.join(',')) failures.push('Announced scores differ from the replayed hand');
      // The replayed state must agree with everything we were shown about our own seat.
      if (me !== null && finalView.players[me]?.hand) {
        const mine = replayed.players[me].hand.slice().sort((a, b) => a - b).join(',');
        const shown = finalView.players[me].hand!.slice().sort((a, b) => a - b).join(',');
        if (mine !== shown) failures.push('My final hand differs from the replay');
      }
    } catch (e) {
      failures.push(`Replay failed: ${(e as Error).message}`);
    }

    // 7. Ceremony accounting: restarts must be the ones an honest table could produce.
    failures.push(...this.checkAccounting(audit));

    // 8. Green only for a deal this device watched whole, in one attempt, over one unbroken link.
    if (isInt(audit.ceremonyAttempts) && audit.ceremonyAttempts > 1) caveats.push(AUDIT_CAVEATS.restarted);
    if (rec?.linkLost) caveats.push(AUDIT_CAVEATS.linkLost);
    else if (tookPart && !stoodIn && rec && !rec.fromStart) caveats.push(AUDIT_CAVEATS.missedAttempts);
    if (this.gapHand === h) caveats.push(AUDIT_CAVEATS.gap);
    if (this.rewinds.some((x) => x.hand === h && x.undone)) caveats.push(AUDIT_CAVEATS.serverRestart);
    caveats.push(...tableMoveCaveats(notes));
    if (notes.restartClock) caveats.push(AUDIT_CAVEATS.restartClock);
    if (notes.appClock) caveats.push(AUDIT_CAVEATS.appClock);
    if (notes.lateShown) caveats.push(AUDIT_CAVEATS.lateShown);
    if (notes.skillUnknown) caveats.push(AUDIT_CAVEATS.skillUnknown);
    if (notes.damaged) caveats.push(AUDIT_CAVEATS.damaged);
    if (notes.overflow) caveats.push(AUDIT_CAVEATS.overflow);
    if (notes.inFlight) caveats.push(AUDIT_CAVEATS.inFlight);
    if (notes.noAnswer) caveats.push(AUDIT_CAVEATS.noAnswer);
    // An app restart around the deal: this device cannot say it watched all of it, whatever its record now shows.
    // (A seat that joined mid-hand has already said it took no part in the deal.)
    if (this.lapseHand === h && this.lapseDeal && !joined && !caveats.includes(AUDIT_CAVEATS.appRestart)) caveats.push(AUDIT_CAVEATS.appRestart);

    const status: AuditStatus = failures.length > 0 ? 'failed' : caveats.length > 0 ? 'partial' : 'ok';
    return { check: { status, failures, caveats }, replayed, anchors, passed: notes.passedClaims ?? [], late: { turns: notes.lateTurns ?? [], of: notes.turnsMeasured ?? 0 } };
  }

  /**
   * Replay the hand, checking along the way every state hash this client was shown and every entry
   * the log puts on this seat: a move credited to the player must be one this client sent (and
   * not refused), a move the table made for the seat must come after its clock ran out, with the
   * link up or down (`judgeTableMove`), and never pass up a win (the table's own play always takes
   * one). A move this client sent must not have been refused while it was legal, nor left lying
   * until the clock ran out. `notes.tableMoved` is set when the table rightly played for the seat
   * while its link was down; `unseen` stands in for the record of a hand this device saw nothing of.
   */
  private replayChecked(start: MatchSnapshot, seed: string, rules: RuleSet, log: LoggedAction[], h: number, end: SeenState | null, failures: string[], anchors: ClockAnchor[] = [], notes?: ReplayNotes, unseen?: PlayRecord): GameState {
    const me = this.state.seat;
    const play = end ? (this.plays.find((p) => p.hand === h) ?? unseen ?? null) : null;
    /** The hand is one this device saw nothing of (`hand_missed`). */
    const missed = unseen !== undefined && play === unseen;
    const shown = new Map<number, string>();
    // A state restored damaged (`cleanSeen`: its check figure did not match) may hold any hash: it is not compared.
    for (const s of play?.seen ?? []) if (!shown.has(s.tc) && s.kept !== false) shown.set(s.tc, s.hash);
    /** Some state of this hand was restored damaged: a clock check that may rest on it fails nothing, it makes the hand amber. */
    const doubt = play?.seen.some((f) => f.kept === false) === true;
    // Not every state the table sent in this hand was kept: what was dropped cannot be checked.
    if (play?.overflow === true && notes) notes.overflow = true;
    const checkHash = (s: GameState) => {
      const want = shown.get(s.turnCounter);
      if (want !== undefined && hashState(s) !== want) failures.push(`The state this seat was shown at turn ${s.turnCounter} is not in the replay`);
      shown.delete(s.turnCounter);
    };
    const sent = (play?.sent ?? []).map((x) => ({ ...x, used: false }));
    const problems = new Set<string>();
    // The host refuses only what is not legal in the state it is in. Each refusal names the turn
    // the move was made on; it is excused by one move this client sent on that turn that was not
    // legal in the state the host's own frames showed when the refusal arrived.
    const checkRefusals = (s: GameState) => {
      if (!play || me === null) return;
      const here = (play.refusals ?? []).filter((r) => r.at === s.turnCounter);
      for (const tc of new Set(here.map((r) => r.tc))) {
        const excused = sent.filter((x) => x.tc === tc && !legalFor(s, me, x.action)).length;
        if (here.filter((r) => r.tc === tc).length > excused) problems.add(`The host refused a legal move this seat made (turn ${s.turnCounter})`);
      }
    };
    /** The first frame this client got after turn `n` was played (the hand's result if none). */
    const frameAfter = (n: number): SeenState | null => play?.seen.find((f) => f.tc > n) ?? end;
    // The table's own moves follow a published rule (`tableRule`): every one is recomputed on the
    // state before it. A bot's move must be its bot's; a move the table made for this seat must be
    // the one for a seat out of time (or, in a stretch this device left on purpose, a bot's); one it
    // made for another player may be either. A host that did not say how strong its bots are
    // cannot be checked, so a hand in which it made such a move fails; only a client restored from
    // a save that predates the kept strength (`unknown`) lets it pass as amber.
    const skill = this.pinnedSkill ?? this.tableSkill ?? 'unpublished';
    const bots = new Set(this.frozenBots ?? []);
    const matchId = this.state.matchId ?? '';
    let unchecked = false;
    /** Turns on which the table passed up this seat's win: reported as such (the rule always takes one). */
    const passedUp = new Set<unknown>();
    /** Turns on which the table passed a Pong, Chow or Kong this seat could make: named if its link was down. */
    const claimAt = new Map<number, PassedClaim>();
    const leftOnPurpose = (n: unknown): boolean => {
      if (!play || !isInt(n)) return true;
      let a: SeenState | null = null;
      for (const f of play.seen) if (f.tc <= n) a = f;
      const b = frameAfter(n);
      const since = a ? a.epoch : play.before?.epoch;
      if (since === undefined || !b) return true;
      return this.ownAbsences.some((e) => e >= since && e < b.epoch);
    };
    /**
     * A move the table made: one it says it made, or, in a hand this device missed altogether, any
     * move credited to this seat. The device sent nothing in such a hand, so a move written down
     * as the player's own is the table's (unless the player was away on purpose, or on another
     * device, and may have played it there), and is judged as one: its rule, and the time away.
     */
    const byTable = (entry: LoggedAction): boolean => entry.source === 'auto' || (missed && entry.seat === me && !leftOnPurpose(entry.n));
    const checkRule = (s: GameState, entry: LoggedAction) => {
      const seat = entry.seat;
      if (!isInt(seat) || seat < 0 || seat > 3) return;
      const isBot = bots.has(seat);
      if (!isBot && !byTable(entry)) return;
      if (skill === 'unknown') {
        unchecked = true;
        return;
      }
      if (skill === 'unpublished') {
        problems.add('The table did not say how strong its bots are, yet it made moves for bots or for seats out of time, so none of them could be checked');
        return;
      }
      const is = (rule: 'timeout' | 'bot') => {
        const want = tableRule(s, seat, rule, skill, matchId);
        return want !== null && sameActionSafe(want, entry.action, s, seat);
      };
      const n = String(entry.n);
      if (isBot) {
        if (!is('bot')) problems.add(`The bot in seat ${seat} played a move other than the one its published rule gives (turn ${n})`);
      } else if (seat === me) {
        if (!passedUp.has(entry.n) && !is('timeout') && !(leftOnPurpose(entry.n) && is('bot'))) problems.add(`The table played for this seat a move other than the one its published rule gives (turn ${n})`);
      } else if (!is('timeout') && !is('bot')) problems.add(`The table played for seat ${seat} a move that neither of its published rules gives (turn ${n})`);
    };
    let s = dealFromSnapshot(start, seed, rules);
    checkHash(s);
    checkRefusals(s);
    /** The turn of this seat's last move in the log so far (-1: none), and, for each table move, the one before it. */
    let lastMine = -1;
    const prevOf = new Map<number, number>();
    const scope = this.lateScope();
    // The table's answers to this run's pings during the hand are fixed points like the deal and this seat's
    // moves (they count wherever those do). With them every turn is measured by `lateBy` against
    // `lateLimitMs` (`limit`); a hand without them is measured as before.
    // (`anchors` holds the deal's fixed point at most, so far: `runAudit`.)
    const dealt = anchors.slice();
    const pongs = play && !missed ? (play.pongs ?? []) : [];
    for (const k of pongs) anchors.push(k);
    const pong: PongClock | null = pongs.length > 0 ? { limit: lateLimitMs(rules), points: [...dealt, ...pongs], scope } : null;
    const limit = pong ? pong.limit : null;
    // This device pinged the table through the hand and nothing came back: the hand cannot be green, so a
    // server gains nothing by not answering.
    if (play && notes && !missed && pongs.length === 0 && (play.pinged ?? 0) >= NO_ANSWER_PINGS) notes.noAnswer = true;
    const track0 = play ? clockTrack(this.clockBase, this.recordFor(play.hand), play, rules, anchors) : null;
    /**
     * The turn this seat's move at `n` answered (its move before that at `prevMine`), judged by the first
     * state that showed it (`seatRun`). A state that did not give the whole turn clock on a link this device
     * held, or one later than any honest frame on a live link, fails. One shown late otherwise (by `lateBy`
     * against `limit` in a hand with pong fixed points; else against the least offset or the fixed points),
     * or first shown on a new link with less than a whole clock (less `limit`, or LATE_MS) to go, is noted:
     * this device cannot vouch that the player saw the whole turn.
     */
    const judgeShown = (play: PlayRecord, n: number, prevMine: number) => {
      const { run, i0 } = seatRun(play, n, prevMine);
      const r0 = run[0];
      if (!r0) return;
      const before = i0 > 0 ? play.seen[i0 - 1] : null;
      const tracked = (before ? track0?.bank.get(before) : null) ?? rules.timeBankSeconds * 1000;
      // A run first shown on a new link: the host's own word for the bank it had at the turn's start counts if lower (it was spent while the link was down).
      const whole = rules.turnSeconds * 1000 + Math.min(tracked, r0.timeBank * 1000);
      const left = r0.deadline === null || typeof r0.now !== 'number' ? Number.POSITIVE_INFINITY : (r0.inBank ? r0.deadline : r0.deadline + r0.timeBank * 1000) - r0.now;
      const here = seenHere(r0, this.runId);
      if ((here && armedLate(r0, rules)) || heldLive(r0, this.runId)) problems.add(`The host showed this seat its turn late, on a link that stayed open (turn ${n})`);
      else if (notes) {
        const by = pong ? lateBy(r0, pong.points, pong.scope) : null;
        // One no fixed point bounds: late when the table had left the pings of its scope unanswered past the limit (`unanswered`).
        const late = by !== null ? by > (limit as number) : (pong !== null && unanswered(r0, play.pingedFrom, pong.limit, pong.scope)) || lateRef(r0) > LATE_MS || lateAnchor(r0, anchors, scope) > LATE_MS;
        if (late || unstamped(r0) || (!r0.onLink && left < whole - (limit ?? LATE_MS)) || (!here && armedLate(r0, rules))) notes.lateShown = true;
      }
    };
    for (const entry of log) {
      // Each entry is the move made at the turn the replay has reached, and says so: an honest host logs every move with
      // the turn it was made on (`applyAction`), and every check of this seat's moves below is keyed by that number.
      if (!isObject(entry) || entry.n !== s.turnCounter) problems.add(`The log numbers the move made at turn ${s.turnCounter} as another turn`);
      if (play && me !== null && isObject(entry) && entry.seat === me) {
        const n = entry.n;
        const prevMine = lastMine;
        if (isInt(n)) {
          prevOf.set(n, lastMine);
          lastMine = n;
        }
        const source = byTable(entry) ? 'auto' : 'player';
        if (source === 'player') {
          if (isInt(n) && ledgerVouches(play, n)) {
            // Any move this client sent and the log has not used yet may be the one: a move that reaches
            // the table late (after its clock ran out, say) is played on the seat's next turn if still legal.
            // Of several, the likeliest: one the host did not refuse, made on the latest turn.
            const copies = sent.filter((x) => !x.used && x.tc <= n && sameActionSafe(x.action, entry.action, s, me));
            const match = copies.slice().sort((a, b) => Number(!!a.rejected) - Number(!!b.rejected) || b.tc - a.tc)[0];
            if (match) {
              match.used = true;
              judgeShown(play, n, prevMine);
              // The host cannot have played this move before this device sent it: a fixed point between the
              // two clocks. Of copies of the same move sent more than once, the first counts (the host may
              // have played that one), with the round trip from it to the first frame that shows the move.
              const f = frameAfter(n);
              const first = firstSend(copies);
              if (f && f.kept !== false && first && typeof first.at === 'number' && typeof f.now === 'number' && f.epoch === first.epoch && f.at >= first.at) anchors.push({ at: first.at, now: f.now, era: f.era ?? 0, run: first.run, seg: first.seg, fat: f.at });
            } else if (sent.some((x) => !x.used && !x.rejected && x.tc <= n)) problems.add(`The log changed a move this seat made (turn ${n})`);
            else problems.add(`The log shows a move this seat never made (turn ${n})`);
          } else if (isInt(n)) {
            // A move from before this device could vouch for its ledger (an app restart, or the seat opened on
            // another device, came in between): whoever sent it, the state that showed this seat the turn is
            // judged as any other, so a server gains nothing by making the app start again.
            judgeShown(play, n, prevMine);
          }
        } else {
          let couldWin = false;
          try {
            couldWin = legalActions(s, me).some((a) => a.type === 'hu');
          } catch {
            couldWin = false;
          }
          if (couldWin && entry.action?.type !== 'hu') {
            problems.add(`The table played for this seat and passed up its win (turn ${String(n)})`);
            passedUp.add(n);
          } else if (isInt(n) && s.phase === 'claim' && isObject(entry.action) && entry.action.type === 'pass') {
            // The timeout rule passes every claim but a win. Which one this seat could have made, if any, is named.
            let offered: string[] = [];
            try {
              offered = legalActions(s, me).map((a) => a.type);
            } catch {
              offered = [];
            }
            const claim: PassedClaim | null = offered.includes('kong') ? 'kong' : offered.includes('pong') ? 'pong' : offered.includes('chi') ? 'chow' : null;
            if (claim) claimAt.set(n, claim);
          }
          // Judged after the replay, when every fixed point between the two clocks is known; the mark keeps its place among the problems.
          if (isInt(n)) problems.add(`${JUDGE_LATER}${n}`);
          // The legal moves this device sent for this turn, since it began vouching for the log, that the log has not
          // used and the table did not refuse by then: the table played its own over them. (Before the ledger vouches,
          // none are matched.) For the in-good-time rule, one sent over the link the table's move came over or an
          // earlier one (a server that drops the move and cuts the link, or says the seat was opened on another
          // device, loses it as a slow network would); for the 30 s rule, only one over that link (`sameLink`).
          const after = isInt(n) ? frameAfter(n) : null;
          const from = play.ledgerFrom;
          const lying = (x: (typeof sent)[number], sameLink = false): x is (typeof sent)[number] & { at: number } =>
            after !== null && from !== null && isInt(n) && !x.used && x.tc >= from && x.tc <= n && (sameLink ? x.epoch === after.epoch : x.epoch <= after.epoch) && typeof x.at === 'number' && !(x.refusedAt !== undefined && x.refusedAt <= n) && legalFor(s, me, x.action) && !sameActionSafe(x.action, entry.action, s, me);
          // One sent in good time (`inFlight`, amber): sent after the turn's first state arrived, with more of
          // the clock the app showed left, counted from that state's arrival, than the best round trip measured by
          // then and `FLIGHT_SLACK_MS` explain losing on the way (`flightAllowance`). The clock the app showed ends
          // where the audit holds the table to (`streakEnd`, with the rules' clock as this device tracked it, as
          // `ownClock` counts it), not where the first state's own claim does: a state that says the bank is spent,
          // or a later end the server keeps, makes the screen show more time than that claim, and a move made in it
          // is made in good time. A move is timed in the run of the app that sent it, against the first state of the
          // turn that run saw: a server that makes the app start again during the turn (by saying the seat was opened
          // on another device, say) does not put the move out of reach of this rule.
          if (after && limit !== null && notes && isInt(n)) {
            const { run } = seatRun(play, n, prevMine);
            const r0 = run[0];
            const a = run[run.length - 1];
            const ia = a ? play.seen.indexOf(a) : -1;
            const streak = ia >= 0 ? ownRun(play, rules, ia) : [];
            const end = ia >= 0 ? streakEnd(play, ia, rules, track0?.bound.get(a), BANK_ROUND_MS) : Number.NEGATIVE_INFINITY;
            /**
             * The end the app showed in run `xr` of the app, on that run's clock: from the first state of the turn it saw
             * (`q`; its own claim, counted from its arrival), and from the first state of the clock the app showed
             * (`ownRun`) in the latest state's clock era that it saw (`streakEnd`, counted from that state's arrival).
             */
            const endIn = (xr: string | undefined): { shown: number; ends: number } | null => {
              const q = run.find((f) => f.run === xr);
              if (!q) return null;
              const own = q.deadline !== null && typeof q.now === 'number' ? q.at + (q.inBank ? q.deadline : q.deadline + q.timeBank * 1000) - q.now : Number.NEGATIVE_INFINITY;
              const p = streak.find((f) => (f.era ?? 0) === (a.era ?? 0) && typeof f.now === 'number' && f.run === xr);
              const ends = p && Number.isFinite(end) ? Math.max(own, p.at + end - (p.now as number)) : own;
              return ends > Number.NEGATIVE_INFINITY ? { shown: q.atLo ?? q.at, ends } : null;
            };
            const timely = (x: (typeof sent)[number] & { at: number }): boolean => {
              const e = endIn(x.run);
              return e !== null && x.at >= e.shown && x.at + flightAllowance(x, anchors, scope, limit) <= e.ends;
            };
            if (r0 && sent.some((x) => lying(x) && x.tc >= r0.tc && timely(x))) notes.inFlight = true;
          }
          // One left lying for more than `MOVE_SLACK_MS` (time the app was not running left out) over a link
          // that never dropped: no network is that slow.
          if (after && sent.some((x) => lying(x, true) && after.at - x.at - pausedIn(scopeOf(scope, x.run)?.pauses ?? [], x.at, after.at) > MOVE_SLACK_MS)) {
            if (after.kept === false) {
              if (notes) notes.damaged = true;
            } else problems.add(`The table ignored a move this seat sent in good time and played its own instead (turn ${n})`);
          }
        }
      }
      if (isObject(entry)) checkRule(s, entry);
      s = applyAction(s, entry.seat, entry.action);
      checkHash(s);
      checkRefusals(s);
    }
    // States shown for turns the log never reached: the log was cut short or rewritten.
    for (const tc of shown.keys()) if (tc > s.turnCounter) problems.add(`The state this seat was shown at turn ${tc} is not in the replay`);
    const track = play ? clockTrack(this.clockBase, this.recordFor(play.hand), play, rules, anchors) : null;
    // Each turn of this seat whose state reached this device late, for the count on the Fair play screen
    // (never a verdict): judged by the state that first showed the seat the move (`seatRun`), against
    // every fixed point the replay found.
    // In a hand with pong fixed points: by `lateBy` against the table's answers to the pings alone (this hand's
    // and the strongest of the hands before), against `lateCountMs` (half of `limit`); otherwise, and for a turn
    // they do not bound (one shown before the first answer of a run), by `turnLateBy` against `lateLimitMs`, as
    // before. Not against the deal or a move's frame: the deal's round trip holds the time the table waited for
    // every share, and either may be an answer sent at once with its stamp moved back. The count is never a verdict.
    if (play && me !== null && notes) {
      let prev = -1;
      const pongScope = this.lateScope(true);
      for (const entry of log) {
        if (!isObject(entry) || entry.seat !== me || !isInt(entry.n)) continue;
        const r0 = seatRun(play, entry.n, prev).run[0];
        prev = entry.n;
        if (!r0) continue;
        notes.turnsMeasured = (notes.turnsMeasured ?? 0) + 1;
        const by = pong && !unstamped(r0) ? lateBy(r0, pongs, pongScope) : null;
        if (by !== null ? by > lateCountMs(rules) : turnLateBy(r0, anchors, scope) > lateLimitMs(rules)) (notes.lateTurns ??= []).push(entry.n);
      }
    }
    const gaps = new Set<number>();
    const marked = [...problems];
    problems.clear();
    for (const p of marked) {
      if (!p.startsWith(JUDGE_LATER) || !play || !track) {
        problems.add(p);
        continue;
      }
      const n = Number(p.slice(JUDGE_LATER.length));
      // A move made for this seat after the host held back a frame on a link that stayed open.
      if (play.held !== undefined && n >= play.held) {
        problems.add(`The host held back its frames on a link that stayed open, then played for this seat (turn ${n})`);
        continue;
      }
      const verdict = judgeTableMove(this.moveJudge(), play, n, end, rules, anchors, track, gaps, prevOf.get(n) ?? -1, scope, pong);
      if (doubt && (verdict === 'held' || verdict === 'early' || verdict === 'downEarly')) {
        if (notes) notes.damaged = true;
      } else if (verdict === 'held') problems.add(`The host held back its frames on a link that stayed open, then played for this seat (turn ${n})`);
      else if (verdict === 'lateTurn') problems.add(`The host showed this seat its turn late, on a link that stayed open (turn ${n})`);
      else if (verdict === 'early') problems.add(`The table played for this seat while it was connected and its clock had not run out (turn ${n})`);
      else if (verdict === 'downEarly') problems.add(`The table played for this seat while its connection was down, before its clock could have run out (turn ${n})`);
      else if ((verdict === 'down' || verdict === 'downLate') && notes) {
        // A turn shown too late for its stamp to be believed is judged as a drop, but it is not said
        // to be one: the link may never have dropped.
        const late = verdict === 'downLate';
        if (late) notes.tableMovedLate = notes.lateShown = true;
        else notes.tableMoved = true;
        const claim = claimAt.get(n);
        if (claim) (notes.passedClaims ??= []).push({ turn: n, claim, ...(late ? { late } : {}) });
      }
      else if (verdict === 'unanchored' && notes) notes.restartClock = true;
      else if (verdict === 'across' && notes) notes.appClock = true;
      // The host announced a restart while this seat owed the move it then played for it: an end the app showed
      // before the restart is on a clock the host's new stamps do not keep, so it cannot be held to it (`streakEnd`).
      if (notes && restartInRun(play, n, rules)) notes.restartClock = true;
    }
    for (const tc of track?.bankTaken ?? []) {
      if (doubt) {
        if (notes) notes.damaged = true;
      } else problems.add(`The table took time from this seat's time bank while its connection was down (turn ${tc})`);
    }
    // Only what earlier runs of the app measured says the bank was taken: the phone's clock may have been set in between.
    if ((track?.bankAcross.length ?? 0) > 0 && notes) notes.appClock = true;
    failures.push(...problems);
    if (unchecked && notes) notes.skillUnknown = true;
    return s;
  }

  /**
   * The run of the app, the strongest fixed point kept in it (see `lateAnchor`; with `pongs`, the strongest of its
   * answers to pings, as the Fair play count weighs them) and its pauses (see `lateBy`), with the same for each earlier
   * run of the app whose frames the record holds (`earlier`).
   */
  private lateScope(pongs = false): LateScope {
    return {
      run: this.runId,
      best: pongs ? this.bestPong : this.bestAnchor,
      pauses: this.pauses,
      earlier: this.earlier.map((e) => ({ run: e.run, best: pongs ? e.bestPong : e.best, pauses: e.pauses })),
    };
  }

  /**
   * What this run of the app carries, and what the earlier runs carried, for the record: only the runs whose frames,
   * moves, answers or pings the hands on record hold, at most `MAX_RUN_SCOPES` (the latest).
   */
  private runScopes(): RunScope[] {
    const used = new Set<string>();
    for (const p of this.plays) {
      for (const f of p.seen) if (typeof f.run === 'string') used.add(f.run);
      for (const x of p.sent) if (typeof x.run === 'string') used.add(x.run);
      for (const k of p.pongs ?? []) if (typeof k.run === 'string') used.add(k.run);
      for (const k of p.pingedFrom ?? []) used.add(k.run);
    }
    const mine = (b: LateScope['best']) => (b && b.run === this.runId ? { ...b } : null);
    const own: RunScope = { run: this.runId, best: mine(this.bestAnchor), bestPong: mine(this.bestPong), pauses: this.pauses.map((p) => ({ from: p.from, to: p.to })) };
    return [...this.earlier.filter((e) => used.has(e.run)), own].slice(-MAX_RUN_SCOPES);
  }

  /** What the table-move checks (`judgeTableMove`) read of this client's clock record, and keep. */
  private moveJudge(): MoveJudge {
    return { clockBase: this.clockBase, gapVerdicts: this.gapVerdicts, ownAbsences: this.ownAbsences };
  }

  private checkAccounting(audit: Audit): string[] {
    const failures: string[] = [];
    const h = audit.handNumber;
    const attempts = audit.ceremonyAttempts;
    const restarts = Array.isArray(audit.restarts) ? audit.restarts : null;
    if (!isInt(attempts) || attempts < 1) return ['Audit does not say how many ceremonies were run'];
    if (!restarts) return ['Audit does not list the ceremony restarts'];
    if (restarts.length !== attempts - 1) failures.push(`Audit lists ${restarts.length} restarts for ${attempts} ceremony attempts`);
    // The bot seats as they stood at the match's first deal: the host cannot add phantom humans later.
    const bots = this.frozenBots ?? this.state.seats.filter((s) => s.isBot).map((s) => s.seat);
    const humans = 4 - bots.length;
    if (attempts > 1 + humans) failures.push(`${attempts} ceremony attempts is more than ${1 + humans}, the most an honest table with ${humans} human seats needs`);
    restarts.forEach((r, i) => {
      if (!isObject(r) || r.attempt !== i + 1 || !Array.isArray(r.seats) || !RESTART_CAUSES.includes(r.cause)) {
        failures.push(`Restart ${i + 1} is malformed`);
        return;
      }
      for (const s of r.seats) {
        if (!isInt(s) || s < 0 || s > 3) failures.push(`Restart ${i + 1} names seat ${String(s)}, which is not a player seat`);
        else if (bots.includes(s)) failures.push(`Restart ${i + 1} blames seat ${s + 1}, which is a bot`);
      }
    });
    // A blamed seat gets a host-supplied share for the rest of the hand, so it is never the reason
    // for a second restart.
    const blamed = new Set<number>();
    restarts.forEach((r, i) => {
      if (!isObject(r) || !Array.isArray(r.seats)) return;
      const named = r.seats.filter(isInt);
      for (const s of named) if (blamed.has(s)) failures.push(`Restart ${i + 1} blames seat ${s + 1} again after the host had stood it in`);
      for (const s of named) blamed.add(s);
    });
    failures.push(...this.checkOwnAttempts(h, attempts, restarts));
    return failures;
  }

  /**
   * Compare the attempts and restarts with what this client saw of the ceremony itself. Every
   * attempt it heard of must be within the audit's count; when it watched from the first attempt
   * without losing its link it saw them all, so the count must match and a restart with nobody to
   * blame cannot be honest (only a host that crashed restarts that way, and that drops every link).
   * A restart that blames this seat must follow an attempt it did not reveal in, and every later
   * attempt must stand it in, whether or not the link held: otherwise the host re-dealt after
   * seeing this seat's secret.
   */
  private checkOwnAttempts(h: number, attempts: number, restarts: unknown[]): string[] {
    const rec = this.recordFor(h);
    if (!rec || rec.attempts.length === 0) return [];
    const me = this.state.seat;
    const failures: string[] = [];
    const byN = new Map(rec.attempts.map((a) => [a.n, a]));
    const highest = Math.max(...rec.attempts.map((a) => a.n));
    if (highest > attempts) failures.push(`Audit reports ${attempts} ceremony attempts but this seat was asked to commit in attempt ${highest}`);
    const sawAll = rec.fromStart && !rec.linkLost;
    if (sawAll && rec.attempts.length !== attempts) failures.push(`Audit reports ${attempts} ceremony attempts but this seat was asked to commit ${rec.attempts.length} times`);
    let blamedMe = false;
    let flaggedBlame = false;
    restarts.forEach((r, i) => {
      if (!isObject(r) || !Array.isArray(r.seats)) return;
      if (sawAll && (r.seats.length === 0 || r.cause === 'host_restarted')) failures.push(`Restart ${i + 1} blames no seat, yet this seat saw every attempt without losing its link`);
      if (me === null || !r.seats.includes(me)) return;
      blamedMe = true;
      const at = byN.get(i + 1);
      const next = byN.get(i + 2);
      if (at?.stoodIn) {
        failures.push(`Restart ${i + 1} blames this seat although the host had stood it in`);
        flaggedBlame = true;
      } else if (at?.revealed && next && !next.stoodIn) {
        failures.push(`Restart ${i + 1} blames this seat although it revealed, and the host then asked it for a new share instead of standing it in`);
        flaggedBlame = true;
      }
    });
    const dealt = byN.get(attempts);
    if (blamedMe && !flaggedBlame && dealt && dealt.committed && !dealt.stoodIn) failures.push('The audit blames this seat for a restart, yet the deal used a new share from it instead of standing it in');
    return failures;
  }
}

/** What a replay noticed that makes a hand amber rather than green. */
interface ReplayNotes {
  tableMoved: boolean;
  /** The table played for this seat on a turn shown too late for its stamp to be believed (`downLate`). */
  tableMovedLate?: boolean;
  restartClock?: boolean;
  /** A move for this seat that only what was measured in another run of the app calls early (`across`). */
  appClock?: boolean;
  lateShown?: boolean;
  skillUnknown?: boolean;
  /** A check of the table's moves for this seat could not be made, its record of the hand being damaged (`damaged`). */
  damaged?: boolean;
  /** The table sent more states in this hand than this client keeps (`PlayRecord.overflow`). */
  overflow?: boolean;
  /** The table played for this seat over a move it sent in good time (`AUDIT_CAVEATS.inFlight`). */
  inFlight?: boolean;
  /** The table answered none of the pings this device sent during the hand (`AUDIT_CAVEATS.noAnswer`). */
  noAnswer?: boolean;
  /** Claims the table passed for this seat while its link was down, or on a turn that reached this device late (`late`), in turn order. */
  passedClaims?: Array<{ turn: number; claim: PassedClaim; late?: boolean }>;
  /** The seat's turns whose state reached this device late enough to be counted (`lateCountMs`, or `lateLimitMs` without pong fixed points), and how many of its turns it could measure. */
  lateTurns?: number[];
  turnsMeasured?: number;
}

/** The caveats that say the table played for this seat without its watching: while its link was down, on a turn that reached it late, and each kind of claim passed in either. */
function tableMoveCaveats(notes: ReplayNotes): string[] {
  const out: string[] = [];
  if (notes.tableMoved) out.push(AUDIT_CAVEATS.tableMoved);
  if (notes.tableMovedLate) out.push(AUDIT_CAVEATS.tableMovedLate);
  const passed = notes.passedClaims ?? [];
  for (const late of [false, true]) {
    const kinds = new Set(passed.filter((p) => (p.late === true) === late).map((p) => p.claim));
    for (const k of ['pong', 'chow', 'kong'] as const) if (kinds.has(k)) out.push((late ? PASSED_LATE_CAVEAT : PASSED_CAVEAT)[k]);
  }
  return out;
}
