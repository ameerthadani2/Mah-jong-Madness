/**
 * What the table client keeps (`ClientCore`, the base of `TableClient`): its state as the app shows it (`ClientState`),
 * every record it keeps of the table with what each is for, its constructor, and the steps every part of the client
 * takes on them: send a frame, update the state, flag a hand, find the hand it is on, keep the records of the last
 * hands. The client is built on it one concern a file: `clientledger.ts` (the hands it follows), `clientwatch.ts` (the
 * link watch and the clocks), `clientaudit.ts` (the audit of a hand, its replay in `clientreplay.ts`), `clientframes.ts`
 * (what it does with each frame) and `client.ts` (`TableClient` itself: what the app calls, saving and restoring).
 */
import type { BotSkill, HandResult, MatchSnapshot, RuleSet, TableView } from '@mjm/engine';
import type { Commitment } from './fairness';
import { randomHex } from './sha256';
import type { Link } from './host';
import { CLOCK_FRAME_MS, type Audit, type ClientMessage, type SeatInfo } from './messages';
import type { Unsubscribe } from './transport';
import { clientClock, type ClockBase, type TableClientOptions } from './clientclock';
import type { LateScope } from './clientmoves';
import type { CeremonyRecord, GapStart, PlayRecord, RunScope, SentAction, SerializedClient } from './clientrecords';
import type { AuditStatus, LateTurnRecord, PassedClaimRecord } from './clientwords';

export interface ChatLine {
  seat: number;
  name: string;
  text: string;
  at: number;
}

/** A hand this client found red, as the app keeps it apart from the record of the table (`redHands`, `keepRed`). */
export interface RedHand {
  matchId: string;
  hand: number;
  /** Its first few failures, each cut short (they are this client's own sentences: `failureKey` reads them). */
  failures: string[];
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
  /**
   * The first welcome of this client said another device had held the seat since this device last did (`heldElsewhere`):
   * the moves credited to the player from the latest turn this device was shown may be that device's. The app saves the
   * record at once when this turns true, so the next client restored from it knows (src/game/persist.ts).
   */
  heldElsewhere: boolean;
}

/** Audits kept (and saved) per table. */
export const MAX_AUDITS = 50;
/** Hands whose play and ceremony records are kept: the one on show and the ones just before (see `trimHands`). */
export const MAX_HAND_RECORDS = 3;
/** Hands whose flags are kept until they are audited (see `flag`). */
const MAX_FLAGGED_HANDS = 12;
/** How many clock eras restart notices may begin while one hand is on show (`noteRestore`); the second makes it amber. */
export const MAX_RESTART_ERAS = 2;

export abstract class ClientCore {
  /** Bind the client to a link (`TableClient`, client.ts): the constructor binds the first. */
  protected abstract bind(link: Link): void;

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
    heldElsewhere: false,
  };
  protected secret: string | null = null;
  /**
   * The commitment sets this client was shown, one per hand (a hand's is cleared by each new attempt at its deal), for
   * the last few hands (`MAX_HAND_RECORDS`; never the hand this client is on). A set is kept under the hand it names: a
   * frame about another hand neither replaces nor empties it, so the set this client revealed against is the one the
   * audit is held to (`setFor`).
   */
  protected commitSets: Array<{ hand: number; commits: Commitment[] }> = [];
  /** Hand our current secret was committed for. */
  protected commitHand: number | null = null;
  /**
   * The hand this client was on when a frame about a later hand's deal (its commitments, or a share the host made for
   * this seat) reached it: honest only when that hand ended while this device had no link, and the host sent no record
   * of it, so no frame about it may follow (`aboutHand`). Cleared when the client moves on to another hand, or a restart
   * notice says the table was restored.
   */
  protected aheadOf: number | null = null;
  /**
   * The link epoch on which the table last seated this client (its `welcome`). Until that link goes the table holds the
   * seat for it there, unless it takes the seat away on that link (a club's eviction, `evicted`) or opens it on another
   * device (`disconnected`, `kicked`).
   */
  protected seatedOn = -1;
  /**
   * The link epoch the table last welcomed this client on, and the one it took the seat away on (`evicted`). On a link
   * where this client holds no seat (before its welcome, or after an eviction) an honest host sends nothing about the
   * table: the `TableHost` answers a connection it seats no one on only with `pong` and `error` frames that refuse no
   * move (`not_seated`, `full`, `already_seated`), and the server takes an evicted connection out of the room.
   */
  protected welcomedOn = -1;
  protected evictedOn = -1;
  /** Hand for which the host says it supplied our share. */
  protected standInHand: number | null = null;
  /** The hand already under way when we first saw the table (we could not take part in its deal). */
  protected joinedHand: number | null = null;
  /** First hand this client saw any message about. */
  protected firstHand: number | null = null;
  /** Built from a rejoin token alone, with no record of what came before. */
  protected noHistory = false;
  /**
   * Built with neither a rejoin token nor a record, and not yet on any hand. Such a client sits down in the lobby, or
   * takes its account's own seat back part-way through a match (a server-hosted table gives a signed-in account its seat
   * back without the token: from another device, or a link that brought no token), so the first hand it hears of may be
   * any, and until then it cannot tell which (see `enterHand`, which clears it).
   */
  protected fresh = false;
  /**
   * This client was built with neither a rejoin token nor a record, and has taken up none since (`takeUp`): the first run of
   * this device at the table, so every move this device sent there went out in this run, and is on its record. (An earlier
   * device that held the seat had another device id: the table's welcome says so, `elsewhere`.)
   */
  protected firstRun = false;
  /**
   * A record this device kept of the table at this room (`fromArchive`), not yet taken up: it is at the table's first word
   * about the table, unless that is a welcome naming another match (`takeUp`).
   */
  protected pending: SerializedClient | null = null;
  /** Red hands kept apart from the record (`keepRed`) for a kept record not yet taken up: they go with it. */
  protected pendingRed: unknown = null;
  /**
   * The link on which this client gave up a kept record because the welcome named another match: its join said which hands
   * of that other match the device held (`have`), and the records an honest table sends in answer, of its own match, are
   * not this client's to judge (it joined with nothing).
   */
  protected haveOfOther = -1;
  /** Hands whose `hand_over` we received. */
  protected handsEnded = new Set<number>();
  /** Host misbehaviour seen during each hand. */
  protected tamper = new Map<number, string[]>();
  /** Match snapshot at the start of the current hand, needed to replay the audit. */
  protected handStart: MatchSnapshot | null = null;
  /** Ceremony records of the last few hands. */
  protected records: CeremonyRecord[] = [];
  /** What this client saw and sent while the last few hands were played. */
  protected plays: PlayRecord[] = [];
  /** Where the last verified hand left the match: the next hand must start exactly there. */
  protected expected: MatchSnapshot | null = null;
  /** Hand number already compared against `expected`. */
  protected chainChecked: number | null = null;
  /** Bot seats as they stood at the match's first commit request; nobody becomes or stops being a bot after it. */
  protected frozenBots: number[] | null = null;
  /** The rules as they stood at the match's first commit request. */
  protected pinnedRules: RuleSet | null = null;
  /** The table's bot strength as its last welcome gave it; null when that welcome did not say (an older host). */
  protected tableSkill: BotSkill | null = null;
  /**
   * The bot strength as it stood at the match's first commit request, or null before then. The
   * table's moves for seats are recomputed with it (`tableRule`). `unpublished`: the host did not
   * say, and a hand in which the table moved for a bot or a seat out of time fails. `unknown`: this
   * client was restored from a save written before the strength was kept, so it cannot know what
   * the table said, and such hands stay amber.
   */
  protected pinnedSkill: BotSkill | 'unknown' | 'unpublished' | null = null;
  /** Link epoch: bumped on every link loss, rebind and restore. */
  protected epoch = 0;
  /**
   * Clock era: the host's clock is one clock for as long as the host runs, whatever happens to
   * this device's links, so what this client learns about it holds across links and hands. Only a
   * restart the host announces begins a new era, since its clock may have started afresh.
   */
  protected era = 0;
  /** What the hands of this match already audited established about the host's clock in one era (see `offsetFloor`). */
  protected clockBase: ClockBase = { era: 0, anchor: null, minOffset: null };
  /** The last time-stamped frame received: a state, or a hand's end. */
  protected lastStamp: GapStart | null = null;
  /**
   * While a hand is played, the longest the host may leave this seat without a frame: the protocol's
   * `CLOCK_FRAME_MS`, or less when the `welcome` announces less. A welcome cannot lengthen it, and one
   * that says nothing leaves it at `CLOCK_FRAME_MS`: the bound is this client's, not the server's.
   */
  protected clockMs = CLOCK_FRAME_MS;
  /** When the watch asked the link in use for a `pong` because its stamps had fallen behind (see `checkLink`); null when it has not. */
  protected probedAt: number | null = null;
  /**
   * The least arrival offset (`at - now`: this device's clock when a stamped frame arrived, less the
   * host's stamp on it) seen in this clock era and run of this device's clock (`clientClock`'s
   * `segment`), and when it was seen. It is how far ahead of the host's clock this device's is, plus
   * the shortest one-way delay seen; the audit measures the frames after it against it, and the
   * watch's reference (`watchRefAt`) is never less.
   */
  protected lagRef: { lag: number; at: number; era: number; seg: number } | null = null;
  /** The highest stamp received in that scope: the watch measures how far it trails this device's clock (see `checkLink`). */
  protected stampHigh: number | null = null;
  /**
   * The arrival offsets of the stamped frames of that scope that arrived in the last
   * `WATCH_WINDOW_MS` (and of the last frame before them), the least of each second: the watch
   * measures against the least of them (`watchRefAt`). Frames handled just after a pause are left
   * out (they may have waited in the device).
   */
  protected lagWin: Array<{ from: number; at: number; lag: number }> = [];
  /** With no `lagRef` to measure against (a new clock era, or this device's clock just followed a sleep), when the watch began to wait. */
  protected waitFrom: number | null = null;
  /** This run of the app (a restored client is a new run, its clock read from the wall anew): fixed points are compared only within one. */
  protected readonly runId = randomHex(4);
  /**
   * Pings this run sent that no pong has answered yet, by the `at` each carried (the host echoes it),
   * with the run of this device's clock it was read in and the hand it was sent for (`handOnShow`; null:
   * none). Never saved: a pong is a fixed point only within the run of the app and of its clock that sent
   * the ping.
   */
  protected readonly pings = new Map<number, { seg: number; hand: number | null; epoch: number; out: number }>();
  /** Frames this run has sent so far (`send`): the place of each in the order they went out. Never saved. */
  private outCount = 0;
  /** The place among the frames this run sent (`outCount`) at which each move it filed went out (`act`; `markReached`). Never saved. */
  protected readonly movesOut = new WeakMap<SentAction, number>();
  /** The last `MAX_PAUSES` stretches of this run in which the app did not run (see `ran`; saved with the record, `runScopes`): no frame's lateness and no move's wait is the server's doing while they last. */
  protected readonly pauses: Array<{ from: number; to: number }> = [];
  /** When this client last published a round trip (`rttMs`; see `RTT_PUBLISH_MS`). */
  protected rttAt: number | null = null;
  /**
   * The id this client gives the host as its device (`join.device`): the first run's id, kept across
   * app restarts. On a rejoin the host says whether another device held the seat since (`welcome.elsewhere`).
   */
  protected deviceId: string = this.runId;
  /** This client (this run of the app) has been welcomed at the table: a later welcome is a rejoin. */
  protected welcomed = false;
  /**
   * The link in use has brought a frame this client handled. An honest host answers a join with its
   * welcome before anything else, so only a welcome that is a link's first frame is a rejoin's.
   */
  protected heardOnLink = false;
  /** The strongest fixed point of the hands audited in this era, run of the app and run of this device's clock (see `lateAnchor`). */
  protected bestAnchor: LateScope['best'] = null;
  /** The same, of their pongs alone, each weighed less `DRIFT_RATE` for every ms since it was taken: what the Fair play count measures the next hand's first turns against. */
  protected bestPong: LateScope['best'] = null;
  /**
   * What the earlier runs of the app whose frames the record holds carried (their strongest fixed points and their
   * pauses), as each saved it: a frame such a run saw is measured in its scope, as that run measured it
   * (`LateScope.earlier`). Restored from the record; this run's own is saved beside them (`serialize`).
   */
  protected earlier: RunScope[] = [];
  /** When this app last ran: it handled a frame, checked the link, bound a link or sent a move. */
  protected ranAt: number | null = null;
  /** The last stretch of more than `RAN_GAP_MS` in which this app did not run (the phone slept, or the app was in the background). */
  protected pause: { from: number; to: number } | null = null;
  /** After the watch finds that this app was not running, it neither probes nor calls the link silent before this. */
  protected graceUntil = Number.NEGATIVE_INFINITY;
  /** When the link in use was bound: nothing on it arrived earlier. */
  protected boundAt = Number.NEGATIVE_INFINITY;
  /** The earliest the frame being handled can have arrived: earlier than now only just after a pause, when it may have waited in the device. */
  protected frameAtLo: number | null = null;
  /** The link epoch that has brought a state or a hand's end stamped not late against `lagRef` (-1: none yet). A client's first link counts from the start. */
  protected workingEpoch = -1;
  protected firstLink = true;
  /** The link in use has brought a stamped frame: the watch measures it from then (a link that brings nothing is the heartbeat's to drop). */
  protected linkStamped = false;
  /**
   * The link in use has not closed. What this device measures of the table (the pings, the link watch) runs while
   * it holds a seat on such a link, whether or not the table has welcomed it there (`connected`): an honest host
   * welcomes a link before it sends anything else on it, and one that never does must not turn the measures off.
   */
  protected linkOpen = true;
  /**
   * The link on which this client learnt that its seat was opened on another device (`seatTaken`): it takes nothing
   * more from it. An honest host sends nothing more to a link once another device takes its seat, so a frame that comes
   * there anyway is not shown, played on or measured; the player takes the seat back from Home, on a new link.
   */
  protected kickedLink: Link | null = null;
  /**
   * The link the table took this seat away on (`error` `evicted`): an honest server takes an evicted connection out of the
   * room, so nothing about the table comes on it after that. Any frame there fails the hand on show and is not taken.
   */
  protected evictedLink: Link | null = null;
  /** When `checkLink` last ran. */
  protected checkedAt: number | null = null;
  /**
   * When the watch began to measure the link in use without a break: null while it does not (no hand
   * is played, the app did not run, the watch's grace after that, a link that has brought no stamp),
   * and restarted when its checks were more than `RAN_GAP_MS` apart. A frame counts as live only if
   * the watch measured it long enough to have dropped the link before an honest frame was that late.
   */
  protected watchFrom: number | null = null;
  /** The latest stamp on a frame of the link in use (its epoch and the host's clock era). */
  protected linkStamp: { epoch: number; era: number; now: number } | null = null;
  /** The last state frame of the link in use: its hand and turn. */
  protected linkShown: { epoch: number; hand: number; tc: number } | null = null;
  /**
   * Link epochs that ended by this device's own doing, or with its record in doubt: it left the
   * table, its seat was opened on another device, or the app restarted. What the table played for
   * the seat after one of them is noted, never judged: the table plays at once for a player who left.
   */
  protected ownAbsences: number[] = [];
  /**
   * Stretches without a link in which the table played for this seat, by the arrival time of the
   * last frame before them, and whether the first such move came after a whole clock. Later moves
   * in the same stretch, in the same hand or the next, are covered by the first.
   */
  protected gapVerdicts: Array<{ at: number; ok: boolean }> = [];
  /** Epoch of the last commit request. */
  protected ceremonyEpoch = -1;
  /** Epoch in which the view on show arrived. */
  protected viewEpoch = -1;
  /** Epoch in which this client last watched a hand end (or first sat down): no link loss since means it saw everything after. */
  protected quietSince = -1;
  /**
   * The hand this client is on: the one it was last asked to commit to or shown, until that hand's
   * result arrives. While it is set, the table has no business with any other hand.
   */
  protected openHand: number | null = null;
  /** Epoch of the last message about `openHand`: no link loss since means the hand cannot have ended unseen. */
  protected handEpoch = -1;
  /** The match ended, and the hands this client verified say so (see `matchEndVerdict`). */
  protected matchEnded = false;
  /**
   * This client sat down in the lobby and has not yet seen a hand end: the first hand it is dealt
   * must be the match's first, from the rules' starting position, whatever number the host gives it.
   */
  protected atStart = false;
  /** A hand reached after hands this client missed with no record of them: its starting scores cannot be checked. */
  protected gapHand: number | null = null;
  /**
   * The hand after one whose record did not replay (or could not be read): nothing chains into it, so its start is checked
   * against nothing and its audit says so (`unchained`). Honest records always replay.
   */
  protected brokenHand: number | null = null;
  /** The link the last `join` went over, and the last hand of the match it said this client held the end of (`have`). */
  protected joinHave: { epoch: number; have: number | undefined } | null = null;
  /** The link on which the record of the hand this client is on (`openHand`) last came as a `hand_missed`. */
  protected openRecordOn = -1;
  /**
   * Some hand of this match began from scores this client could not check (see `noteGap`). The hands
   * after it chain from it, so the final scores rest on it: the end of the match may be real, but
   * its scores are not shown as verified.
   */
  protected chainGap = false;
  /**
   * A hand this device missed carries moves credited to its seat. The device watched none of
   * them, so the end of the match may be checked, but it is not shown as verified.
   */
  protected missedMoves = false;
  /** The entry `failNow` last put on the list of audits (so the next failure about the same hand adds to it). */
  protected liveFailure: ClientState['audits'][number] | null = null;
  /**
   * Hands the host said it resumed from a snapshot after a restart, and the turn it resumed at
   * (-1: before the deal). `undone`: this client had been shown more than that, and dropped it.
   */
  protected rewinds: Array<{ hand: number; tc: number; undone: boolean; again?: true }> = [];
  /**
   * The hand on show (`activeHand`) when a restart notice last began a clock era: a server may announce one restart
   * per hand, so a second notice while the same hand is on show, for another hand, begins none (`noteRestore`).
   */
  protected eraHand: number | null = null;
  /** How many clock eras restart notices began while `eraHand` was on show: at most `MAX_RESTART_ERAS` (`noteRestore`). */
  protected erasInHand = 0;
  /**
   * The link in use opened as a returning seat's does: its first frame was the `welcome`, and only the records of the
   * hands it missed (and frames that name no hand) have followed. A restarted table's notice comes here and nowhere
   * else (`TableHost.onJoin`), once per link.
   */
  protected opening = false;
  /**
   * This client was restored from a saved record, which may be a moment older than the last thing
   * the app did before it stopped, or built from a rejoin token with no record at all: `lapse`
   * until it next hears of a hand, then `lapseHand` is that hand, whose deal it may have taken
   * part in without a note of it surviving.
   */
  protected lapse = false;
  protected lapseHand: number | null = null;
  /** The restored record did not show `lapseHand` as dealt: its deal was agreed, or may have begun, around the restart. */
  protected lapseDeal = false;
  protected readonly listeners = new Set<(s: ClientState) => void>();
  protected unsubMessage: Unsubscribe = () => undefined;
  protected unsubClose: Unsubscribe = () => undefined;
  protected link: Link;
  protected readonly now: () => number;
  /** The app's journal of moves (`TableClientOptions.writeAhead`): every move goes to it before it goes out. Null: none. */
  protected readonly writeAhead: NonNullable<TableClientOptions['writeAhead']> | null;
  /** What the app's journal held when this client was restored (`TableClientOptions.journal`), until the record is loaded. */
  protected journal: readonly unknown[] | undefined;
  /** Where the app keeps records of matches by match id (`TableClientOptions.keptRecord`): asked once, then null. */
  protected keptRecord: TableClientOptions['keptRecord'] | null;
  /** Red hands the app kept of a match, for a client that holds no record of it, until its welcome names the match. */
  protected redLater: unknown = null;
  /** The seat's count of moves between devices as the last welcome this client took said it (`welcome.handovers`; saved). */
  protected handovers: number | null = null;
  /**
   * A record was taken up at this link's welcome (`lookUpKept`): the record was made under the device id of the client that
   * made it, and this client joined under its own, so the table counted that join as one move of the seat.
   */
  protected tookUpAtWelcome = false;
  /** The place of the last move this client filed (`SentAction.seq`), over every run of the app. */
  protected seq = 0;
  /**
   * The link epoch on which the table answered a ping after its welcome there, before that link brought any state. An
   * honest host sends a seat the state of the hand it is playing right behind the welcome, before it answers the ping the
   * app sends behind its join (`TableHost.onJoin` answers the join in one step, and frames keep their order on a link):
   * after such an answer, the link's first state can only be a deal's (turn 0). A later turn, or the end of a hand this
   * device had been shown, was held back (`noteHeld`).
   */
  protected pongAfterWelcome = -1;
  /**
   * The link epoch on which the table answered a ping after its welcome there before the link brought any frame about a
   * hand: the table had no hand under way when it seated this client there. The first state of a hand this device had been
   * shown before, on that link (its turn 0 included), was held back (`noteHeld`).
   */
  protected pongBeforeHand = -1;
  /** This device's clock when the welcome of the link in use came (`welcomeEpoch`; in the run of its clock `welcomeSeg`): the state the table owes right behind it is held back when the host's own stamp puts it much later (`lateWelcome`). */
  protected welcomeAt: number | null = null;
  protected welcomeEpoch = -1;
  protected welcomeSeg = 0;
  /**
   * First states of links that came with no answer before them to a ping sent after the join, of a later turn of a hand
   * this device had been shown: each one's stamp, its clock era, the welcome it came behind, when the join went, and the
   * turn from which what the table played for the seat fails when the stamp, placed on this device's clock by an answer to
   * a ping sent since that join in the same era and run of its clock (`checkLateWelcome`), shows the host sent it more than
   * `LATE_MS` after that welcome came.
   */
  protected lateWelcome: Array<{ hand: number; from: number; stamp: number; era: number; seg: number; welcomeAt: number; after: number }> = [];
  /** The link epoch on which the table answered a ping sent after this client's join there (`joinOut`). */
  protected pongOn = -1;
  /** The link this client last sent a `join` on, that frame's place among the frames this run sent (`outCount`), and when it went. */
  protected joinOut: { epoch: number; out: number; at: number } | null = null;
  /** The link epoch on which a frame about a hand came (a deal under way, a state, a result): see `runFromHand`. */
  protected handFrameOn = -1;
  /**
   * The first hand this run of the app saw begin, or could tell would begin, while it held the seat: it saw the hand
   * before it end, or the table had no hand under way when it welcomed this run (its welcome and the answer to the ping
   * behind the join came with no frame about a hand between them). Every move this device sent in such a hand was sent
   * in this run, so this client knows them all. Null: none yet. Never saved.
   */
  protected runFromHand: number | null = null;
  /** This client was restored with the app's journal, and the journal vouched for the record (`takeJournal`): it knows every move this device sent. */
  protected journalWhole = false;
  /**
   * The server said another device held the seat (a seat-taken notice, or a welcome that says so), and this device has
   * not been shown the hand since it was welcomed back: the hand it is shown next was the other device's up to that
   * state (`PlayRecord.otherDevice`). Saved with the record.
   */
  protected elsewhereOpen = false;

  constructor(
    link: Link,
    protected readonly name: string,
    protected readonly avatar?: string,
    protected readonly identity: { token?: string; userId?: string } = {},
    opts: TableClientOptions = {},
  ) {
    this.link = link;
    this.now = clientClock(opts);
    this.writeAhead = opts.writeAhead ?? null;
    this.journal = opts.journal;
    this.keptRecord = opts.keptRecord ?? null;
    this.bind(link);
    if (identity.token) {
      this.state = { ...this.state, token: identity.token };
      this.noHistory = true;
      // Whatever an earlier run of the app did at this table is unknown: the deal of the first hand
      // this client hears of may have been agreed, in part, before it existed.
      this.lapse = true;
    } else {
      this.fresh = true;
      this.firstRun = true;
    }
  }

  /** The run of this device's clock (see `clientClock`): it moves on when the clock follows the wall across a sleep. */
  protected seg(): number {
    return (this.now as unknown as { segment?: number }).segment ?? 0;
  }

  /** Send a frame on the link in use; returns its place among the frames this run has sent (`outCount`). */
  protected send(msg: ClientMessage): number {
    this.link.send(msg);
    return ++this.outCount;
  }

  protected update(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  protected flag(hand: number, problem: string): void {
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
  protected activeHand(): number {
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

  /** Keep `list` (entries of hands, oldest first) to `max` entries without giving up the hand this client is on (`handToDrop`). */
  protected trimHands<T>(list: T[], max: number, handOf: (x: T) => number): void {
    while (list.length > max) {
      const drop = this.handToDrop(list, handOf);
      list.splice(drop === null ? 0 : list.indexOf(drop), 1);
    }
  }

  /** The first state of a hand we were never asked to commit to: we arrived after its deal. */
  protected noteHand(hand: number): void {
    if (this.firstHand !== null) return;
    this.firstHand = hand;
    if (this.commitHand !== hand && this.standInHand !== hand) this.joinedHand = hand;
  }

  /** The link dropped (or was replaced): a new epoch, and a ceremony under way was not watched whole. */
  protected noteLinkLost(): void {
    this.epoch++;
    const rec = this.records[this.records.length - 1];
    if (rec && !rec.dealt) rec.linkLost = true;
  }

  /** The link in use (or the one of `epoch`) ends by this device's own doing, or with its record in doubt (see `ownAbsences`). */
  protected noteOwnAbsence(epoch = this.epoch): void {
    if (!this.ownAbsences.includes(epoch)) this.ownAbsences.push(epoch);
    if (this.ownAbsences.length > 16) this.ownAbsences.shift();
  }

  protected recordFor(hand: number): CeremonyRecord | null {
    return this.records.find((r) => r.hand === hand) ?? null;
  }

  /** The commitment set this client holds for hand `h` (null: none). */
  protected setFor(h: number): Commitment[] | null {
    return this.commitSets.find((x) => x.hand === h)?.commits ?? null;
  }

  protected playFor(hand: number): PlayRecord {
    let play = this.plays.find((p) => p.hand === hand);
    if (!play) {
      // With the app's journal, every move this client sends in the hand goes to it first (`act`).
      play = { hand, seen: [], sent: [], ledgerFrom: null, ...(this.writeAhead ? { whole: true as const } : {}) };
      this.plays.push(play);
      this.trimHands(this.plays, MAX_HAND_RECORDS, (p) => p.hand);
    }
    return play;
  }
}
