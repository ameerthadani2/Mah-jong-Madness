/**
 * The audit of a hand (`ClientAudit`, under `TableClient`): the checks run on a hand's audit when the hand ends
 * (`runAudit`) and on the record of a hand this device missed (`auditMissed`): the commitments and the shares, the seed,
 * the ceremony's attempts against what this device saw (`checkAccounting`), the replay (`clientreplay.ts`), and the
 * caveats that leave a hand amber.
 */
import { hashState, stableStringify, viewFor, WALL_RNG_VERSION, type GameState, type HandResult, type LoggedAction, type MatchSnapshot, type RuleSet, type TableView } from '@mjm/engine';
import { commitFor, deriveSeed, verifyReveals } from './fairness';
import { RESTART_CAUSES, type Audit } from './messages';
import { MAX_RUN_SCOPES } from './clientclock';
import type { LateScope, MoveJudge } from './clientmoves';
import { isAudit, isCommitSet, isInt, isObject, isRevealSet, isView, nextHand, snapshotFromView, viewDigest, withLateTurns, withPassed, type ClockAnchor, type PlayRecord, type RunScope, type SeenState } from './clientrecords';
import { AUDIT_CAVEATS, type AuditStatus, type AuditCheck, type PassedClaim } from './clientwords';
import { MAX_AUDITS, MAX_RESTART_ERAS } from './clientcore';
import { replayHand, type ReplayNotes, type ReplayInputs } from './clientreplay';
import { ClientWatch } from './clientwatch';

const PASSED_CAVEAT: Record<PassedClaim, string> = { pong: AUDIT_CAVEATS.passedPong, chow: AUDIT_CAVEATS.passedChow, kong: AUDIT_CAVEATS.passedKong };
const PASSED_LATE_CAVEAT: Record<PassedClaim, string> = { pong: AUDIT_CAVEATS.passedPongLate, chow: AUDIT_CAVEATS.passedChowLate, kong: AUDIT_CAVEATS.passedKongLate };

/** The first turn of a hand this device was shown (its earliest state on record), or +Infinity when it was shown none. */
function firstShown(play: PlayRecord | undefined): number {
  let first = Number.POSITIVE_INFINITY;
  for (const f of play?.seen ?? []) if (isInt(f.tc) && f.tc < first) first = f.tc;
  return first;
}

/** Whether `log` credits a move to seat `me` before turn `from` (an entry that names no turn counts as one). */
function movedBefore(log: unknown, me: number, from: number): boolean {
  return Array.isArray(log) && log.some((e) => isObject(e) && e.seat === me && !(isInt(e.n) && e.n >= from));
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

export abstract class ClientAudit extends ClientWatch {
  /**
   * The audit of a hand that ended while this client's link was down. It is checked as far as a
   * device that was not there can check it: the shares and the seed, a replay from where the last
   * verified hand left the match, the ceremony accounting, and whatever this client did see of the
   * hand before it left (its own reveal, the states it was shown, the moves it sent). A hand that
   * passes is `partial` (this device did not watch it) and the next hand chains onto it; one that
   * fails also fails the hand now on the table. The host cannot use this path for a hand this
   * client watched over an unbroken link.
   */
  protected auditMissed(audit: Audit): void {
    const h = audit.handNumber;
    const rules = this.pinnedRules ?? this.state.rules;
    if (!rules || !this.state.matchId) return;
    if (h === this.openHand && audit.matchId === this.state.matchId) this.openRecordOn = this.epoch;
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
      for (const c of this.setFor(h) ?? []) {
        const a = commitsOk ? audit.commits.find((x) => x.seat === c.seat) : undefined;
        if (!a || a.hash !== c.hash) failures.push(`Commitment for seat ${c.seat} changed after the fact`);
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
    if (notes.lateCopy) caveats.push(AUDIT_CAVEATS.lateCopy);
    if (notes.noAnswer) caveats.push(AUDIT_CAVEATS.noAnswer);
    const status: AuditStatus = failures.length > 0 ? 'failed' : 'partial';
    this.handsEnded.add(h);
    if (this.openHand === h) this.openHand = null;
    this.atStart = false;
    this.expected = replayed && hashState(replayed) === audit.finalHash ? nextHand(replayed) : null;
    this.chainChecked = null;
    this.noteChainEnd(h);
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
   * verifyAudit, plus the replayed final state when the replay ran (to chain the next hand onto). `beforeJoin`: the log
   * credits this seat with moves this device did not watch being made (before it joined the hand part-way, or on another
   * device the server named, `otherDevice`), so the end of the match is not shown as verified (`missedMoves`).
   */
  protected runAudit(audit: Audit, finalView: TableView, announced: HandResult | undefined, end: SeenState | null): { check: AuditCheck; replayed: GameState | null; anchors: ClockAnchor[]; passed: Array<{ turn: number; claim: PassedClaim; late?: boolean }>; late: { turns: number[]; of: number }; beforeJoin: boolean } {
    const failures: string[] = [];
    const caveats: string[] = [];
    let replayed: GameState | null = null;
    const anchors: ClockAnchor[] = [];
    const notes: ReplayNotes = { tableMoved: false };
    const rules = this.pinnedRules ?? this.state.rules;
    const none = { turns: [], of: 0 };
    if (!rules || !this.state.matchId) return { check: { status: 'unverified', failures: ['No match context'], caveats }, replayed, anchors, passed: [], late: none, beforeJoin: false };
    if (!isAudit(audit) || !isView(finalView)) return { check: { status: 'failed', failures: ['The audit is malformed'], caveats }, replayed, anchors, passed: [], late: none, beforeJoin: false };
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
    // A hand this device came to part-way: it did not watch the moves the log credits to the seat before the first state it
    // was shown there. Like the moves of a hand it missed, they keep the end of the match from being shown as verified.
    const beforeJoin = joined && me !== null && movedBefore(audit.log, me, firstShown(this.plays.find((p) => p.hand === h)));

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
    } else if (this.setFor(h)) {
      for (const c of this.setFor(h) ?? []) {
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
      // The result's view is what the result screen shows: the replayed state's view for this seat, and nothing else.
      if (me !== null && viewDigest(finalView) !== viewDigest(viewFor(replayed, me))) failures.push(`The view of the table this seat was shown at turn ${replayed.turnCounter} is not the replayed one`);
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
    if (this.brokenHand === h) caveats.push(AUDIT_CAVEATS.unchained);
    if (this.rewinds.some((x) => x.hand === h && x.undone)) caveats.push(AUDIT_CAVEATS.serverRestart);
    if (this.rewinds.some((x) => x.hand === h && x.again)) caveats.push(AUDIT_CAVEATS.restartedAgain);
    caveats.push(...tableMoveCaveats(notes));
    if (notes.restartClock) caveats.push(AUDIT_CAVEATS.restartClock);
    if (notes.appClock) caveats.push(AUDIT_CAVEATS.appClock);
    if (notes.lateShown) caveats.push(AUDIT_CAVEATS.lateShown);
    if (notes.skillUnknown) caveats.push(AUDIT_CAVEATS.skillUnknown);
    if (notes.damaged) caveats.push(AUDIT_CAVEATS.damaged);
    if (notes.overflow) caveats.push(AUDIT_CAVEATS.overflow);
    if (notes.inFlight) caveats.push(AUDIT_CAVEATS.inFlight);
    if (notes.lateCopy) caveats.push(AUDIT_CAVEATS.lateCopy);
    if (notes.noAnswer) caveats.push(AUDIT_CAVEATS.noAnswer);
    if (notes.otherDevice) caveats.push(AUDIT_CAVEATS.otherDevice);
    if (notes.journalLost) caveats.push(AUDIT_CAVEATS.journalLost);
    // An app restart around the deal: this device cannot say it watched all of it, whatever its record now shows.
    // (A seat that joined mid-hand has already said it took no part in the deal.)
    if (this.lapseHand === h && this.lapseDeal && !joined && !caveats.includes(AUDIT_CAVEATS.appRestart)) caveats.push(AUDIT_CAVEATS.appRestart);

    const status: AuditStatus = failures.length > 0 ? 'failed' : caveats.length > 0 ? 'partial' : 'ok';
    // (Moves this device did not watch being made, on another device the server named: the end of the match is not verified.)
    return { check: { status, failures, caveats }, replayed, anchors, passed: notes.passedClaims ?? [], late: { turns: notes.lateTurns ?? [], of: notes.turnsMeasured ?? 0 }, beforeJoin: beforeJoin || notes.otherDevice === true || notes.journalLost === true };
  }

  /** Replay the hand and check it (`replayHand`, clientreplay.ts), on what this client recorded and measured of it. */
  private replayChecked(start: MatchSnapshot, seed: string, rules: RuleSet, log: LoggedAction[], h: number, end: SeenState | null, failures: string[], anchors: ClockAnchor[] = [], notes?: ReplayNotes, unseen?: PlayRecord): GameState {
    const c: ReplayInputs = {
      state: this.state,
      plays: this.plays,
      pinnedSkill: this.pinnedSkill,
      tableSkill: this.tableSkill,
      frozenBots: this.frozenBots,
      ownAbsences: this.ownAbsences,
      clockBase: this.clockBase,
      runId: this.runId,
      recordFor: (x) => this.recordFor(x),
      lateScope: (pongs) => this.lateScope(pongs),
      moveJudge: (x) => this.moveJudge(x),
    };
    return replayHand(c, start, seed, rules, log, h, end, failures, anchors, notes, unseen);
  }

  /**
   * The run of the app, the strongest fixed point kept in it (see `lateAnchor`; with `pongs`, the strongest of its
   * answers to pings, as the Fair play count weighs them) and its pauses (see `lateBy`), with the same for each earlier
   * run of the app whose frames the record holds (`earlier`).
   */
  protected lateScope(pongs = false): LateScope {
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
  protected runScopes(): RunScope[] {
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

  /** What the table-move checks (`judgeTableMove`) read of this client's clock record for hand `h`, and keep. */
  protected moveJudge(h: number): MoveJudge {
    return { clockBase: this.clockBase, gapVerdicts: this.gapVerdicts, ownAbsences: this.ownAbsences, dealAfter: this.shareSent(h) };
  }

  /** When this device last sent its share for hand `h` in this run of the app, and over which link (null: it sent none). */
  private shareSent(h: number): MoveJudge['dealAfter'] {
    let out: MoveJudge['dealAfter'] = null;
    for (const x of this.recordFor(h)?.attempts ?? []) {
      if (!x.revealed || typeof x.revealedAt !== 'number' || x.revealedRun !== this.runId || !isInt(x.revealedSeg) || !isInt(x.revealedEpoch)) continue;
      if (!out || x.revealedAt > out.at) out = { at: x.revealedAt, run: this.runId, seg: x.revealedSeg, epoch: x.revealedEpoch };
    }
    return out;
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
    // A restart the server made by restarting blames nobody, so it adds an attempt beyond one per human seat; a server can
    // say it restarted at will, so at most `MAX_RESTART_ERAS` such restarts count (the hand is amber either way: the server
    // could have picked its deal).
    const serverRestarts = (restarts ?? []).filter((r) => isObject(r) && r.cause === 'host_restarted').length;
    const most = 1 + humans + Math.min(serverRestarts, MAX_RESTART_ERAS);
    if (attempts > most) failures.push(`${attempts} ceremony attempts is more than ${most}, the most an honest table with ${humans} human seats needs`);
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
