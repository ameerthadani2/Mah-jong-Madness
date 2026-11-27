/**
 * The hands the table client follows (`ClientLedger`, under `TableClient`): which hand it is on, how a hand is entered,
 * chained to the hand before and closed, and what this device was shown of it; who held the seat (another device, a
 * stand-in, the stretches the ledger vouches for); a failure put on show at once; the guards on bot seats and on
 * malformed frames; and the moves it files before they go out.
 */
import { matchSnapshot, newGame, stableStringify, type MatchSnapshot, type TableView } from '@mjm/engine';
import type { Commitment } from './fairness';
import type { Audit, ClientMessage, SeatInfo } from './messages';
import { CHAINED_FIELDS, isInt, isObject, openOtherDevice, sharedOn, type AttemptRecord, type LedgerSpan, type PlayRecord, type SentAction } from './clientrecords';
import { AUDIT_CAVEATS, type AuditStatus } from './clientwords';
import { MAX_AUDITS, MAX_HAND_RECORDS, ClientCore } from './clientcore';

export abstract class ClientLedger extends ClientCore {
  /**
   * Send a move this client filed, noting where it went in the order of the frames this run sent (`markReached`), and, for
   * a move filed with the app's journal, when it went out (`SentAction.out`: it waited for the journal's write).
   */
  protected sendMove(msg: ClientMessage, filed: SentAction): void {
    if (filed.seq !== undefined) filed.out = this.now();
    this.movesOut.set(filed, this.send(msg));
  }

  /**
   * The table answered, over link `epoch`, a ping this run sent as the `out`-th frame: every move this run sent over the
   * same link before it was taken up by the table by then (an honest table takes a link's frames in order). Each such move
   * of the hand on show, while it is played, is marked with the turn its state has reached (`SentAction.byTurn`).
   */
  protected markReached(epoch: number, out: number): void {
    const v = this.state.view;
    if (!v || !isInt(v.turnCounter) || this.state.lastResult !== null || this.handsEnded.has(v.handNumber) || epoch !== this.epoch) return;
    const play = this.plays.find((p) => p.hand === v.handNumber);
    if (!play) return;
    for (const x of play.sent) {
      if (x.byTurn !== undefined || x.run !== this.runId || x.epoch !== epoch) continue;
      const at = this.movesOut.get(x);
      if (at !== undefined && at < out) x.byTurn = v.turnCounter;
    }
  }

  /**
   * Whether a frame about the deal of hand `h` (its commitments, a share the host made for this seat) is one an honest
   * host could send now: it names the hand this client is on (`activeHand`), being dealt or played, or a later one on
   * a link that has brought nothing about that hand yet (the table may have played on while this device had no link,
   * and a returning seat is told about the deal in progress); never another hand that has ended. The hand this client
   * was last asked to commit to or shown (`openHand`) counts whatever came of it: a deal of a hand already played is
   * failed when the table turns to it (`enterHand`), and its frames are then taken as that deal's.
   */
  protected dealsHand(h: number): boolean {
    if (h === this.openHand) return true;
    const on = this.activeHand();
    return !this.handsEnded.has(h) && (h === on || (h > on && this.handEpoch !== this.epoch));
  }

  /**
   * The seat was opened on another device: what was played there is not this client's to vouch for,
   * and it stops (the player resumes the table from Home to take the seat back).
   */
  protected seatTaken(): void {
    this.noteOwnAbsence();
    this.noteLinkLost();
    // Every hand still under way, whichever record was made last. From the latest turn this device was shown of it until
    // it is shown the hand again once welcomed back, the server says another device held the seat (`otherDevice`).
    for (const play of this.plays) {
      if (this.handsEnded.has(play.hand)) continue;
      this.closeLedger(play);
      play.ledgerFrom = Number.POSITIVE_INFINITY;
      play.otherDevice = openOtherDevice(play.otherDevice, this.lastShown(play.hand));
    }
    // (And a hand this device has no record of yet, up to the first state it is shown of it once welcomed back.)
    this.elsewhereOpen = true;
    this.kickedLink = this.link;
    this.update({ connected: false, kicked: true, lastError: 'This seat was opened on another device.' });
  }

  /**
   * The ledger stops vouching for `play` from here on (the seat was opened on another device), but not
   * for the turns before the last state this client was shown while it held the seat: every move before
   * that state was made while this device held the seat (an honest host stops sending to a link once
   * another device takes its seat), so a notice that comes after it cannot excuse one this device never
   * sent. The ledger began vouching in this run of the app, so only states this run saw count. Every stretch of the
   * hand is kept (two that touch or overlap become one): each takes a seat-taken notice and a resume from Home, and
   * dropping the oldest would excuse a move forged in it.
   */
  private closeLedger(play: PlayRecord): void {
    const spans = this.vouchedThrough(play);
    if (spans !== play.vouched) play.vouched = spans;
  }

  /**
   * `play.vouched` with the stretch the ledger vouches for now added: from `ledgerFrom` up to (not including) the latest
   * turn this run of the app was shown in the hand (two stretches that touch or overlap become one). The same object when
   * there is nothing to add (the ledger does not vouch, the hand has ended, or no later state came in this run).
   */
  protected vouchedThrough(play: PlayRecord): LedgerSpan[] | undefined {
    const from = play.ledgerFrom;
    if (from === null || !Number.isFinite(from) || this.handsEnded.has(play.hand)) return play.vouched;
    let to = from;
    for (const f of play.seen) if (f.run === this.runId && f.tc > to) to = f.tc;
    if (to <= from) return play.vouched;
    const spans = [...(play.vouched ?? []), { from, to }].sort((a, b) => a.from - b.from);
    const merged: LedgerSpan[] = [];
    for (const v of spans) {
      const last = merged[merged.length - 1];
      if (last && v.from <= last.to) last.to = Math.max(last.to, v.to);
      else merged.push({ from: v.from, to: v.to });
    }
    return merged;
  }

  /**
   * The host says, on this client's rejoin, that another device held the seat since its last link
   * (`welcome.elsewhere`): the 'disconnected' that ended that link never arrived. The time between
   * that link and this one was spent elsewhere, and from here on it is as if the notice had come.
   * A server that says so falsely gains no more than one that sends 'disconnected': the client stops.
   */
  protected takenElsewhere(): void {
    this.noteOwnAbsence(this.epoch - 1);
    this.seatTaken();
  }

  /**
   * The first welcome of this run of the app (a client restored from its record, or one new to the table) says another
   * device held the seat (`welcome.elsewhere`): the player took the seat back from there by opening the table here, so
   * this client goes on, but from the latest turn this device was shown of each hand under way, and in a hand it has no
   * record of, up to the first state it is shown, the moves credited to the player may be that device's: the ledger does
   * not vouch for them (`otherDevice`). Without this, a client that kept its ledger across the restart through the app's
   * journal would take such a move for one forged in the player's name.
   */
  protected heldElsewhere(): void {
    for (const play of this.plays) {
      if (this.handsEnded.has(play.hand)) continue;
      this.closeLedger(play);
      play.ledgerFrom = Number.POSITIVE_INFINITY;
      play.otherDevice = openOtherDevice(play.otherDevice, this.lastShown(play.hand));
    }
    this.elsewhereOpen = true;
    this.update({ heldElsewhere: true });
  }

  /** Keep `commits` as hand `h`'s set, for the last few hands, never giving up the hand this client is on (`trimHands`). */
  protected holdSet(h: number, commits: Commitment[]): void {
    this.dropSet(h);
    this.commitSets.push({ hand: h, commits: commits.map((c) => ({ seat: c.seat, hash: c.hash })) });
    this.trimHands(this.commitSets, MAX_HAND_RECORDS, (x) => x.hand);
  }

  protected dropSet(h: number): void {
    this.commitSets = this.commitSets.filter((x) => x.hand !== h);
  }

  /**
   * A frame names hand `h`. After a frame about a later hand's deal reached this client while it was on another hand
   * (`aheadOf`), a frame about that hand is the server's own making: an honest host deals the next hand only once the
   * one before has ended, and then sends nothing more about it.
   */
  protected aboutHand(h: number): void {
    if (this.aheadOf === null || h !== this.aheadOf) return;
    this.aheadOf = null;
    this.flag(h, 'Host sent a frame about a hand or turn this device was not on');
  }

  /** A frame about the deal of hand `h` was taken while this client is on another hand that has not ended (see `aheadOf`). */
  protected noteAhead(h: number): void {
    const on = this.activeHand();
    if (h !== on && !this.handsEnded.has(on)) this.aheadOf = on;
  }

  /** The attempt the host is currently running for `hand`, as this client recorded it. */
  protected currentAttempt(hand: number): AttemptRecord | null {
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
  protected chainBase(h: number): MatchSnapshot | null {
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
  protected enterHand(h: number): void {
    if (this.lapse) {
      this.lapse = false;
      // A second restart during the same hand does not make its deal any better watched.
      const before = this.lapseHand === h && this.lapseDeal;
      this.lapseHand = h;
      this.lapseDeal = before || !this.recordFor(h)?.dealt;
    }
    // The first hand a client with neither a token nor a record hears of (`fresh`), whatever came before it (a notice that
    // the table made this seat's share, say): later hands, and a new match at the table, it was there for.
    const takenBack = this.fresh;
    this.fresh = false;
    // A hand this client was on, after a frame about a later hand's deal: the server's own making. Any other moves it on.
    if (this.aheadOf !== null && h === this.aheadOf) this.aboutHand(h);
    else this.aheadOf = null;
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
      if (this.handEpoch === this.epoch) {
        this.carryFlags(this.openHand, h);
        const problem = 'Host started another hand before the one in progress had ended';
        this.flag(h, problem);
        this.failNow(problem);
      } else {
        // The table played on while this device's link was down: the hand it was on gets a verdict of its own, and what
        // was flagged against it, the hand then on the table, still counts against the hand the table moved on to.
        const was = this.openHand;
        this.closeUnheard(was);
        this.carryFlags(was, h);
        this.noteGap(h);
      }
    } else if (base?.matchOver) this.flag(h, 'Host dealt another hand after the match was over');
    else if (takenBack && h > 0) {
      // Sat down with neither a token nor a record, and the first hand it hears of is not the match's first: the table
      // gave the account its own seat back part-way through the match (or dealt a client in the lobby out of turn, which
      // this client cannot tell from it). Nothing it holds says where this hand should start.
      this.noteGap(h);
    } else if (base ? h !== base.handNumber : this.handsEnded.size > 0 && this.gapHand === null && h !== Math.max(...this.handsEnded) + 1) {
      this.carryFlags(base ? base.handNumber : Math.max(...this.handsEnded) + 1, h);
      if (this.quietSince === this.epoch) this.flag(h, 'Host dealt a hand out of turn');
      else this.noteGap(h);
    } else if (!base && this.noHistory && this.handsEnded.size === 0 && h > 0) {
      // Sat down from a token alone, part-way through the match: nothing this client holds says where this hand should start.
      this.noteGap(h);
    }
    this.noteOpenHand(h);
  }

  /**
   * The table moved on past hand `h`, the one this client was on, while its link was down, and sent no record of `h` this
   * client could check. The hand gets a verdict of its own, listed with the audits, its own flags with it, never silence:
   * amber (`noRecord`), or red when the join on this link said which hands this client held (`have`, before `h`), the
   * table welcomed it there, and no record of `h` came on it. An honest host then sends the record of every later hand
   * that ended (`TableHost.sendMissed`: it keeps every audit of the match, a restored table too, whose snapshot holds them)
   * before anything else about the table; a join that says nothing is sent no records, and a record that came but that
   * nothing this client holds chains into is no record it could check.
   */
  private closeUnheard(h: number): void {
    const j = this.joinHave;
    const asked = j !== null && j.epoch === this.epoch && j.have !== undefined && j.have < h && this.welcomedOn === this.epoch && this.openRecordOn !== this.epoch;
    const failures = [...(this.tamper.get(h) ?? [])];
    if (asked) failures.push('Host moved on to a later hand without sending the record of this one, which this device asked for when it joined again');
    const caveats: string[] = [AUDIT_CAVEATS.noRecord];
    // (Not among the hands whose end this client holds: what it tells the table it holds, `have`, stays the same.)
    if (this.openHand === h) this.openHand = null;
    const status: AuditStatus = failures.length > 0 ? 'failed' : 'partial';
    // Listed by what this client holds of it: its match, its number and the commitments it was shown.
    const audit: Audit = { matchId: this.state.matchId ?? '', handNumber: h, seed: '', commits: (this.setFor(h) ?? []).map((c) => ({ seat: c.seat, hash: c.hash })), reveals: [], log: [], finalHash: '', rngVersion: '', ceremonyAttempts: 0, restarts: [], restartReasons: [] };
    this.update({ audits: [...this.state.audits, { audit, status, failures, caveats }].slice(-MAX_AUDITS), ...(status === 'failed' ? { matchFailed: true, matchEndVerified: false } : {}) });
  }

  /**
   * Hand `h` was audited (`expected` set from its replay, or null when its record did not replay): with nothing to chain
   * from, the hand after it starts from scores this client cannot check, and its audit says so (`brokenHand`). The final
   * scores then rest on it too (`chainGap`).
   */
  protected noteChainEnd(h: number): void {
    if (this.brokenHand === h) this.brokenHand = null;
    if (this.expected !== null) return;
    this.brokenHand = h + 1;
    this.chainGap = true;
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
  protected checkChain(start: MatchSnapshot): void {
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
  protected resetMatch(): void {
    this.secret = null;
    this.commitSets = [];
    this.commitHand = null;
    this.aheadOf = null;
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
    this.brokenHand = null;
    this.chainGap = false;
    this.missedMoves = false;
    this.rewinds = [];
    this.eraHand = null;
    this.erasInHand = 0;
    this.lateWelcome = [];
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
  protected hasEvidence(): boolean {
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
  protected matchEndVerdict(scores: unknown[], view: TableView): 'verified' | 'unverified' | 'refuse' {
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
  protected failNow(problem: string): void {
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
  protected checkBots(seats: SeatInfo[]): void {
    if (this.frozenBots === null || this.state.matchOver) return;
    const bots = seats.filter((s) => isObject(s) && s.isBot === true && isInt(s.seat)).map((s) => s.seat).sort((a, b) => a - b);
    if (bots.join(',') !== this.frozenBots.join(',')) this.flag(this.activeHand(), 'Host changed which seats are bots during the match');
  }

  /**
   * A frame of a known type that does not carry what an honest host always sends in it, or carries it as another type
   * (`intake`): the client shows nothing of it, acts on nothing in it and files nothing from it, and the hand it is on
   * fails. A set of commitments that is not one keeps its own failure.
   */
  protected malformed(t: string, field: string): void {
    if (t === 'commits' && field === 'commits') {
      this.flag(this.activeHand(), 'Host published a malformed set of commitments');
      this.update({ lastError: 'The table sent a malformed set of commitments.', lastErrorCode: null });
      return;
    }
    this.flag(this.activeHand(), 'Host sent a malformed frame');
    this.update({ lastError: `The table sent a malformed ${t} frame (${field}).`, lastErrorCode: null });
  }

  /**
   * The link in use was up before hand `h` was dealt (`shown`: the last state it brought): it brought a state of an
   * earlier hand, or this device was asked to commit to `h`, or revealed its share for it, over it. An honest host sends
   * every seat it has a link to the deal's state, then the state of every turn after it, so the first frame of the hand
   * such a link brings is its deal.
   */
  protected upBeforeDeal(h: number, shown: { hand: number } | null): boolean {
    if (shown && shown.hand < h) return true;
    if (this.ceremonyEpoch === this.epoch && this.commitHand === h) return true;
    return !!this.recordFor(h)?.attempts.some((x) => sharedOn(x, this.epoch));
  }

  /** This device had been shown a state of hand `h`, in any run of the app. */
  protected shownBefore(h: number): boolean {
    return (this.plays.find((p) => p.hand === h)?.seen.length ?? 0) > 0;
  }

  /** The latest turn of hand `h` this device was shown, in any run of the app (0: none). */
  protected lastShown(h: number): number {
    let t = 0;
    for (const f of this.plays.find((p) => p.hand === h)?.seen ?? []) if (isInt(f.tc) && f.tc > t) t = f.tc;
    return t;
  }
}
