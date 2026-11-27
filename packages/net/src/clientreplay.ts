/**
 * The replay of a hand (`replayHand`, from the table client's audit): the log is replayed from where the hand started,
 * every state and view this seat was shown must be in it, every move credited to the player must be one this client
 * sent and the table did not refuse, and every move the table made for the seat must have come after its clock ran out
 * (`judgeTableMove`, clientmoves.ts). It reads the client only through `ReplayInputs`, which `ClientAudit.replayChecked`
 * hands it.
 */
import { dealFromSnapshot, hashState, legalActions, viewFor, applyAction, type Action, type BotSkill, type GameState, type LoggedAction, type MatchSnapshot, type RuleSet } from '@mjm/engine';
import { BANK_ROUND_MS, LATE_MS, NO_ANSWER_PINGS, type ClockBase } from './clientclock';
import { armedLate, clockTrack, firstSend, flightAllowance, heldLive, judgeTableMove, lateAnchor, lateBy, lateCountMs, lateLimitMs, lateRef, legalFor, ownRun, pausedIn, restartInRun, sameActionSafe, scopeOf, seatRun, seenHere, streakEnd, tableRule, turnLateBy, unanswered, unstamped, type LateScope, type MoveJudge, type PongClock } from './clientmoves';
import { isInt, isObject, ledgerVouches, otherDeviceAt, unjournaledAt, viewDigest, type CeremonyRecord, type ClockAnchor, type PlayRecord, type SeenState } from './clientrecords';
import type { PassedClaim } from './clientwords';
import type { ClientState } from './clientcore';

/** A move sent this long before the table's own move for the same turn arrived, time the app did not run left out, was not lost to a slow network. */
export const MOVE_SLACK_MS = 30_000;
/** Marks, among the problems of a replay, a move the table made for this seat that is judged once the replay is done. */
const JUDGE_LATER = '\u0000table move ';

/** What a replay noticed that makes a hand amber rather than green. */
export interface ReplayNotes {
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
  /** The log credits this seat with a move it made on an earlier turn, in place of the move it made on that turn or of a claim it could make there (`AUDIT_CAVEATS.lateCopy`). */
  lateCopy?: boolean;
  /** The table answered none of the pings this device sent during the hand (`AUDIT_CAVEATS.noAnswer`). */
  noAnswer?: boolean;
  /** The log credits the player with a move this device did not send, in a stretch the server said another device held the seat in (`AUDIT_CAVEATS.otherDevice`). */
  otherDevice?: boolean;
  /** The log credits the player with a move the restored record does not hold, in a stretch a restore without the app's journal left open (`AUDIT_CAVEATS.journalLost`). */
  journalLost?: boolean;
  /** Claims the table passed for this seat while its link was down, or on a turn that reached this device late (`late`), in turn order. */
  passedClaims?: Array<{ turn: number; claim: PassedClaim; late?: boolean }>;
  /** The seat's turns whose state reached this device late enough to be counted (`lateCountMs`, or `lateLimitMs` without pong fixed points), and how many of its turns it could measure. */
  lateTurns?: number[];
  turnsMeasured?: number;
}
/**
 * What the replay reads of the table client (`ClientAudit.replayChecked` hands it over): its state, its record of each
 * hand, the bot strength and bot seats it pinned for the match, the link epochs it left the table in, what it learnt of
 * the host's clock, its run of the app, and three of its readings: a hand's ceremony record, the scope its fixed points
 * are measured in, and what the check of a move the table made for the seat rests on.
 */
export interface ReplayInputs {
  readonly state: ClientState;
  readonly plays: PlayRecord[];
  readonly pinnedSkill: BotSkill | 'unknown' | 'unpublished' | null;
  readonly tableSkill: BotSkill | null;
  readonly frozenBots: number[] | null;
  readonly ownAbsences: number[];
  readonly clockBase: ClockBase;
  readonly runId: string;
  recordFor(h: number): CeremonyRecord | null;
  lateScope(pongs?: boolean): LateScope;
  moveJudge(h: number): MoveJudge;
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
export function replayHand(c: ReplayInputs, start: MatchSnapshot, seed: string, rules: RuleSet, log: LoggedAction[], h: number, end: SeenState | null, failures: string[], anchors: ClockAnchor[] = [], notes?: ReplayNotes, unseen?: PlayRecord): GameState {
  const me = c.state.seat;
  const play = end ? (c.plays.find((p) => p.hand === h) ?? unseen ?? null) : null;
  /** The hand is one this device saw nothing of (`hand_missed`). */
  const missed = unseen !== undefined && play === unseen;
  const shown = new Map<number, string>();
  /** The digests of the views this seat was shown at each turn (`SeenState.view`): every one must be the replayed state's view. */
  const views = new Map<number, Set<string>>();
  // A state restored damaged (`cleanSeen`: its check figure did not match) may hold any hash or view: it is not compared.
  for (const s of play?.seen ?? []) {
    if (s.kept === false) continue;
    if (!shown.has(s.tc)) shown.set(s.tc, s.hash);
    if (typeof s.view === 'string') views.set(s.tc, (views.get(s.tc) ?? new Set<string>()).add(s.view));
  }
  /** Some state of this hand was restored damaged: a clock check that may rest on it fails nothing, it makes the hand amber. */
  const doubt = play?.seen.some((f) => f.kept === false) === true;
  /** The moves this seat sent or the refusals of them were restored damaged (`movesKept`): a check of the table's answers resting on them fails nothing either. */
  const movesDoubt = play?.movesKept === false;
  // Not every state the table sent in this hand was kept: what was dropped cannot be checked.
  if (play?.overflow === true && notes) notes.overflow = true;
  const checkHash = (s: GameState) => {
    const want = shown.get(s.turnCounter);
    if (want !== undefined && hashState(s) !== want) failures.push(`The state this seat was shown at turn ${s.turnCounter} is not in the replay`);
    shown.delete(s.turnCounter);
    const seen = views.get(s.turnCounter);
    if (seen && me !== null) {
      const own = viewDigest(viewFor(s, me));
      if ([...seen].some((d) => d !== own)) failures.push(`The view of the table this seat was shown at turn ${s.turnCounter} is not the replayed one`);
      views.delete(s.turnCounter);
    }
  };
  /**
   * The moves this client sent, in the order sent. `legal`: whether the move was legal in the state of the turn it was
   * made on; `copyOf`: the first move sent on that turn that is the same move there (itself, or one it repeats: a second
   * tap, or the move made again on a new link) (`noteLegal`). What the table did with each, as the replay finds it: `used`,
   * it played it, at turn `playedAt` (`take`); `refusedAt`, a refusal answered it in order, and the turn the host's frames had reached when that
   * refusal came (`takeRefusals`); `passed`, the table took it up without an answer, or it was lost with its link (`take`).
   */
  const sent = (play?.sent ?? []).map((x) => ({ ...x, used: false, playedAt: -1, legal: undefined as boolean | undefined, copyOf: -1, refusedAt: undefined as number | undefined, passed: false }));
  type Sent = (typeof sent)[number];
  /** Note, for each move made on the turn of state `s`, whether it was legal there (the state the seat acted on), and which it repeats. */
  const noteLegal = (s: GameState) => {
    if (me === null) return;
    for (const x of sent) {
      if (x.tc !== s.turnCounter || x.legal !== undefined) continue;
      x.legal = legalFor(s, me, x.action);
      x.copyOf = sent.findIndex((z) => z.tc === x.tc && sameActionSafe(z.action, x.action, s, me));
    }
  };
  /**
   * The copy rule: which move this client sent a move the log credits to its player at turn `n` is. An honest host takes a
   * link's frames in the order they were sent, and answers each move by playing it, at the turn it reached the table at if
   * it is legal there, or by a refusal naming the turn it was made on; a new link the table seats the player on ends the
   * old one there (its first state is the turn the table had reached). So the move it played at `n` is the first move
   * still unanswered on the link the seat held at `n`, that is the move the log shows, tile for tile (`sameMove`):
   * - not one a refusal answered in order (`takeRefusals`), nor one the table took up before (`passed`);
   * - not one sent before a move of the same link the log played earlier, nor one over a link before the latest link a
   *   played move went out on (`lastPlayed`, `lastLink`);
   * - not one over a link that ended before `n` (`linkEnd`: a later link of this hand had brought a state of an earlier turn);
   * - not one made after `n`, nor one the table had already taken up by `n`: the table answered a ping sent after it over
   *   the same link while this hand's state was at `n` or before (`SentAction.byTurn`; not from moves restored damaged).
   * With no such move the entry is not the player's own (`copyFor` gives null).
   */
  const sameMove = (a: Action, b: unknown): boolean => {
    if (!isObject(b) || b.type !== a.type) return false;
    if (a.type === 'discard' || a.type === 'kong') return b.tile === a.tile;
    if (a.type === 'chi') return Array.isArray(b.tiles) && b.tiles.length === 2 && b.tiles[0] === a.tiles[0] && b.tiles[1] === a.tiles[1];
    return true;
  };
  /**
   * For each link (by its epoch, which only grows, over every run of the app), the earliest turn of this hand a state it
   * brought showed. Only states as this device read them: one restored without its check figure (`kept: false`, storage
   * changed it, or an earlier build saved it) may hold any epoch and turn, and must not end a link early.
   */
  const firstOn = new Map<number, number>();
  for (const f of play?.seen ?? []) if (f.kept !== false && isInt(f.epoch) && isInt(f.tc) && f.tc < (firstOn.get(f.epoch) ?? Number.POSITIVE_INFINITY)) firstOn.set(f.epoch, f.tc);
  /** The last turn at which the table can have played a move that went out over link `epoch`: before a later link's first state of this hand. */
  const linkEnd = (epoch: number): number => {
    let end = Number.POSITIVE_INFINITY;
    for (const [e, tc] of firstOn) if (e > epoch && tc - 1 < end) end = tc - 1;
    return end;
  };
  /** The index in `sent` of the last move of each link (by epoch) the log played, and the latest link a played move went out on. */
  const lastPlayed = new Map<number, number>();
  let lastLink = Number.NEGATIVE_INFINITY;
  /** The refusals of this seat's moves in the order they came, each answering in turn the first move of its link and turn still unanswered there. */
  const refs = (play?.refusals ?? []).map((r) => ({ ...r, done: false }));
  /**
   * Answer with every refusal that came while the host's frames were at turn `n` or before: an honest host sent each one
   * before it played the move at `n` (once it had, its next state would have come first). A refusal answers the first move,
   * after the last one of its link the log played, of its link and turn that is still unanswered; one that answers none
   * (a move the table had already taken up, or none at all) answers nothing. Refusals restored damaged (`movesDoubt`)
   * answer nothing either: storage may have moved one onto another move.
   */
  const takeRefusals = (n: number) => {
    if (movesDoubt) return;
    for (const r of refs) {
      if (r.done || r.at > n) continue;
      r.done = true;
      const from = r.epoch === undefined ? -1 : (lastPlayed.get(r.epoch) ?? -1);
      const x = sent.find((z, i) => i > from && !z.used && !z.passed && z.refusedAt === undefined && z.tc === r.tc && (r.epoch === undefined || z.epoch === r.epoch) && (r.run === undefined || z.run === r.run));
      if (x) x.refusedAt = r.at;
    }
  };
  /**
   * The moves the copy rule allows for an entry of action `action` at turn `n`, in the order sent (the first is the copy);
   * with `reached` false, also those the table had already taken up by then (`SentAction.byTurn`).
   */
  const copiesFor = (action: unknown, n: number, reached = true): Sent[] =>
    sent.filter(
      (x, i) =>
        !x.used &&
        !x.passed &&
        x.refusedAt === undefined &&
        x.tc <= n &&
        sameMove(x.action, action) &&
        x.epoch >= lastLink &&
        i > (lastPlayed.get(x.epoch) ?? -1) &&
        n <= linkEnd(x.epoch) &&
        !(reached && !movesDoubt && isInt(x.byTurn) && x.byTurn <= n),
    );
  /** The log played `y` at turn `n`: every move before it over its link still unanswered, and every one over an earlier link, was taken up without an answer or lost. */
  const take = (y: Sent, n: number) => {
    const yi = sent.indexOf(y);
    for (let k = 0; k < yi; k++) {
      const x = sent[k];
      if (!x.used && x.refusedAt === undefined && x.epoch <= y.epoch) x.passed = true;
    }
    y.used = true;
    y.playedAt = n;
    lastPlayed.set(y.epoch, yi);
    lastLink = Math.max(lastLink, y.epoch);
  };
  /**
   * An honest host answers a link's moves in the order they came, each by playing it or by a refusal naming its turn,
   * before anything later of that link is played. So once the log plays move `y` (the `yi`-th sent) at turn `n`, every move
   * sent before it over the same link in the same run of the app must have been played already, or refused by a refusal
   * that came before the state showing `y` (one naming its turn that arrived while the host's frames were at turn `n` or
   * before, in order: `takeRefusals`): a refusal that came after that state is out of order and answers nothing. True when
   * such a move, legal on the turn it was made on, was neither: the table lost it, whatever turn `y` falls on. A copy of `y`
   * itself made on its turn (sent twice) is not one of them.
   */
  const droppedBefore = (yi: number, n: number, sameAsY: (x: Sent) => boolean): boolean => {
    const y = sent[yi];
    if (!y || !play) return false;
    // The link `y` went out over brought what came after its play (frames keep their order on a link): every answer
    // the table sent over it before that play has come too. When another link brought it, an answer to an earlier move
    // may have been lost with the link that broke, and a move of an earlier turn is not held against the table.
    const after = frameAfter(n);
    const whole = !!after && after.epoch === y.epoch && after.run === y.run;
    for (let k = 0; k < yi; k++) {
      const x = sent[k];
      if (x.used || x.refusedAt !== undefined || x.epoch !== y.epoch || x.run !== y.run || (x.tc === n && sameAsY(x))) continue;
      // A repeat of a move the log played (the same move on the same turn, sent again, on this link or another): that move
      // was answered. Which of the copies the table played cannot be told, and the player loses nothing either way.
      if (x.copyOf >= 0 && sent.some((z) => z.used && z.tc === x.tc && z.copyOf === x.copyOf)) continue;
      // A move of an earlier turn than `y`'s, it reaching the table late: judged only over a link that brought what came
      // after `y` (above), and not when it is a pass (the table's own rule for a seat out of time passes too, so the player
      // loses nothing), or the same tile discarded or declared a kong again on a later turn (played there late, perhaps:
      // which copy the table played cannot be told, unless the table had taken this one up before that turn,
      // `SentAction.byTurn`). On `y`'s own turn none of this holds: that move was legal in the very state the table played
      // `y` in, so an honest table would have played it.
      if (x.tc < n) {
        if (!whole || x.action.type === 'pass') continue;
        const tile = (x.action.type === 'discard' || x.action.type === 'kong') && isInt(x.action.tile) ? x.action.tile : null;
        const before = (t: number) => !movesDoubt && isInt(x.byTurn) && x.byTurn <= t;
        if (tile !== null && sent.some((z) => z.used && z.action.type === x.action.type && (z.action as { tile?: unknown }).tile === tile && !before(z.playedAt))) continue;
      }
      if (x.legal === true) return true;
    }
    return false;
  };
  const problems = new Set<string>();
  /** A finding that rests on the moves this seat sent and the refusals of them: the hand fails, or, with those restored damaged (`movesDoubt`), it is amber. */
  const onMoves = (finding: string) => {
    if (!movesDoubt) problems.add(finding);
    else if (notes) notes.damaged = true;
  };
  // The host refuses only what is not legal in the state it is in. Each refusal names the turn
  // the move was made on; it is excused by one move this client sent on that turn that was not
  // legal in the state the host's own frames showed when the refusal arrived.
  const checkRefusals = (s: GameState) => {
    if (!play || me === null) return;
    const here = (play.refusals ?? []).filter((r) => r.at === s.turnCounter);
    for (const tc of new Set(here.map((r) => r.tc))) {
      const excused = sent.filter((x) => x.tc === tc && !legalFor(s, me, x.action)).length;
      if (here.filter((r) => r.tc === tc).length > excused) onMoves(`The host refused a legal move this seat made (turn ${s.turnCounter})`);
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
  const skill = c.pinnedSkill ?? c.tableSkill ?? 'unpublished';
  const bots = new Set(c.frozenBots ?? []);
  const matchId = c.state.matchId ?? '';
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
    return c.ownAbsences.some((e) => e >= since && e < b.epoch);
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
  noteLegal(s);
  /** The turn of this seat's last move in the log so far (-1: none), and, for each table move, the one before it. */
  let lastMine = -1;
  const prevOf = new Map<number, number>();
  /**
   * The latest turn so far at which this seat was asked nothing (it had no legal move in the state the replay had reached:
   * another seat's turn, a claim it was not offered or had answered). A move of this seat made before that turn was
   * made for a decision that had closed by then (`lateCopy`, below).
   */
  let idleAt = -1;
  /** This seat could claim or win in state `st` (a legal move other than a pass). */
  const couldClaim = (st: GameState, seat: number): boolean => {
    try {
      return legalActions(st, seat).some((a) => a.type !== 'pass');
    } catch {
      return false;
    }
  };
  const scope = c.lateScope();
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
  const track0 = play ? clockTrack(c.clockBase, c.recordFor(play.hand), play, rules, anchors) : null;
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
    const here = seenHere(r0, c.runId);
    // (Or it arrived behind a frame of its link stamped later, the answer to a ping say: the host held it, `noteOrder`.)
    if ((here && (armedLate(r0, rules) || r0.behind === true)) || heldLive(r0, c.runId)) problems.add(`The host showed this seat its turn late, on a link that stayed open (turn ${n})`);
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
    // The refusals the host sent before it played this turn answer their moves first.
    takeRefusals(s.turnCounter);
    if (me !== null) {
      try {
        if (legalActions(s, me).length === 0) idleAt = s.turnCounter;
      } catch {
        // (A state the engine cannot read is judged by the replay below.)
      }
    }
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
          // The move this client sent that an honest host could have played here (the copy rule, `copiesFor`): a move that
          // reaches the table late (after its clock ran out, say) is played at the turn it reached the table at, if still
          // legal there, given the order of its link.
          let copies = copiesFor(entry.action, n);
          // Only a move the table had taken up before this turn (it answered a ping sent after it over the same link while
          // the state this device was shown was at this turn or before): the log can be true only if the table held its
          // state back behind that answer. The move is taken as the one played, and the hand fails for the hold.
          if (copies.length === 0) {
            copies = copiesFor(entry.action, n, false);
            if (copies.length > 0) problems.add(`The host held back its frames on a link that stayed open, then played for this seat (turn ${n})`);
          }
          const match = copies[0];
          if (match) {
            // A legal move this seat sent before this one, over the same link, that the log did not play and no refusal
            // answered in order (`droppedBefore`): whatever else came back (another code, a refusal naming another turn,
            // one that came after the state showing this move, nothing), the table lost it and played this one.
            take(match, n);
            if (droppedBefore(sent.indexOf(match), n, (x) => sameActionSafe(x.action, entry.action, s, me))) onMoves(`The table left a move this seat sent unanswered and played another of its moves in its place (turn ${n})`);
            // A move made on an earlier turn, played here in place of another move this seat made on this very turn: a
            // connection slow toward the table does that, and so does a server that held the earlier move back and played
            // it here. This device cannot tell the two apart: the hand is amber (`lateCopy`). Not when the move went out
            // only once this turn was on show here (it waited for the app's journal, `SentAction.out`): nothing held it.
            const outAt = match.out ?? match.at;
            const onShow = play.seen.find((f) => f.kept !== false && f.tc === n && f.run === match.run && (f.seg ?? 0) === (match.seg ?? 0));
            const sentLate = typeof outAt === 'number' && !!onShow && outAt >= onShow.at;
            if (match.tc < n && notes && !sentLate && sent.some((x) => x !== match && x.tc === n && x.legal === true && !sameActionSafe(x.action, entry.action, s, me))) notes.lateCopy = true;
            // So is a pass made for a decision that had closed before this turn (the seat was asked nothing at a turn in
            // between: its clock ran out and the table moved for it, or the claim it answered was settled), played here,
            // where the seat could have claimed or won: a pass that reached an honest table late is played so, and so is
            // one a server kept back (a second tap, or a pass it dropped) to take a claim or a win from the seat. The same,
            // amber. (Not other moves of an earlier decision: a player on a slow connection often makes a move again, or
            // another in its place, and none of those takes a claim away.)
            if (idleAt > match.tc && notes && !sentLate && isObject(entry.action) && entry.action.type === 'pass' && couldClaim(s, me)) notes.lateCopy = true;
            judgeShown(play, n, prevMine);
            // The host cannot have played this move before this device sent it: a fixed point between the
            // two clocks. Of copies of the same move sent more than once, the first counts (the host may
            // have played that one), with the round trip from it to the first frame that shows the move.
            const f = frameAfter(n);
            const first = firstSend(copies.map((x) => ({ ...x, at: x.out ?? x.at })));
            // (Not from moves restored damaged, `movesDoubt`: the time a move was sent may then be any.)
            if (!movesDoubt && f && f.kept !== false && first && typeof first.at === 'number' && typeof f.now === 'number' && f.epoch === first.epoch && f.at >= first.at) anchors.push({ at: first.at, now: f.now, era: f.era ?? 0, run: first.run, seg: first.seg, fat: f.at });
          } else if (sent.some((x) => !x.used && x.refusedAt === undefined && x.tc <= n)) problems.add(`The log changed a move this seat made (turn ${n})`);
          else problems.add(`The log shows a move this seat never made (turn ${n})`);
        } else if (isInt(n)) {
          // A move from before this device could vouch for its ledger (an app restart, or the seat opened on
          // another device, came in between): whoever sent it, the state that showed this seat the turn is
          // judged as any other, so a server gains nothing by making the app start again.
          judgeShown(play, n, prevMine);
          // But not one at or after a turn whose state the host held back on a link that stayed open (`held`): nothing an
          // honest host does marks that, and a server that holds the table back can credit moves to the player unseen.
          if (play.held !== undefined && n >= play.held) problems.add(`The host held back its frames on a link that stayed open, then played for this seat (turn ${n})`);
          else {
            // A move this device sent that the copy rule allows here is its own (the order of its link goes on from it).
            const match = copiesFor(entry.action, n)[0] ?? copiesFor(entry.action, n, false)[0];
            if (match) take(match, n);
            // In a stretch the server said another device held the seat in, any other may have been made on that device.
            // It is not held against the table, but nothing vouches for it: the hand is amber and the end of the match is
            // not shown as verified (`otherDevice`).
            else if (otherDeviceAt(play, n) && notes) notes.otherDevice = true;
            // In a stretch a restore without the app's journal left open in a hand whose every move went to the journal, it
            // may be one this device sent after the record was written: amber, and the end not verified (`journalLost`).
            else if (unjournaledAt(play, n) && notes) notes.journalLost = true;
          }
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
          // (Timed from when the move went out: one filed with the app's journal waited for its write first, `SentAction.out`.)
          const timely = (x: (typeof sent)[number] & { at: number }): boolean => {
            const e = endIn(x.run);
            const t = x.out ?? x.at;
            return e !== null && t >= e.shown && t + flightAllowance({ ...x, at: t }, anchors, scope, limit) <= e.ends;
          };
          if (r0 && sent.some((x) => lying(x) && x.tc >= r0.tc && timely(x))) notes.inFlight = true;
        }
        // One left lying for more than `MOVE_SLACK_MS` (time the app was not running left out) over a link
        // that never dropped: no network is that slow. Counted from when it went out: a move filed with the app's
        // journal waits for the journal's write first (`SentAction.out`), and one whose going out is not known (given
        // back by the journal to a restored client) is not counted.
        const outAt = (x: (typeof sent)[number] & { at: number }): number | null => (typeof x.out === 'number' ? x.out : x.seq === undefined ? x.at : null);
        const leftLying = (x: (typeof sent)[number] & { at: number }): boolean => {
          const t = outAt(x);
          return after !== null && t !== null && after.at - t - pausedIn(scopeOf(scope, x.run)?.pauses ?? [], t, after.at) > MOVE_SLACK_MS;
        };
        if (after && sent.some((x) => lying(x, true) && leftLying(x))) {
          if (after.kept === false) {
            if (notes) notes.damaged = true;
          } else onMoves(`The table ignored a move this seat sent in good time and played its own instead (turn ${n})`);
        }
      }
    }
    if (isObject(entry)) checkRule(s, entry);
    s = applyAction(s, entry.seat, entry.action);
    checkHash(s);
    checkRefusals(s);
    noteLegal(s);
  }
  // States shown for turns the log never reached: the log was cut short or rewritten.
  for (const tc of shown.keys()) if (tc > s.turnCounter) problems.add(`The state this seat was shown at turn ${tc} is not in the replay`);
  const track = play ? clockTrack(c.clockBase, c.recordFor(play.hand), play, rules, anchors) : null;
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
    const pongScope = c.lateScope(true);
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
    const verdict = judgeTableMove(c.moveJudge(h), play, n, end, rules, anchors, track, gaps, prevOf.get(n) ?? -1, scope, pong);
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
