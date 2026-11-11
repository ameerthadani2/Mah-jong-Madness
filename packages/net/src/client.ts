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
 */
import {
  advanceMatch,
  dealFromSnapshot,
  hashState,
  isLegal,
  legalActions,
  matchSnapshot,
  newGame,
  sameAction,
  sanitizeRules,
  stableStringify,
  viewToState,
  WALL_RNG_VERSION,
  applyAction,
  type Action,
  type GameState,
  type HandResult,
  type LoggedAction,
  type MatchSnapshot,
  type RuleSet,
  type TableView,
} from '@mjm/engine';
import { commitFor, deriveSeed, makeSecret, SHARE_SEATS, verifyReveals, type Commitment, type Reveal } from './fairness';
import type { Link } from './host';
import { RESTART_CAUSES, type Audit, type ClientMessage, type HostMessage, type SeatInfo } from './messages';
import type { Transport, Unsubscribe } from './transport';

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
} as const;

export type AuditCaveat = keyof typeof AUDIT_CAVEATS;

/** The key of a caveat text produced by this client, or null for any other text. */
export function caveatKey(text: string): AuditCaveat | null {
  for (const [k, v] of Object.entries(AUDIT_CAVEATS)) if (v === text) return k as AuditCaveat;
  return null;
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
  /** Rejoin token from the host; persist it to resume after a crash. */
  token: string | null;
  /** Remaining time bank (seconds) and whether the clock is currently eating into it. */
  timeBank: number;
  inTimeBank: boolean;
  /** Audited hands of this match (the last MAX_AUDITS), newest last. */
  audits: Array<{ audit: Audit; status: AuditStatus; failures: string[]; caveats: string[] }>;
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

const HEX64 = /^[0-9a-f]{64}$/;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

function isPlayerView(p: unknown): boolean {
  return isObject(p) && isInt(p.handCount) && p.handCount >= 0 && p.handCount <= 17 && (p.hand === undefined || Array.isArray(p.hand)) && Array.isArray(p.melds) && Array.isArray(p.flowers) && Array.isArray(p.discards);
}

/** Enough of a seat view for the client and the engine helpers to use without throwing. */
function isView(v: unknown): v is TableView {
  return isObject(v) && isInt(v.handNumber) && Array.isArray(v.players) && v.players.length === 4 && v.players.every(isPlayerView) && Array.isArray(v.scores) && v.scores.length === 4;
}

function isAudit(a: unknown): a is Audit {
  return isObject(a) && isInt(a.handNumber) && Array.isArray(a.commits) && Array.isArray(a.reveals) && Array.isArray(a.log) && typeof a.seed === 'string';
}

/** Five commitments, one per seat 0–4, each a SHA-256 hex digest. */
function isCommitSet(c: unknown): c is Commitment[] {
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
function isRevealSet(r: unknown): r is Reveal[] {
  if (!Array.isArray(r) || r.length !== SHARE_SEATS) return false;
  const seats = new Set<number>();
  for (const x of r) {
    if (!isObject(x) || !isInt(x.seat) || x.seat < 0 || x.seat >= SHARE_SEATS || typeof x.secret !== 'string') return false;
    seats.add(x.seat);
  }
  return seats.size === SHARE_SEATS;
}

/** The same commitments, whatever their order. */
function sameCommitSet(a: Commitment[], b: Commitment[]): boolean {
  const key = (set: Commitment[]) => set.map((c) => `${c.seat}=${c.hash}`).sort().join('|');
  return key(a) === key(b);
}

/** What this client saw of one ceremony attempt. */
interface AttemptRecord {
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
}

/**
 * A fixed point between this device's clock and the host's: something the host did (`now`, on its
 * clock) that it cannot have done before this device sent what it answers (`at`, on this clock).
 */
interface ClockAnchor {
  at: number;
  now: number;
  epoch: number;
}

/** What this client saw of one hand's ceremony. */
interface CeremonyRecord {
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
interface SeenState {
  /** The view's turn counter (number of actions applied so far). */
  tc: number;
  /** Link epoch: changes on every link loss, so frames of one epoch arrived over one unbroken link. */
  epoch: number;
  /** This device's clock when the frame arrived. */
  at: number;
  /** The host's clock when it sent the frame, if it said. */
  now?: number;
  /** This seat had a move to make in this view. */
  owes: boolean;
  deadline: number | null;
  timeBank: number;
  inBank: boolean;
  hash: string;
}

/** One move this client sent. */
interface SentAction {
  /** Turn counter of the view it acted on. */
  tc: number;
  action: Action;
  epoch: number;
  /** This device's clock when it sent the move. */
  at?: number;
  /** The host refused it (error code). */
  rejected?: string;
  /** The turn the host's own frames had reached when its refusal arrived. */
  refusedAt?: number;
  /** Matched to an entry of the hand's log during the audit. */
  used?: boolean;
}

/** What this client saw and did while one hand was played. */
interface PlayRecord {
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
}

/** Match fields a hand must start from, as the previous hand left them. */
const CHAINED_FIELDS = ['scores', 'dealerSeat', 'dealerStreak', 'dealerRotations', 'prevailingWind'] as const;

/** Audits kept (and saved) per table. */
export const MAX_AUDITS = 50;
/** Frames and sent moves remembered per hand (a hand is far shorter). */
const MAX_SEEN = 600;
const MAX_SENT = 300;
/** Slack for the host's rounding of time banks to whole seconds. */
const CLOCK_SLACK_MS = 1_000;
/** How far the host's clock may seem to gain on this device's after a fixed point between them (clock steps and drift). */
const CLOCK_SKEW_MS = 5_000;
/**
 * How much later than the frames before it a frame may have been stamped, relative to when each
 * arrived: the swing in network delay an unbroken link can show (a longer stall trips the
 * heartbeat and the link is replaced).
 */
const LATENCY_SLACK_MS = 30_000;
/** A move sent this long before the table's own move for the same turn arrived was not lost to a slow network. */
const MOVE_SLACK_MS = 30_000;

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
  epoch: number;
  ceremonyEpoch: number;
  quietSince: number;
  openHand: number | null;
  handEpoch: number;
  matchEnded: boolean;
  atStart: boolean;
  gapHand: number | null;
  rewinds: Array<{ hand: number; tc: number; undone: boolean }>;
  lapseHand: number | null;
  lapseDeal: boolean;
}

export interface TableClientOptions {
  /** This device's clock (ms). Defaults to Date.now. */
  now?: () => number;
}

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
    ceremony: 'idle',
    lastResult: null,
    lastAudit: null,
    auditStatus: 'unverified',
    auditFailures: [],
    auditCaveats: [],
    matchOver: false,
    finalScores: null,
    matchEndVerified: false,
    token: null,
    timeBank: 0,
    inTimeBank: false,
    audits: [],
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
  /** Link epoch: bumped on every link loss, rebind and restore. */
  private epoch = 0;
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
  /** The entry `failNow` last put on the list of audits (so the next failure about the same hand adds to it). */
  private liveFailure: ClientState['audits'][number] | null = null;
  /**
   * Hands the host said it resumed from a snapshot after a restart, and the turn it resumed at
   * (-1: before the deal). `undone`: this client had been shown more than that, and dropped it.
   */
  private rewinds: Array<{ hand: number; tc: number; undone: boolean }> = [];
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
    this.now = opts.now ?? (() => Date.now());
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
    const st = d.state;
    this.state = {
      ...this.state,
      ...st,
      rules: st.rules ? sanitizeRules(st.rules) : null,
      audits: Array.isArray(st.audits) ? st.audits.slice(-MAX_AUDITS) : [],
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
    this.records = d.records ?? [];
    this.plays = d.plays ?? [];
    this.expected = d.expected;
    this.chainChecked = d.chainChecked;
    this.frozenBots = d.frozenBots;
    this.pinnedRules = d.pinnedRules ? sanitizeRules(d.pinnedRules) : null;
    this.epoch = isInt(d.epoch) ? d.epoch : 0;
    this.ceremonyEpoch = isInt(d.ceremonyEpoch) ? d.ceremonyEpoch : -1;
    this.quietSince = isInt(d.quietSince) ? d.quietSince : -1;
    this.openHand = isInt(d.openHand) ? d.openHand : null;
    this.handEpoch = isInt(d.handEpoch) ? d.handEpoch : -1;
    this.matchEnded = d.matchEnded === true;
    this.state = { ...this.state, matchEndVerified: this.matchEnded && this.state.matchOver };
    this.atStart = d.atStart === true;
    this.gapHand = isInt(d.gapHand) ? d.gapHand : null;
    this.rewinds = Array.isArray(d.rewinds) ? d.rewinds.filter((x) => isObject(x) && isInt(x.hand) && isInt(x.tc)) : [];
    this.lapseHand = isInt(d.lapseHand) ? d.lapseHand : null;
    this.lapseDeal = d.lapseDeal === true;
    this.lapse = true;
    // The app stopped: the link it had is gone. Moves sent just before the last save may be missing
    // from the ledger, so it vouches for the current hand's log only from the next state it sees.
    this.noteLinkLost();
    const play = this.plays[this.plays.length - 1];
    if (play && !this.handsEnded.has(play.hand)) play.ledgerFrom = Number.POSITIVE_INFINITY;
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
      plays: this.plays.map((p) => ({ ...p, ledgerFrom: p.ledgerFrom === Number.POSITIVE_INFINITY ? null : p.ledgerFrom })),
      expected: this.expected,
      chainChecked: this.chainChecked,
      frozenBots: this.frozenBots,
      pinnedRules: this.pinnedRules,
      epoch: this.epoch,
      ceremonyEpoch: this.ceremonyEpoch,
      quietSince: this.quietSince,
      openHand: this.openHand,
      handEpoch: this.handEpoch,
      matchEnded: this.matchEnded,
      atStart: this.atStart,
      gapHand: this.gapHand,
      rewinds: this.rewinds,
      lapseHand: this.lapseHand,
      lapseDeal: this.lapseDeal,
    };
  }

  private bind(link: Link): void {
    this.link = link;
    this.unsubMessage = link.onMessage((m) => {
      try {
        this.onMessage(m);
      } catch (e) {
        this.update({ lastError: `Ignored a malformed message from the table (${(e as Error).message}).`, lastErrorCode: null });
      }
    });
    this.unsubClose =
      link.onClose?.(() => {
        if (this.link !== link) return;
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
    this.send({ t: 'join', name: this.name, avatar: this.avatar, wantSeat, token, userId: this.identity.userId, have: this.have() });
  }

  /** The last hand of this match whose end this client holds (-1: none yet, but it watched from the lobby). */
  private have(): number | undefined {
    if (this.state.matchId === null) return undefined;
    if (this.handsEnded.size > 0) return Math.max(...this.handsEnded);
    return this.atStart ? -1 : undefined;
  }

  act(action: Action): void {
    if (this.state.seat === null) return;
    // A view from before the link was lost says nothing about the table now: wait for the first state on this link.
    if (this.viewEpoch !== this.epoch) return;
    const v = this.state.view;
    const tc = v && isInt(v.turnCounter) ? v.turnCounter : undefined;
    if (v && tc !== undefined) {
      const play = this.playFor(v.handNumber);
      play.sent.push({ tc, action, epoch: this.epoch, at: this.now() });
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

  ping(): void {
    this.send({ t: 'ping', at: this.now() });
  }

  leave(): void {
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
    // Only hands not yet audited need their flags; keep the map small.
    if (this.tamper.size > 12) this.tamper.delete(this.tamper.keys().next().value as number);
  }

  /** The hand a problem seen now belongs to: the one under way, or the next one to be dealt. */
  private activeHand(): number {
    const v = this.state.view;
    if (v && !this.handsEnded.has(v.handNumber)) return v.handNumber;
    if (this.expected) return this.expected.handNumber;
    const ended = [...this.handsEnded];
    return ended.length > 0 ? Math.max(...ended) + 1 : 0;
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

  private recordFor(hand: number): CeremonyRecord | null {
    return this.records.find((r) => r.hand === hand) ?? null;
  }

  private playFor(hand: number): PlayRecord {
    let play = this.plays.find((p) => p.hand === hand);
    if (!play) {
      play = { hand, seen: [], sent: [], ledgerFrom: null };
      this.plays.push(play);
      if (this.plays.length > 3) this.plays.shift();
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
    this.quietSince = this.epoch;
    this.openHand = null;
    this.handEpoch = -1;
    this.matchEnded = false;
    this.atStart = false;
    this.gapHand = null;
    this.rewinds = [];
    this.lapse = false;
    this.lapseHand = null;
    this.lapseDeal = false;
    this.state = { ...this.state, matchOver: false, finalScores: null, matchEndVerified: false, view: null, lastResult: null };
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
    this.update({ auditStatus: 'failed', auditFailures: failures, auditCaveats: [], audits });
  }

  /** The bot seats as listed now; once frozen, any change is the host's doing. */
  private checkBots(seats: SeatInfo[]): void {
    if (this.frozenBots === null || this.state.matchOver) return;
    const bots = seats.filter((s) => isObject(s) && s.isBot === true && isInt(s.seat)).map((s) => s.seat).sort((a, b) => a - b);
    if (bots.join(',') !== this.frozenBots.join(',')) this.flag(this.activeHand(), 'Host changed which seats are bots during the match');
  }

  private onMessage(m: HostMessage): void {
    if (!isObject(m) || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'welcome': {
        if (!isInt(m.seat) || m.seat < 0 || m.seat > 3 || typeof m.matchId !== 'string') {
          this.update({ lastError: 'The table sent a malformed welcome.', lastErrorCode: null });
          return;
        }
        const seats = Array.isArray(m.seats) ? m.seats : [];
        // The seat and the match are pinned from the first deal this client hears of until the hands
        // it verified say the match is over. Before that there is nothing a new seat could undo.
        const pinned = this.state.matchId !== null && this.state.seat !== null && this.hasEvidence() && !this.matchEnded;
        if (pinned && (m.matchId !== this.state.matchId || m.seat !== this.state.seat)) {
          // Same table, same match, same token: an honest host returns the same seat in the same match.
          const problem = m.matchId !== this.state.matchId ? 'Host moved this seat into a different match mid-match' : 'Host moved this seat to another seat mid-match';
          this.flag(this.activeHand(), problem);
          this.update({ connected: true, disconnected: false, kicked: false, seats, token: typeof m.token === 'string' ? m.token : this.state.token, lastError: null });
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
        this.update({ connected: true, disconnected: false, kicked: false, seat: m.seat, roomCode: m.roomCode, rules: this.pinnedRules ?? rules, seats, matchId: m.matchId, token: m.token, lastError: null });
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
          if (this.records.length > 3) this.records.shift();
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
            if (this.records.length > 3) this.records.shift();
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
      case 'disconnected': {
        // The seat was opened on another device. Moves there are not ours to vouch for.
        this.noteLinkLost();
        const play = this.plays[this.plays.length - 1];
        if (play) play.ledgerFrom = Number.POSITIVE_INFINITY;
        this.update({ connected: false, kicked: true, lastError: 'This seat was opened on another device.' });
        return;
      }
      case 'commits': {
        if (!isInt(m.handNumber)) return;
        const h = m.handNumber;
        if (!isCommitSet(m.commits)) {
          this.flag(h, 'Host published a malformed set of commitments');
          this.update({ lastError: 'The table sent a malformed set of commitments.' });
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
        if (this.commitsHand !== h) {
          // Revealing first would let the host pick its own share after seeing ours.
          this.flag(h, 'Host asked for my secret before publishing all commitments');
          return;
        }
        {
          const attempt = this.currentAttempt(h);
          if (attempt) {
            attempt.revealed = true;
            attempt.revealedAt = this.now();
            attempt.revealedEpoch = this.epoch;
          }
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
        this.noteState(v, m);
        this.viewEpoch = this.epoch;
        this.update({ view: v, stateHash: m.hash, deadline: m.deadline, timeBank: m.timeBank, inTimeBank: m.inTimeBank, lastResult: null, lastError: null, ceremony: 'idle' });
        return;
      }
      case 'hand_over': {
        if (!isView(m.view) || !isAudit(m.audit) || !isObject(m.result)) {
          this.update({ lastError: 'The table sent a malformed hand result.' });
          return;
        }
        const h = m.audit.handNumber;
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
            if (held) this.update({ deadline: null });
            return;
          }
          // One failed entry per offending hand: a failure already on show for it is folded into this one.
          const live = this.liveFailure && this.liveFailure.audit.handNumber === h ? this.liveFailure : null;
          const failures = [...new Set([...(this.tamper.get(h) ?? []), ...(live?.failures ?? []), problem])];
          const audits = [...this.state.audits.filter((a) => a !== live), { audit: m.audit, status: 'failed' as const, failures, caveats: [] }].slice(-MAX_AUDITS);
          this.liveFailure = null;
          this.update({ auditStatus: 'failed', auditFailures: failures, auditCaveats: [], deadline: null, audits });
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
        const end: SeenState = { tc: Number.POSITIVE_INFINITY, epoch: this.epoch, at: this.now(), now: typeof m.now === 'number' ? m.now : undefined, owes: false, deadline: null, timeBank: 0, inBank: false, hash: '' };
        const { check, replayed } = this.runAudit(m.audit, m.view, m.result, end);
        const { status, failures, caveats } = check;
        // The next hand must start where this one, as replayed, left the match.
        this.expected = replayed && hashState(replayed) === m.audit.finalHash ? nextHand(replayed) : null;
        this.chainChecked = null;
        this.quietSince = this.epoch;
        this.tamper.delete(h);
        if (this.gapHand === h) this.gapHand = null;
        const audits = [...this.state.audits, { audit: m.audit, status, failures, caveats }].slice(-MAX_AUDITS);
        this.update({ view: m.view, lastResult: m.result, lastAudit: m.audit, auditStatus: status, auditFailures: failures, auditCaveats: caveats, deadline: null, audits });
        return;
      }
      case 'hand_missed':
        if (isAudit(m.audit)) this.auditMissed(m.audit);
        return;
      case 'restored':
        if (isInt(m.handNumber) && isInt(m.turnCounter) && m.turnCounter >= -1) this.noteRestore(m.handNumber, m.turnCounter);
        return;
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
          const matchEndVerified = this.matchEnded;
          // No hand is left to carry what was flagged since the last audit: put it on show now.
          for (const p of this.tamper.get(this.activeHand()) ?? []) this.failNow(p);
          // The last hand's verified view stays on show; the host's is used only when this device holds none.
          const own = this.state.view;
          const view = own && this.state.lastResult !== null && own.handNumber === m.view.handNumber ? own : m.view;
          this.update({ view, matchOver: true, finalScores: m.scores.slice(), matchEndVerified, deadline: null });
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
        if (typeof m.at === 'number') this.update({ rttMs: this.now() - m.at });
        return;
      default:
        return;
    }
  }

  /** Record a state frame of the hand being played: its hash, timing and whether we owed a move. */
  private noteState(v: TableView, m: Extract<HostMessage, { t: 'state' }>): void {
    if (!isInt(v.turnCounter) || typeof m.hash !== 'string') return;
    const play = this.playFor(v.handNumber);
    const prior = play.seen.find((s) => s.tc === v.turnCounter);
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
    play.seen.push({
      tc: v.turnCounter,
      epoch: this.epoch,
      at: this.now(),
      now: typeof m.now === 'number' ? m.now : undefined,
      owes,
      deadline: typeof m.deadline === 'number' ? m.deadline : null,
      timeBank: typeof m.timeBank === 'number' ? m.timeBank : 0,
      inBank: m.inTimeBank === true,
      hash: m.hash,
    });
    if (play.seen.length > MAX_SEEN) play.seen.splice(0, play.seen.length - MAX_SEEN);
  }

  /**
   * The host says it was restored from a snapshot (the server restarted) and resumed hand `h` at
   * turn `r`, or before its deal (-1). A snapshot is written a moment after the fact, so the
   * players may have been shown turns it does not hold; those are played again. This client drops
   * what it was shown beyond `r`, but only what reached it over an earlier link (a restart drops
   * every link) and only once per hand: anything else is a rewind and fails as before. A hand
   * with turns undone this way can only be `partial`. A hand whose result this client holds stays
   * ended whatever the notice says.
   */
  private noteRestore(h: number, r: number): void {
    if (this.handsEnded.has(h)) return;
    const known = this.rewinds.find((x) => x.hand === h);
    if (known) {
      // Every rejoin during the hand brings the same notice again; a different one is a second restart.
      if (known.tc !== r) this.flag(h, 'Host said it restarted this hand more than once');
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
        // Moves made on the turns undone are gone with them.
        play.sent = play.sent.filter((x) => x.tc < r || fresh(x.epoch));
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
      if (this.state.view?.handNumber === h && this.state.lastResult === null) this.update({ view: null, stateHash: null, deadline: null, ceremony: 'idle', standIn: false });
    }
    this.rewinds.push({ hand: h, tc: r, undone });
    if (this.rewinds.length > 4) this.rewinds.shift();
  }

  /** The host refused a move: mark it in the ledger so the audit does not expect it in the log. */
  private noteRefusal(m: Extract<HostMessage, { t: 'error' }>): void {
    const code = typeof m.code === 'string' ? m.code : 'error';
    if (!['illegal', 'not_playing', 'wrong_seat', 'not_seated'].includes(code)) return;
    const play = this.plays[this.plays.length - 1];
    if (!play) return;
    const open = play.sent.filter((s) => !s.rejected && (!isInt(m.turnCounter) || s.tc === m.turnCounter));
    const target = open[open.length - 1];
    // Every state the host reached before it refused has arrived before the refusal (frames come in order).
    const v = this.state.view;
    const at = v && v.handNumber === play.hand && isInt(v.turnCounter) ? v.turnCounter : undefined;
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
        this.update({ audits: [...this.state.audits, { audit, status: 'failed' as const, failures: [problem], caveats: [] }].slice(-MAX_AUDITS) });
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
    const end: SeenState = { tc: Number.POSITIVE_INFINITY, epoch: this.epoch, at: this.now(), owes: false, deadline: null, timeBank: 0, inBank: false, hash: '' };
    try {
      replayed = this.replayChecked(base, audit.seed, rules, audit.log, h, end, failures);
      if (hashState(replayed) !== audit.finalHash) failures.push('Replaying the action log does not reproduce the final state');
    } catch (e) {
      failures.push(`Replay failed: ${(e as Error).message}`);
    }
    failures.push(...this.checkAccounting(audit));
    if (isInt(audit.ceremonyAttempts) && audit.ceremonyAttempts > 1) caveats.push(AUDIT_CAVEATS.restarted);
    const status: AuditStatus = failures.length > 0 ? 'failed' : 'partial';
    this.handsEnded.add(h);
    if (this.openHand === h) this.openHand = null;
    this.atStart = false;
    this.expected = replayed && hashState(replayed) === audit.finalHash ? nextHand(replayed) : null;
    this.chainChecked = null;
    this.tamper.delete(h);
    // A record that fails is the host's doing now, not then: the hand on the table carries it too.
    if (status === 'failed') this.flag(this.activeHand(), `The record of hand ${h + 1}, played while this device was away, failed its checks`);
    this.update({ audits: [...this.state.audits, { audit, status, failures, caveats }].slice(-MAX_AUDITS) });
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
  private runAudit(audit: Audit, finalView: TableView, announced: HandResult | undefined, end: SeenState | null): { check: AuditCheck; replayed: GameState | null } {
    const failures: string[] = [];
    const caveats: string[] = [];
    let replayed: GameState | null = null;
    const rules = this.pinnedRules ?? this.state.rules;
    if (!rules || !this.state.matchId) return { check: { status: 'unverified', failures: ['No match context'], caveats }, replayed };
    if (!isAudit(audit) || !isView(finalView)) return { check: { status: 'failed', failures: ['The audit is malformed'], caveats }, replayed };
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
    const anchors: ClockAnchor[] = [];
    const lastAttempt = this.recordFor(h)?.attempts.slice(-1)[0];
    const firstFrame = this.plays.find((p) => p.hand === h)?.seen[0];
    const mySecret = revealsOk ? audit.reveals.find((r) => r.seat === me)?.secret : undefined;
    if (tookPart && !stoodIn && this.secret && mySecret === this.secret && lastAttempt?.revealed && typeof lastAttempt.revealedAt === 'number' && firstFrame && typeof firstFrame.now === 'number' && firstFrame.epoch === lastAttempt.revealedEpoch && firstFrame.at >= lastAttempt.revealedAt) {
      anchors.push({ at: lastAttempt.revealedAt, now: firstFrame.now, epoch: firstFrame.epoch });
    }
    try {
      replayed = this.replayChecked(start, audit.seed, rules, audit.log, h, end, failures, anchors);
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
    // An app restart around the deal: this device cannot say it watched all of it, whatever its record now shows.
    // (A seat that joined mid-hand has already said it took no part in the deal.)
    if (this.lapseHand === h && this.lapseDeal && !joined && !caveats.includes(AUDIT_CAVEATS.appRestart)) caveats.push(AUDIT_CAVEATS.appRestart);

    const status: AuditStatus = failures.length > 0 ? 'failed' : caveats.length > 0 ? 'partial' : 'ok';
    return { check: { status, failures, caveats }, replayed };
  }

  /**
   * Replay the hand, checking along the way every state hash this client was shown and every entry
   * the log puts on this seat: a move credited to the player must be one this client sent (and
   * not refused), a move the table made for the seat must come after its clock ran out or while
   * its link was down, and never pass up a win (the table's own play always takes one). A move
   * this client sent must not have been refused while it was legal, nor left lying until the
   * clock ran out.
   */
  private replayChecked(start: MatchSnapshot, seed: string, rules: RuleSet, log: LoggedAction[], h: number, end: SeenState | null, failures: string[], anchors: ClockAnchor[] = []): GameState {
    const me = this.state.seat;
    const play = end ? (this.plays.find((p) => p.hand === h) ?? null) : null;
    const shown = new Map<number, string>();
    for (const s of play?.seen ?? []) if (!shown.has(s.tc)) shown.set(s.tc, s.hash);
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
    let s = dealFromSnapshot(start, seed, rules);
    checkHash(s);
    checkRefusals(s);
    for (const entry of log) {
      if (play && me !== null && isObject(entry) && entry.seat === me) {
        const n = entry.n;
        const source = entry.source === 'auto' ? 'auto' : 'player';
        if (source === 'player') {
          if (play.ledgerFrom !== null && isInt(n) && n >= play.ledgerFrom) {
            // Any move this client sent and the log has not used yet may be the one: a move that reaches
            // the table late (after its clock ran out, say) is played on the seat's next turn if still legal.
            // Of several, the likeliest: one the host did not refuse, made on the latest turn.
            const match = sent.filter((x) => !x.used && x.tc <= n && sameActionSafe(x.action, entry.action, s, me)).sort((a, b) => Number(!!a.rejected) - Number(!!b.rejected) || b.tc - a.tc)[0];
            if (match) {
              match.used = true;
              // The host cannot have played this move before this device sent it: a fixed point between the two clocks.
              const f = frameAfter(n);
              if (f && typeof match.at === 'number' && typeof f.now === 'number' && f.epoch === match.epoch && f.at >= match.at) anchors.push({ at: match.at, now: f.now, epoch: f.epoch });
            } else if (sent.some((x) => !x.used && !x.rejected && x.tc <= n)) problems.add(`The log changed a move this seat made (turn ${n})`);
            else problems.add(`The log shows a move this seat never made (turn ${n})`);
          }
        } else {
          let couldWin = false;
          try {
            couldWin = legalActions(s, me).some((a) => a.type === 'hu');
          } catch {
            couldWin = false;
          }
          if (couldWin && entry.action?.type !== 'hu') problems.add(`The table played for this seat and passed up its win (turn ${String(n)})`);
          if (isInt(n) && this.autoWasEarly(play, n, end, rules, anchors)) problems.add(`The table played for this seat while it was connected and its clock had not run out (turn ${n})`);
          // A legal move this device sent for this turn long before, over a link that never dropped, was left
          // lying. (Only moves sent since this client began vouching for the log: before that none are matched.)
          const after = isInt(n) ? frameAfter(n) : null;
          if (after && play.ledgerFrom !== null && sent.some((x) => !x.used && x.tc >= (play.ledgerFrom as number) && x.tc <= n && x.epoch === after.epoch && typeof x.at === 'number' && after.at - x.at > MOVE_SLACK_MS && !(x.refusedAt !== undefined && x.refusedAt <= n) && legalFor(s, me, x.action) && !sameActionSafe(x.action, entry.action, s, me))) {
            problems.add(`The table ignored a move this seat sent in good time and played its own instead (turn ${n})`);
          }
        }
      }
      s = applyAction(s, entry.seat, entry.action);
      checkHash(s);
      checkRefusals(s);
    }
    // States shown for turns the log never reached: the log was cut short or rewritten.
    for (const tc of shown.keys()) if (tc > s.turnCounter) problems.add(`The state this seat was shown at turn ${tc} is not in the replay`);
    failures.push(...problems);
    return s;
  }

  /**
   * True when the log has the table moving for this seat at turn `n` although this client's link
   * was up throughout and the seat's time had not run out. How long the seat had is worked out
   * from the rules and from what this client saw earlier in the hand (`expiryBound`), never from
   * the clock fields of the frame alone; how long it was given is read from the host's time
   * stamps, which are believed only as far as this device's own clock allows: the host cannot
   * have played a move before this device sent it, so from any such move on, no more time can
   * pass on the host's clock than passes here.
   */
  private autoWasEarly(play: PlayRecord, n: number, end: SeenState | null, rules: RuleSet, anchors: ClockAnchor[]): boolean {
    let a: SeenState | null = null;
    let b: SeenState | null = null;
    for (const s of play.seen) {
      if (s.tc <= n) a = s;
      else if (!b) b = s;
    }
    if (!b) b = end;
    if (!a || !b || a.epoch !== b.epoch || !a.owes) return false;
    if (a.deadline === null || typeof b.now !== 'number') return true;
    // What the frame itself says can only add time: a host that re-armed the clock (a rejoin) knows more than this client.
    const claimed = a.inBank ? a.deadline : a.deadline + a.timeBank * 1000;
    const expiry = Math.max(this.expiryBound(play, a, rules), claimed);
    if (b.now < expiry - CLOCK_SLACK_MS) return true;
    for (const k of anchors) if (k.epoch === b.epoch && b.now - k.now > b.at - k.at + CLOCK_SKEW_MS) return true;
    // With no such fixed point yet, the host's clock may still not leap ahead of every frame before it.
    let minOffset = Number.POSITIVE_INFINITY;
    for (const s of play.seen) if (s.epoch === a.epoch && s.tc <= n && typeof s.now === 'number') minOffset = Math.min(minOffset, s.at - s.now);
    return b.at - b.now < minOffset - LATENCY_SLACK_MS;
  }

  /**
   * The earliest moment, on the host's clock, at which an honest table could time this seat out of
   * the move it owes in frame `a`: the rules' turn clock from the frame in which the seat came to
   * owe the move, plus the time bank it had then. The bank starts each hand at the rules' value
   * and shrinks only by the time the seat's earlier moves took past the turn clock. Across a lost
   * link this client cannot know what the seat spent, so there it takes the bank the next frame
   * states; the bound itself never moves back within a hand (an honest table's never does).
   */
  private expiryBound(play: PlayRecord, a: SeenState, rules: RuleSet): number {
    const turn = rules.turnSeconds * 1000;
    const fullBank = rules.timeBankSeconds * 1000;
    // The host rounds the bank to whole seconds.
    const stated = (f: SeenState) => Math.min(fullBank, Math.max(0, f.timeBank * 1000 - 500));
    // The first frame is the deal itself only if this client watched the deal over the same unbroken link.
    const rec = this.recordFor(play.hand);
    const fromDeal = rec !== null && rec.attempts.length > 0 && !rec.linkLost;
    let bound = Number.NEGATIVE_INFINITY;
    let bank: number | null = null;
    /** The frame in which the seat came to owe its current move; `known` when its clock started with that frame. */
    let run: { start: SeenState; known: boolean } | null = null;
    let prev: SeenState | null = null;
    for (const f of play.seen) {
      const fresh = prev === null || prev.epoch !== f.epoch;
      if (fresh) {
        // A new link: a move owed in its first frame may have been on the clock for a while already.
        const deal = prev === null && fromDeal && f.tc === 0;
        run = f.owes ? { start: f, known: deal && typeof f.now === 'number' } : null;
        bank = deal ? fullBank : f.owes ? null : stated(f);
        if (run?.known) bound = Math.max(bound, (f.now as number) + turn + fullBank);
      } else if (f.owes && !run) {
        run = { start: f, known: typeof f.now === 'number' };
        if (run.known) bound = Math.max(bound, (f.now as number) + turn + (bank ?? 0));
      } else if (!f.owes && run) {
        const began = run.start.now;
        if (run.known && bank !== null && typeof f.now === 'number' && typeof began === 'number') bank = Math.max(0, bank - Math.max(0, f.now - began - turn));
        else bank = stated(f);
        run = null;
      } else if (!f.owes && bank === null) bank = stated(f);
      if (f === a) break;
      prev = f;
    }
    return bound;
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

/** Whether `action` is a legal move for `seat` in `s`; false for anything malformed. */
function legalFor(s: GameState, seat: number, action: Action): boolean {
  try {
    return isLegal(s, seat, action);
  } catch {
    return false;
  }
}

/** sameAction that never throws on a malformed log entry. */
function sameActionSafe(a: Action, b: unknown, s: GameState, seat: number): boolean {
  if (!isObject(b) || typeof b.type !== 'string') return false;
  try {
    return sameAction(a, b as unknown as Action, s, seat);
  } catch {
    return false;
  }
}

/** The match state the hand after `prev` starts from, or null when there is none. */
function nextHand(prev: GameState): MatchSnapshot | null {
  if (prev.phase !== 'ended' || !prev.result) return null;
  try {
    return advanceMatch(prev);
  } catch {
    return null;
  }
}

/** Reconstruct the match snapshot at the start of a hand from a view of it. */
function snapshotFromView(v: TableView, fromEnd = false): MatchSnapshot {
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
