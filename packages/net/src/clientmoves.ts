/**
 * The moves the table makes for a seat, and when it may make them: the rule every host publishes
 * for a bot and for a seat out of time (`tableRule`), and, for this client's own seat, whether its
 * clock had run out when the table played for it (`judgeTableMove`, over the clock this client
 * followed through the hand, `clockTrack`). The replay that calls them, and writes what they find
 * as failures, is the client's (`TableClient.replayChecked`).
 */
import { BOT_SKILLS, chooseAction, isLegal, legalActions, sameAction, type Action, type BotSkill, type GameState, type RuleSet } from '@mjm/engine';
import { CLOCK_SLACK_MS, offsetFloor, type ClockBase } from './clientclock';
import { isObject, type CeremonyRecord, type ClockAnchor, type ClockTrack, type GapStart, type PlayRecord, type SeenState } from './clientrecords';

/** What the table-move checks read of this client's clock record, and keep: `gapVerdicts` grows as stretches without a link are judged. */
export interface MoveJudge {
  clockBase: ClockBase;
  gapVerdicts: Array<{ at: number; ok: boolean }>;
  ownAbsences: number[];
}

/**
 * Whether the table was entitled to the move the log has it making for this seat at turn `n`.
 *
 * Over one unbroken link (`early` when not): the seat's time must have run out. How long the
 * seat had is worked out from the rules and from what this client saw earlier in the hand
 * (`clockTrack`), never from the clock fields of the frame alone; how long it was given is read
 * from the host's time stamps, which are believed only as far as this device's own clock allows
 * (`offsetFloor`). `unanchored`: nothing was wrong that this device can see, but after a restart
 * of the host it has no fixed point yet to measure the stamps against.
 *
 * Across a change of link, the move was made while this device had none. A seat that drops keeps
 * its clock, so the first such move needs a whole clock to have run out: what was left of the
 * move the seat owed in the last frame before, or, when its turn came later, a whole turn clock
 * and the bank it had. That is measured on this device's clock, from the last frame it held to
 * the first one after: `downEarly` when the time between is too short, `down` (the hand shows
 * that the table played for the seat) otherwise. Later moves in the same stretch are covered by
 * the first (`gaps` holds the stretches this replay has judged). Where this device left of its own accord, or has no measure of the stretch, the
 * move is noted and not judged.
 */
export function judgeTableMove(j: MoveJudge, play: PlayRecord, n: number, end: SeenState | null, rules: RuleSet, anchors: ClockAnchor[], track: ClockTrack, gaps: Set<number>): 'ok' | 'early' | 'downEarly' | 'down' | 'unanchored' {
  let a: SeenState | null = null;
  let b: SeenState | null = null;
  for (const f of play.seen) {
    if (f.tc <= n) a = f;
    else if (!b) b = f;
  }
  if (!b) b = end;
  if (!b) return 'ok';
  // What the frame itself says can only add time: a host that re-armed the clock (a rejoin) knows more than this client.
  const claimed = !a || a.deadline === null ? Number.NEGATIVE_INFINITY : a.inBank ? a.deadline : a.deadline + a.timeBank * 1000;
  if (a && a.epoch === b.epoch) {
    if (!a.owes) return 'ok';
    if (a.deadline === null || typeof b.now !== 'number') return 'early';
    const expiry = Math.max(track.bound.get(a) ?? Number.NEGATIVE_INFINITY, claimed);
    if (b.now < expiry - CLOCK_SLACK_MS) return 'early';
    const era = b.era ?? 0;
    const floor = offsetFloor(j.clockBase, era, play, n, anchors);
    if (floor === null || b.at - b.now < floor) return 'early';
    // A host that says it restarted is given a new clock era, and until this seat has moved or
    // revealed in it nothing ties its stamps to this device's clock but the 30 s for network
    // delay. That is too loose to say the seat's time had run out: the hand cannot be green.
    // (A fixed point made after this turn began does not help: the stamps may have leapt before it.)
    const fixed = (j.clockBase.era === era && j.clockBase.anchor !== null) || anchors.some((k) => k.era === era && k.at <= a.at);
    return era > 0 && !fixed ? 'unanchored' : 'ok';
  }
  const from: GapStart | null = a ? (typeof a.now === 'number' ? { at: a.at, now: a.now, epoch: a.epoch, era: a.era ?? 0 } : null) : (play.before ?? null);
  const startAt = a ? a.at : play.before?.at;
  // The seat's first frame of the match came after the move: this device was not at the table yet.
  if (startAt === undefined) return 'ok';
  // A later move of this hand in a stretch already judged: the first one spoke for it.
  if (gaps.has(startAt)) return 'ok';
  gaps.add(startAt);
  const known = j.gapVerdicts.find((g) => g.at === startAt);
  if (known) return known.ok ? 'down' : 'downEarly';
  let verdict: 'down' | 'downEarly' = 'down';
  const since = a ? a.epoch : (play.before as GapStart).epoch;
  const own = j.ownAbsences.some((e) => e >= since && e < (b as SeenState).epoch);
  if (!own && from) {
    const turn = rules.turnSeconds * 1000;
    const expiry = !a ? from.now + turn + rules.timeBankSeconds * 1000 : a.owes ? Math.max(track.bound.get(a) ?? Number.NEGATIVE_INFINITY, claimed) : from.now + turn + (track.bank.get(a) ?? 0);
    const floor = offsetFloor(j.clockBase, from.era, a ? play : null, a ? a.tc : -1, anchors);
    if (Number.isFinite(expiry)) {
      // The moment `expiry` on the host's clock is no earlier than `expiry + floor` on this one.
      if (floor !== null && b.at < expiry + floor - CLOCK_SLACK_MS) verdict = 'downEarly';
      // And the host's own stamp may not say it moved before then.
      else if (a && (a.era ?? 0) === (b.era ?? 0) && typeof b.now === 'number' && b.now < expiry - CLOCK_SLACK_MS) verdict = 'downEarly';
    }
  }
  j.gapVerdicts.push({ at: startAt, ok: verdict === 'down' });
  if (j.gapVerdicts.length > 8) j.gapVerdicts.shift();
  return verdict;
}

/**
 * Follow this seat's clock through the frames of a hand. For each frame: the earliest moment, on
 * the host's clock, at which an honest table could time the seat out of the move it owes there
 * (the rules' turn clock from the frame in which the seat came to owe the move, plus the time
 * bank it had then), and the bank itself. The bank starts each hand at the rules' value and
 * shrinks only by the time the seat's earlier moves took past the turn clock.
 *
 * Across a lost link this client cannot see what the seat spent, but it knows how long it was
 * gone: the first frame of the new link may not state a bank lower than the one tracked less
 * that time (`bankTaken`), and a move owed in that frame cannot have been on the clock for
 * longer than that either. The bound never moves back within a hand (an honest table's never
 * does), except where the host says it restarted and its clock may have started afresh.
 */
export function clockTrack(clockBase: ClockBase, rec: CeremonyRecord | null, play: PlayRecord, rules: RuleSet, anchors: ClockAnchor[]): ClockTrack {
  const turn = rules.turnSeconds * 1000;
  const fullBank = rules.timeBankSeconds * 1000;
  // The host rounds the bank to whole seconds.
  const stated = (f: SeenState) => Math.min(fullBank, Math.max(0, f.timeBank * 1000 - 500));
  // The first frame is the deal itself only if this client watched the deal over the same unbroken link.
  const fromDeal = rec !== null && rec.attempts.length > 0 && !rec.linkLost;
  const out: ClockTrack = { bound: new Map(), bank: new Map(), bankTaken: [] };
  let bound = Number.NEGATIVE_INFINITY;
  let bank: number | null = null;
  /** The frame in which the seat came to owe its current move; `known` when its clock started with that frame. */
  let run: { start: SeenState; known: boolean } | null = null;
  let prev: SeenState | null = null;
  for (const f of play.seen) {
    const fresh = prev === null || prev.epoch !== f.epoch || (prev.era ?? 0) !== (f.era ?? 0);
    if (fresh) {
      // A new link: a move owed in its first frame may have been on the clock for a while already.
      const deal = prev === null && fromDeal && f.tc === 0;
      // The last frame before this link, the bank the seat had then, and the stamp from which a
      // whole clock had to run before the seat could be out of time for a move it owes now.
      let last: GapStart | null = null;
      let had: number | null = null;
      let whole: number | null = null;
      if (prev) {
        if (typeof prev.now === 'number') last = { at: prev.at, now: prev.now, epoch: prev.epoch, era: prev.era ?? 0 };
        had = bank;
        const began: SeenState | null = run ? (run.known ? run.start : null) : prev;
        whole = began && typeof began.now === 'number' ? began.now : null;
        // A move pending in that frame has taken from the bank whatever it ran over the turn clock;
        // one whose start this client did not see may have taken any amount.
        if (run && !run.known) had = null;
        else if (had !== null && run && last && whole !== null) had = Math.max(0, had - Math.max(0, last.now - whole - turn));
        if ((prev.era ?? 0) !== (f.era ?? 0)) bound = Number.NEGATIVE_INFINITY;
      } else if (!deal && play.before) {
        // The hand was dealt while this device was away, and every deal starts with a full bank.
        last = play.before;
        had = fullBank;
        whole = play.before.now;
        if (play.before.era !== (f.era ?? 0)) bound = Number.NEGATIVE_INFINITY;
      }
      const floor = last ? offsetFloor(clockBase, last.era, prev ? play : null, prev ? prev.tc : -1, anchors) : null;
      run = f.owes ? { start: f, known: deal && typeof f.now === 'number' } : null;
      bank = deal ? fullBank : f.owes ? null : stated(f);
      if (run?.known) bound = Math.max(bound, (f.now as number) + turn + fullBank);
      if (last && floor !== null) {
        // The longest this device can have been without a frame, on the host's side.
        const gone = Math.max(0, f.at - (last.now + floor));
        if (had !== null && f.timeBank * 1000 < had - gone - CLOCK_SLACK_MS) out.bankTaken.push(f.tc);
        if (f.owes && whole !== null && typeof f.now === 'number') bound = Math.max(bound, f.now + turn + (had ?? 0) - Math.max(0, f.at - (whole + floor)));
      }
    } else if (f.owes && !run) {
      run = { start: f, known: typeof f.now === 'number' };
      if (run.known) bound = Math.max(bound, (f.now as number) + turn + (bank ?? 0));
    } else if (!f.owes && run) {
      const began = run.start.now;
      if (run.known && bank !== null && typeof f.now === 'number' && typeof began === 'number') bank = Math.max(0, bank - Math.max(0, f.now - began - turn));
      else bank = stated(f);
      run = null;
    } else if (!f.owes && bank === null) bank = stated(f);
    out.bound.set(f, bound);
    out.bank.set(f, bank);
    prev = f;
  }
  return out;
}

/** Whether `action` is a legal move for `seat` in `s`; false for anything malformed. */
export function legalFor(s: GameState, seat: number, action: Action): boolean {
  try {
    return isLegal(s, seat, action);
  } catch {
    return false;
  }
}

export function isBotSkill(x: unknown): x is BotSkill {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(BOT_SKILLS, x);
}

/**
 * What the table plays for a seat, by the rule every host publishes (`TableHost.timeoutAction` and
 * `runBots`). `timeout`: a human seat whose clock ran out, or that is away after its link dropped,
 * takes a win when offered, passes any other claim on another seat's discard, and otherwise plays
 * as a bot of at least Club strength with the seed `timeout:<seat>`. `bot`: a bot seat, or a seat
 * whose player left on purpose, plays as a bot of the table's strength with the seed
 * `<matchId>:bot<seat>`. Null when the rule gives nothing (no legal move).
 */
export function tableRule(s: GameState, seat: number, rule: 'timeout' | 'bot', skill: BotSkill, matchId: string): Action | null {
  try {
    if (rule === 'timeout') {
      if (s.phase === 'claim') {
        const offered = legalActions(s, seat);
        if (offered.some((a) => a.type === 'hu')) return { type: 'hu' };
        if (offered.some((a) => a.type === 'pass')) return { type: 'pass' };
      }
      return chooseAction(s, seat, { seed: `timeout:${seat}`, skill: skill === 'beginner' ? 'club' : skill }) ?? { type: 'pass' };
    }
    return chooseAction(s, seat, { seed: `${matchId}:bot${seat}`, skill });
  } catch {
    return null;
  }
}

/** sameAction that never throws on a malformed log entry. */
export function sameActionSafe(a: Action, b: unknown, s: GameState, seat: number): boolean {
  if (!isObject(b) || typeof b.type !== 'string') return false;
  try {
    return sameAction(a, b as unknown as Action, s, seat);
  } catch {
    return false;
  }
}

