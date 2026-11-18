/**
 * The moves the table makes for a seat, and when it may make them: the rule every host publishes
 * for a bot and for a seat out of time (`tableRule`), and, for this client's own seat, whether its
 * clock had run out when the table played for it (`judgeTableMove`, over the clock this client
 * followed through the hand, `clockTrack`). The replay that calls them, and writes what they find
 * as failures, is the client's (`TableClient.replayChecked`).
 */
import { BOT_SKILLS, chooseAction, isLegal, legalActions, sameAction, type Action, type BotSkill, type GameState, type RuleSet } from '@mjm/engine';
import { ARM_SLACK_MS, CLOCK_SLACK_MS, DRIFT_RATE, LATE_MS, offsetFloor, RTT_ALLOW_MS, type ClockBase } from './clientclock';
import { isObject, type CeremonyRecord, type ClockAnchor, type ClockTrack, type GapStart, type PlayRecord, type SeenState } from './clientrecords';

/** What the table-move checks read of this client's clock record, and keep: `gapVerdicts` grows as stretches without a link are judged. */
export interface MoveJudge {
  clockBase: ClockBase;
  gapVerdicts: Array<{ at: number; ok: boolean }>;
  ownAbsences: number[];
}

/** The run of the app (`TableClient.runId`) a fixed point is compared in, and the strongest fixed point of the hands already audited in it. */
export interface LateScope {
  run: string;
  best: { era: number; run: string; seg: number; value: number; at: number } | null;
}

/** How much later than the least arrival offset of its scope (clock era and run of this device's clock) allows `f` reached this device; 0 when nothing is known. */
export function lateRef(f: SeenState): number {
  if (typeof f.now !== 'number' || typeof f.ref !== 'number') return 0;
  return (f.atLo ?? f.at) - f.now - f.ref;
}

/**
 * How much later `f` reached this device than the fixed points made before it in its scope allow
 * (this device's moves and shares, which the host cannot have answered before they were sent),
 * beyond an uplink's allowance (`RTT_ALLOW_MS`). It sees a delay present since the scope began,
 * which the least arrival offset absorbs; a slow uplink looks the same, so it never fails a hand by
 * itself. 0 when there is no fixed point, or `f` arrived in another run of the app.
 */
export function lateAnchor(f: SeenState, anchors: ClockAnchor[], scope: LateScope | null): number {
  if (typeof f.now !== 'number' || !scope || f.run !== scope.run) return 0;
  const atLo = f.atLo ?? f.at;
  const era = f.era ?? 0;
  const seg = f.seg ?? 0;
  let a = Number.NEGATIVE_INFINITY;
  const b = scope.best;
  if (b && b.era === era && b.run === f.run && b.seg === seg && b.at <= atLo) a = b.value - DRIFT_RATE * (atLo - b.at);
  for (const k of anchors) if (k.era === era && k.run === f.run && (k.seg ?? 0) === seg && k.at <= atLo) a = Math.max(a, k.at - k.now - DRIFT_RATE * (atLo - k.at));
  return Number.isFinite(a) ? atLo - f.now - (a + RTT_ALLOW_MS) : 0;
}

/**
 * The frames that showed this seat the move it makes at turn `n`: the last frame at or before `n`,
 * and the frames before it that showed the seat owing a move since its previous move (`prevMove`),
 * from the first (`i0`). Empty when that last frame owed nothing, or came before the previous move.
 */
export function seatRun(play: PlayRecord, n: number, prevMove: number): { run: SeenState[]; i0: number } {
  let iA = -1;
  for (let i = 0; i < play.seen.length; i++) if (play.seen[i].tc <= n) iA = i;
  if (iA < 0 || !play.seen[iA].owes || play.seen[iA].tc <= prevMove) return { run: [], i0: -1 };
  let i0 = iA;
  while (i0 > 0 && play.seen[i0 - 1].owes && play.seen[i0 - 1].tc > prevMove) i0--;
  return { run: play.seen.slice(i0, iA + 1), i0 };
}

/**
 * The state that first showed this seat a move (`r0`), over a link that had already brought it an
 * earlier state (or its share for the hand), did not give a whole turn clock by its own deadline and
 * stamp: it was in the bank already, or its deadline was less than the turn clock (less
 * `ARM_SLACK_MS`) after its stamp. An honest host stamps that state in the tick it arms the clock.
 */
export function armedLate(r0: SeenState, rules: RuleSet): boolean {
  if (!r0.onLink || typeof r0.now !== 'number' || r0.deadline === null) return false;
  return r0.inBank || r0.deadline - r0.now < rules.turnSeconds * 1000 - ARM_SLACK_MS;
}

/**
 * The clock check of a table move at turn `n`, from the frame `a` (the last this device holds at or
 * before `n`, or null) to `b` (the first after it, or the hand's end).
 *
 * Over one unbroken link (`early` when not): the seat's time must have run out. How long the
 * seat had is worked out from the rules and from what this client saw earlier in the hand
 * (`clockTrack`), never from the clock fields of the frame alone; how long it was given is read
 * from the host's time stamps, which are believed only as far as this device's own clock allows
 * (`offsetFloor`). `unanchored`: nothing was wrong that this device can see, but after a restart
 * of the host it has no fixed point yet to measure the stamps against.
 *
 * Across a change of link, or with `gap` (from a frame before a state the audit could not believe
 * was timely), the move was made while this device had no timely view of the table. A seat that
 * drops keeps its clock, so the first such move needs a whole clock to have run out: what was left
 * of the move the seat owed in the last frame before, or, when its turn came later, a whole turn
 * clock and the bank it had. That is measured on this device's clock, from the frame it held to the
 * first one after: `downEarly` when the time between is too short, `down` (the hand shows that the
 * table played for the seat) otherwise. Later moves in the same stretch are covered by the first
 * (`gaps` holds the stretches this replay has judged). Where this device left of its own accord, or
 * has no measure of the stretch, the move is noted and not judged.
 */
function judgeFrom(j: MoveJudge, play: PlayRecord, n: number, rules: RuleSet, anchors: ClockAnchor[], track: ClockTrack, gaps: Set<number>, a: SeenState | null, b: SeenState, gap: boolean): 'ok' | 'early' | 'downEarly' | 'down' | 'unanchored' {
  // What the frame itself says can only add time: a host that re-armed the clock (a rejoin) knows more than this client.
  const claimed = !a || a.deadline === null ? Number.NEGATIVE_INFINITY : a.inBank ? a.deadline : a.deadline + a.timeBank * 1000;
  if (a && a.epoch === b.epoch && !gap) {
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
 * Whether the table was entitled to the move the log has it making for this seat at turn `n`.
 *
 * First, whether this device was shown the move in good time. An honest host sends every turn's
 * state to every seat it has a link to, so when the last frame before the move (`a`) and the first
 * after it came over one link, `a` must be the state of turn `n` and show the seat owing the move:
 * a state skipped on a link that stayed open was held back (`held`). Then the run of states that
 * showed the seat the move since its previous move (`seatRun`) is judged by its first state, `r0`:
 * - on a link that had already brought this device a state, `r0` must give the whole turn clock by
 *   its own deadline and stamp (`armedLate`): `lateTurn` when not, unless the move was early anyway;
 * - over a live link (`SeenState.live`), `r0` may not be more than `LATE_MS` later than the least
 *   arrival offset of its scope allows (`lateRef`): `held` when it is, since the watch drops a link
 *   long before an honest frame on it is that late;
 * - later than that over a link that was not live, later than the fixed points of its scope allow
 *   (`lateAnchor`, which a slow uplink can also cause), or first shown on a link that was not yet
 *   working with less than a whole clock (less `LATE_MS`) to go before the table moved: the stamp
 *   on `r0` is not believed to start the seat's clock, and the time before it is judged as time
 *   without a link, from the last frame before the run that was not late. That gives `downLate`
 *   (the table played for the seat, and it was shown its turn late) or `down`, or `downEarly` when a
 *   whole clock cannot have run out since that frame.
 * Otherwise the move is judged by the clock (`judgeFrom`).
 */
export function judgeTableMove(j: MoveJudge, play: PlayRecord, n: number, end: SeenState | null, rules: RuleSet, anchors: ClockAnchor[], track: ClockTrack, gaps: Set<number>, prevMove = -1, scope: LateScope | null = null): 'ok' | 'early' | 'downEarly' | 'down' | 'downLate' | 'unanchored' | 'held' | 'lateTurn' {
  let a: SeenState | null = null;
  let b: SeenState | null = null;
  for (const f of play.seen) {
    if (f.tc <= n) a = f;
    else if (!b) b = f;
  }
  if (!b) b = end;
  if (!b) return 'ok';
  // Over one link the state the table moved from must have come, and shown this seat the move.
  if (a && a.epoch === b.epoch && (a.tc !== n || !a.owes)) return 'held';
  // `from`: where the time without a timely view of the table began (null: before the hand's first
  // frame); undefined when the run's first state was believed.
  let from: SeenState | null | undefined;
  let byLate = false;
  let armed = false;
  if (a && a.owes) {
    const { run, i0 } = seatRun(play, n, prevMove);
    const r0 = run[0];
    if (r0) {
      armed = armedLate(r0, rules);
      const lr = lateRef(r0);
      // Over a link the watch was keeping, no honest frame is that late: the host held it.
      if (r0.live && lr > LATE_MS) return 'held';
      const late = lr > LATE_MS || lateAnchor(r0, anchors, scope) > LATE_MS;
      const prev = i0 > 0 ? play.seen[i0 - 1] : null;
      const whole = rules.turnSeconds * 1000 + ((prev ? track.bank.get(prev) : null) ?? rules.timeBankSeconds * 1000);
      // Shown too late for its stamp to be believed, or first shown over a link that was not yet
      // working with less than a whole clock (less LATE_MS) left: the time before it is judged as time
      // without a link, from the last timely frame before it.
      if (late || (r0.working === false && b.at - (r0.atLo ?? r0.at) < whole - LATE_MS)) {
        byLate = late;
        from = null;
        for (let k = i0 - 1; k >= 0; k--) {
          const f = play.seen[k];
          if (lateRef(f) <= LATE_MS && lateAnchor(f, anchors, scope) <= LATE_MS) {
            from = f;
            break;
          }
        }
      }
    }
  }
  const v = judgeFrom(j, play, n, rules, anchors, track, gaps, a, b, false);
  if (v === 'early' || v === 'downEarly') return v;
  if (armed) return 'lateTurn';
  if (from === undefined) return v;
  if (from === null && !play.before) return byLate ? 'downLate' : 'down';
  const g = judgeFrom(j, play, n, rules, anchors, track, gaps, from, b, true);
  return g === 'downEarly' ? 'downEarly' : byLate ? 'downLate' : 'down';
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

