/**
 * What the table client does with each frame the host sends (`ClientFrames.onMessage`, under `TableClient`): the frame
 * is checked first (`intake`), then filed under the hand it names and acted on: the welcome, the deal's ceremony, a state
 * and its clock, a hand's end and its audit, a hand missed, the end of the match, a restart notice and a refusal.
 */
import { hashState, legalActions, sanitizeRules, stableStringify, viewToState, type TableView } from '@mjm/engine';
import { commitFor, makeSecret } from './fairness';
import { CLOCK_FRAME_MS, type HostMessage } from './messages';
import { intake, MOVE_REFUSALS } from './intake';
import { DRIFT_RATE, foldClock, LATE_MS } from './clientclock';
import { fixedPoint, isBotSkill, type LateScope } from './clientmoves';
import { isInt, isObject, keepSeen, MAX_SENT, closedOtherDevice, MAX_REVEAL_LINKS, sharedOn, nextDeal, nextHand, sameCommitSet, snapshotFromView, viewDigest, withLateTurns, withPassed, type ClockAnchor, type SeenState } from './clientrecords';
import { MAX_AUDITS, MAX_HAND_RECORDS, MAX_RESTART_ERAS } from './clientcore';
import { ClientAudit } from './clientaudit';

/** Restart notices kept (see `noteRestore`): at most two begin a clock era per hand on show. */
const MAX_REWINDS = 4;
/** First states of links waiting for an answer to a ping to place their stamps (`TableClient.lateWelcome`). */
const MAX_LATE_WELCOMES = 8;
/** Frames that may come in a link's opening, between its `welcome` and a restart notice (`TableClient.opening`). */
const OPENING_FRAMES: ReadonlySet<string> = new Set(['hand_missed', 'lobby', 'pong', 'chat', 'emote', 'restored']);
/** Frames about a hand: its deal under way, a state, a clock, a result, a hand missed (`handFrameOn`). */
const HAND_FRAMES: ReadonlySet<string> = new Set(['commit_request', 'commits', 'reveal_request', 'stand_in', 'state', 'clock', 'hand_over', 'hand_missed', 'match_over']);

/** The hand a frame names, if it names one. */
function frameHand(m: HostMessage): number | null {
  switch (m.t) {
    case 'state':
      return m.view.handNumber;
    case 'hand_over':
    case 'hand_missed':
      return m.audit.handNumber;
    case 'commit_request':
    case 'commits':
    case 'reveal_request':
    case 'stand_in':
    case 'restored':
      return m.handNumber;
    case 'clock':
      return m.hand;
    default:
      return null;
  }
}

export abstract class ClientFrames extends ClientAudit {
  /** Take up a record the app kept of the match a welcome names (`TableClient`, client.ts). */
  protected abstract lookUpKept(m: Extract<HostMessage, { t: 'welcome' }>): void;
  /** Take back the red hands the app kept apart (`TableClient.keepRed`, client.ts). */
  abstract keepRed(list: unknown): void;
  /** Take up the kept record waiting for the table's first word, or give it up (`TableClient`, client.ts). */
  protected abstract takeUp(matchId: string | null): void;

  protected onMessage(raw: HostMessage): void {
    // Every frame meets the protocol's contract for its type before anything of it is used (`intake`).
    const taken = intake(raw);
    // A kept record (`fromArchive`) is taken up, or given up, at the table's first word about the table: any frame but a
    // pong or an error that refuses no move (the only frames an honest host sends a link before its welcome).
    if (this.pending && !(taken?.ok && (taken.frame.t === 'pong' || (taken.frame.t === 'error' && !MOVE_REFUSALS.has(taken.frame.code))))) this.takeUp(taken?.ok && taken.frame.t === 'welcome' ? taken.frame.matchId : null);
    // A welcome naming a match this client holds no record of: the app may keep one (`lookUpKept`).
    if (this.keptRecord && taken?.ok && taken.frame.t === 'welcome' && this.state.matchId === null) this.lookUpKept(taken.frame);
    if (taken === null) {
      // A type no seat is sent: nothing of it is read (it still ends a link's opening).
      if (isObject(raw) && typeof raw.t === 'string' && !OPENING_FRAMES.has(raw.t)) this.opening = false;
      return;
    }
    if (!taken.ok) {
      this.opening = false;
      this.malformed(taken.t, taken.field);
      return;
    }
    const m = taken.frame;
    // A link's opening ends at its first frame about the table's play (`opening`).
    if (!OPENING_FRAMES.has(m.t)) this.opening = false;
    // On a link where this client holds no seat (not yet welcomed there, or evicted there) an honest host sends only pongs
    // and errors that refuse no move (`welcomedOn`): anything else is the server's own making. It fails the hand it names
    // and the hand this client is on, and is taken as any frame is (the hands' audits carry the failure).
    if (m.t !== 'welcome' && m.t !== 'pong' && !(m.t === 'error' && !MOVE_REFUSALS.has(m.code)) && (this.welcomedOn !== this.epoch || this.evictedOn === this.epoch)) {
      const h = frameHand(m);
      if (h !== null && !this.handsEnded.has(h)) this.flag(h, 'Host sent table frames on a connection where this device held no seat');
      this.flag(this.activeHand(), 'Host sent table frames on a connection where this device held no seat');
    }
    // A frame about a hand (its deal under way, a state, a result): the table had a hand to show this link (`runFromHand`).
    if (HAND_FRAMES.has(m.t)) this.handFrameOn = this.epoch;
    switch (m.t) {
      case 'welcome': {
        // A record taken up at this welcome (`lookUpKept`) holds the count of the last welcome its own client took, and this
        // client joined under another device id: one more than that count is this join alone, so no other device held the
        // seat since, whatever `elsewhere` says of the join.
        const ownJoin = this.tookUpAtWelcome && isInt(m.handovers) && this.handovers !== null && m.handovers === this.handovers + 1;
        this.tookUpAtWelcome = false;
        // Whatever else it says, a welcome seats this client on this link.
        this.seatedOn = this.epoch;
        this.welcomedOn = this.epoch;
        this.evictedOn = -1;
        // (The first welcome of the link: when it came, for the state the table owes right behind it.)
        if (this.welcomeEpoch !== this.epoch) {
          this.welcomeEpoch = this.epoch;
          this.welcomeAt = this.now();
          this.welcomeSeg = this.seg();
        }
        const seats = m.seats;
        // The rejoin token (an honest table gives one in every welcome, `intake`). The table's room code is pinned from
        // the first welcome: the app keeps the record under the room it joined, which a welcome does not move.
        const token = m.token;
        const roomCode = this.state.roomCode ?? m.roomCode;
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
        // A new match at this table (after the last one verifiably ended) starts a fresh record, from a new match's start:
        // its first hand must be the match's first, from the rules' starting position, whatever number the host gives it
        // (`atStart`). An honest server runs one match per table, with one match id for the table's life (apps/signal
        // attaches one `TableHost` to a room), and the app keeps one client per table; so a new match id on the same table
        // is one this client sits at from its lobby.
        if (this.state.matchId !== null && m.matchId !== this.state.matchId) {
          this.resetMatch();
          this.atStart = true;
        }
        const rules = sanitizeRules(m.rules);
        if (this.pinnedRules && stableStringify(rules) !== stableStringify(this.pinnedRules)) this.flag(this.activeHand(), 'Host changed the rules mid-match');
        if (this.state.matchId === null) {
          this.quietSince = this.epoch;
          // With no token this client sat down in the lobby, unless the table gave its account its own seat back part-way
          // through the match (`fresh`): the first hand it hears of says which (`enterHand`).
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
        // is not to be excused after the fact, as the time before it would be.) The table also counts the seat's moves
        // from one device to another (`handovers`): two more than the last welcome this client took said is another
        // device holding the seat and this one taking it back, even when the welcome that said so was lost (its link
        // broke, or the app stopped before it came).
        const away = (m.elsewhere === true && !ownJoin) || (isInt(m.handovers) && this.handovers !== null && m.handovers >= this.handovers + 2);
        if (away && this.welcomed && !this.heardOnLink) this.takenElsewhere();
        else if (away && !this.welcomed && !this.heardOnLink) this.heldElsewhere();
        if (isInt(m.handovers) && m.handovers >= 0) this.handovers = m.handovers;
        this.welcomed = true;
        // A welcome that is its link's first frame opens it: a restarted table's notice may follow (`opening`).
        this.opening = !this.heardOnLink;
        // Red hands the app kept of the match, for a client that held no record of it: kept now that the match is known.
        if (this.redLater !== null) {
          const red = this.redLater;
          this.redLater = null;
          this.keepRed(red);
        }
        return;
      }
      case 'lobby':
        this.checkBots(m.seats);
        this.update({ seats: m.seats });
        return;
      case 'commit_request': {
        const h = m.handNumber;
        // The first deal a client with neither a token nor a record hears of may be well under way (`fresh`).
        const recordless = this.noHistory || this.fresh;
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
          if (n !== 1 && !recordless && this.quietSince === this.epoch) this.flag(h, `Host never asked this seat to commit to attempts 1–${n - 1} of this hand`);
        } else if (again) {
          // The same attempt, asked again after a lost link: a fresh secret takes the place of the one that never arrived.
        } else if (last && n <= last.n) this.flag(h, `Host ran attempt ${n} of this hand's deal twice`);
        else if (last && n !== last.n + 1 && this.ceremonyEpoch === this.epoch) this.flag(h, `Host never asked this seat to commit to attempt ${last.n + 1} of this hand`);
        if (again && last) last.committed = true;
        else rec.attempts.push({ n, committed: true, revealed: false, stoodIn: false });
        this.ceremonyEpoch = this.epoch;
        this.secret = makeSecret();
        // A new attempt publishes a new set: the one held for this hand belonged to the last attempt.
        this.dropSet(h);
        this.commitHand = h;
        // This device holds the seat from before the deal: from the deal on, every move the log credits to its player in
        // this hand must be one it sent, whether or not it is shown the hand (an honest host takes a move as the player's
        // own only from the connection it seats this device on, and a seat opened on another device says so, `seatTaken`).
        const play = this.playFor(h);
        if (play.ledgerFrom === null) play.ledgerFrom = 0;
        // (Then no other device holds it: a stretch the server said another device held the seat in ends before this deal.)
        this.elsewhereOpen = false;
        if (this.standInHand === h) this.standInHand = null;
        // Record the commitment before sending it: the host may answer at once.
        this.update({ ceremony: 'committed', standIn: false });
        this.send({ t: 'commit', hash: commitFor(this.secret) });
        return;
      }
      case 'stand_in': {
        const h = m.handNumber;
        this.aboutHand(h);
        // Only the hand being dealt: a stand-in for any other is the server's own making, and makes no record. (A
        // returning seat is told again between hands about the hand that has just ended: nothing to note.)
        if (!this.dealsHand(h)) {
          if (!this.handsEnded.has(h)) this.flag(this.activeHand(), 'Host sent a frame about a hand or turn this device was not on');
          return;
        }
        const rec = this.recordFor(h);
        const cur = this.currentAttempt(h);
        const n = isInt(m.attempt) && m.attempt >= 1 ? m.attempt : (cur?.n ?? 1);
        let told = false;
        // Our secret is kept either way: the audit must still show it was not used.
        if (h === this.commitHand && this.state.ceremony === 'committed' && cur && n === cur.n && !cur.revealed) {
          // While this attempt's commitments are still being collected.
          cur.stoodIn = true;
        } else if (this.standInHand === h && rec?.attempts.some((a) => a.n === n && a.stoodIn)) {
          // Told again on a rejoin: nothing new about the deal, but a client restored since may hold the hand's ledger now.
          told = true;
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
            // Commitments we hold for this hand belong to an earlier attempt, not to the one this stand-in is for.
            this.dropSet(h);
          }
          r.attempts.sort((a, b) => a.n - b.n);
          this.noteAhead(h);
        } else return;
        if (!told) this.standInHand = h;
        // The table made this seat's share for the hand being dealt because this device had no link at its commit request,
        // and seats it here again: from the deal on, as after a commit request, every move the log credits to its player
        // must be one this device sent (an honest host takes a move as the player's own only from the link it seats this
        // device on, and a seat opened on another device says so). Only where this client knows every move it sent in the
        // hand: it kept the app's journal (`journalWhole`), the hand began in this run while it held the seat
        // (`runFromHand`), or this is the device's first run at the table (`firstRun`: the first hand of a match it sat down
        // for, say); and not while the server says another device held the seat (`elsewhereOpen`).
        const play = this.playFor(h);
        if (play.ledgerFrom === null && !this.elsewhereOpen && (this.journalWhole || this.firstRun || (this.runFromHand !== null && h >= this.runFromHand))) play.ledgerFrom = 0;
        if (!told) this.update({ standIn: true });
        return;
      }
      case 'disconnected':
        // The seat was opened on another device. Moves there are not ours to vouch for.
        this.seatTaken();
        return;
      case 'commits': {
        const h = m.handNumber;
        this.aboutHand(h);
        // (A malformed set never gets here, whatever hand it names: it counts against the hand this client is on, `malformed`.)
        // Published for the hand being dealt only (a returning seat is sent it again): a set for any other hand is the
        // server's own making, and takes the place of nothing this client holds.
        if (!this.dealsHand(h)) {
          this.flag(this.activeHand(), 'Host sent a frame about a hand or turn this device was not on');
          return;
        }
        const held = this.setFor(h);
        if (held) {
          // Published once per attempt; only a new commit_request opens the next set. An honest host
          // re-sends the same set (to a returning seat); a different one would let it re-pick its
          // own share after seeing ours.
          if (!sameCommitSet(held, m.commits)) this.flag(h, 'Host changed the commitments after publishing them');
          return;
        }
        if (this.secret && this.commitHand === h && this.standInHand !== h) {
          const mine = m.commits.find((c) => c.seat === this.state.seat);
          if (!mine || mine.hash !== commitFor(this.secret)) {
            this.flag(h, 'Host published a different commitment for my seat');
            return;
          }
        }
        this.holdSet(h, m.commits);
        this.noteAhead(h);
        return;
      }
      case 'reveal_request': {
        const h = m.handNumber;
        this.aboutHand(h);
        // Stood in, or holding no secret for this hand (we arrived mid-ceremony): nothing to reveal.
        if (this.standInHand === h || !this.secret || this.commitHand !== h) return;
        const attempt = this.currentAttempt(h);
        // This attempt's share went out and the hand has been dealt: an honest host asks for nothing more,
        // and answering would move the time the share was sent, which the deal's fixed point is measured from.
        if (attempt?.revealed && this.recordFor(h)?.dealt) return;
        if (!this.setFor(h)) {
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
          // Every link the share went out on was up before the deal (`upBeforeDeal`), not only the first one's.
          if (attempt.revealedEpoch !== this.epoch && !(attempt.revealedOn ?? []).includes(this.epoch)) attempt.revealedOn = [...(attempt.revealedOn ?? []), this.epoch].slice(-MAX_REVEAL_LINKS);
        }
        this.send({ t: 'reveal', secret: this.secret });
        this.update({ ceremony: 'revealed' });
        return;
      }
      case 'state': {
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
        const behind = this.noteOrder(m.now, h, v.turnCounter);
        // An honest host sends every turn's state to every seat it has a link to, so a link that
        // stayed up brings every turn: one skipped on it was held back. The first state of a hand
        // is its deal, on a link that was up before the deal (`upBeforeDeal`).
        const shownHere = this.linkShown && this.linkShown.epoch === this.epoch ? this.linkShown : null;
        const revealedHere = !!this.recordFor(h)?.attempts.some((x) => sharedOn(x, this.epoch));
        if (shownHere && shownHere.hand === h && v.turnCounter > shownHere.tc + 1) this.noteHeld(h, shownHere.tc + 1);
        else if (v.turnCounter > 0 && (!shownHere || shownHere.hand !== h) && this.upBeforeDeal(h, shownHere)) this.noteHeld(h, 0);
        // The link's first state, a later turn than a deal's, after the table answered a ping behind its welcome: an honest
        // host sends the hand's state right behind the welcome, before that answer, so this one was held back since this
        // device was seated here. What the table played for the seat from the latest turn this device had been shown fails.
        else if (!shownHere && v.turnCounter > 0 && this.pongAfterWelcome === this.epoch) this.noteHeld(h, this.lastShown(h));
        // The same at any turn, the deal's included, of a hand this device had been shown on an earlier link, when the
        // answer came before any frame about a hand: the table said it had no hand under way when it seated this client,
        // yet this one was (`pongBeforeHand`).
        else if (!shownHere && this.pongBeforeHand === this.epoch && this.shownBefore(h)) this.noteHeld(h, this.lastShown(h));
        // The link's first state, of a later turn of a hand this device had been shown, with no answer to a ping before it
        // (the ping behind the join included), that the host itself stamped more than `LATE_MS` after the welcome came: an
        // honest host stamps it as it sends it, right behind the welcome, so a network that holds it up (a stall that
        // begins right after the welcome) leaves the stamp as it was; a server that also holds the answers back held it.
        // The stamp is placed on this device's clock by the answers to the pings it sends from the join on, on this link or
        // a later one (`checkLateWelcome`). (A state with no stamp, which no honest host sends, by when it came.)
        else if (!shownHere && this.welcomeEpoch === this.epoch && this.welcomeAt !== null && this.pongOn !== this.epoch && this.shownBefore(h) && v.turnCounter > this.lastShown(h)) {
          if (!stamped) {
            if ((this.frameAtLo ?? this.now()) - this.welcomeAt > LATE_MS) this.noteHeld(h, this.lastShown(h));
          } else if (this.seg() === this.welcomeSeg && this.joinOut?.epoch === this.epoch) {
            this.lateWelcome.push({ hand: h, from: this.lastShown(h), stamp: m.now as number, era: this.era, seg: this.welcomeSeg, welcomeAt: this.welcomeAt, after: this.joinOut.at });
            if (this.lateWelcome.length > MAX_LATE_WELCOMES) this.lateWelcome.splice(0, this.lateWelcome.length - MAX_LATE_WELCOMES);
          }
        }
        // An honest host stamps every state. One with no stamp, on a link that has brought a state, a
        // stamp or this device's share, would escape every check of when it was shown: it is not
        // believed, and counts as held back (on a new link it is judged as shown late; see `unstamped`).
        if (!stamped && (shownHere || revealedHere || this.linkStamped)) this.noteHeld(h, v.turnCounter);
        this.noteState(v, m, stamped, shownHere !== null || revealedHere, behind);
        this.linkShown = { epoch: this.epoch, hand: h, tc: v.turnCounter };
        this.viewEpoch = this.epoch;
        // What goes on show is what `noteState` filed: the same view, hash and clock figures, as `intake` took them.
        this.update({ view: v, stateHash: m.hash, deadline: m.deadline, timeBank: m.timeBank, inTimeBank: m.inTimeBank, lastResult: null, lastError: null, ceremony: 'idle', intermissionDeadline: null });
        return;
      }
      case 'hand_over': {
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
        {
          // The hand's end is its first frame on this link. On a link that was up before the deal, every state of the hand
          // was owed there first (only a hand that ended at the deal has none): whatever the table played was held back
          // (`noteHeld`). On a later link the hand began, or went on, without this device: what the table played for the
          // seat is judged from the last frame it held before (`before`), as for a hand whose first state comes there.
          const shownHere = this.linkShown && this.linkShown.epoch === this.epoch ? this.linkShown : null;
          if ((!shownHere || shownHere.hand !== h) && this.upBeforeDeal(h, shownHere)) this.noteHeld(h, 0);
          // The same after the table answered a ping behind its welcome on a link that brought no state: the hand's state
          // was owed first (a hand dealt since then sends its deal's state first, unless it ended at the deal: no moves).
          else if (!shownHere && this.pongAfterWelcome === this.epoch) this.noteHeld(h, this.lastShown(h));
          const play = this.playFor(h);
          if (play.before === undefined && play.seen.length === 0) play.before = this.lastStamp && this.lastStamp.epoch !== this.epoch ? { ...this.lastStamp } : null;
        }
        // A hand that ended at the deal sends no state first: check where it started from its end.
        if (!this.handStart || this.handStart.handNumber !== h) this.checkChain(snapshotFromView(m.view, true));
        this.handsEnded.add(h);
        this.runFromHand = Math.max(this.runFromHand ?? 0, h + 1);
        if (this.openHand === h) this.openHand = null;
        this.atStart = false;
        const end: SeenState = { tc: Number.POSITIVE_INFINITY, epoch: this.epoch, era: this.era, at: this.now(), now: typeof m.now === 'number' && Number.isFinite(m.now) ? m.now : undefined, run: this.runId, seg: this.seg(), owes: false, deadline: null, timeBank: 0, inBank: false, hash: '', ...(stampedEnd ? { atLo: stampedEnd.atLo, ref: stampedEnd.ref, wref: stampedEnd.wref, live: stampedEnd.live, seg: stampedEnd.seg } : {}) };
        const { check, replayed, anchors, passed, late, beforeJoin } = this.runAudit(m.audit, m.view, m.result, end);
        if (beforeJoin) this.missedMoves = true;
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
        this.noteChainEnd(h);
        this.quietSince = this.epoch;
        this.tamper.delete(h);
        if (this.gapHand === h) this.gapHand = null;
        const audits = [...this.state.audits, { audit: m.audit, status, failures, caveats }].slice(-MAX_AUDITS);
        this.update({ view: m.view, lastResult: m.result, lastAudit: m.audit, auditStatus: status, auditFailures: failures, auditCaveats: caveats, deadline: null, intermissionDeadline: nextDeal(m), audits, claimsPassedAway: withPassed(this.state.claimsPassedAway, h, passed), turnsShownLate: withLateTurns(this.state.turnsShownLate, h, late), ...(status === 'failed' ? { matchFailed: true } : {}) });
        return;
      }
      case 'hand_missed':
        // The answer to a join that said which hands of another match this device held (`takeUp`): not this client's.
        if (this.haveOfOther === this.epoch) return;
        this.auditMissed(m.audit);
        return;
      case 'restored': {
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
          // The view on show stays, whatever hand the frame's own view names: every view this device was shown is held to
          // the replay of its hand, while this one is checked by nothing (only the frame's scores are, `matchEndVerdict`).
          // The host's view goes on show only on a device that holds none (one that came to the table at its end).
          const view = this.state.view ?? m.view;
          this.update({ view, matchOver: true, finalScores: m.scores.slice(), matchEndVerified, deadline: null, intermissionDeadline: null });
        }
        return;
      case 'chat':
        this.update({ chat: [...this.state.chat.slice(-99), { seat: m.seat, name: m.name, text: m.text, at: this.now() }] });
        return;
      case 'emote':
        this.update({ emotes: [...this.state.emotes.slice(-20), { seat: m.seat, emote: m.emote, at: this.now() }] });
        return;
      case 'error':
        // The table took the seat away on this link: from here on it answers `not_seated` there, and the server takes the
        // connection out of the room, so nothing about the table follows on it (`evictedOn`).
        if (m.code === 'evicted') {
          this.seatedOn = -1;
          this.evictedOn = this.epoch;
          this.evictedLink = this.link;
        }
        // Sent on a link the table seated this client on, which still holds the seat, `not_seated` is the server's own
        // making: the move it answers would go unanswered (it names no turn, so it excuses no move, `noteRefusal`).
        else if (m.code === 'not_seated' && this.seatedOn === this.epoch && this.holdsSeat()) this.flag(this.activeHand(), 'Host said this device had no seat on a connection where the table had seated it');
        this.noteRefusal(m);
        this.update({ lastError: m.message, lastErrorCode: m.code });
        return;
      case 'pong': {
        // (The ping it answers, if this run sent it: whether it went out after this link's join.)
        const ping = this.pings.get(m.at);
        const afterJoin = !!ping && !!this.joinOut && ping.epoch === this.epoch && this.joinOut.epoch === this.epoch && ping.out > this.joinOut.out;
        // On a link that has brought no state, a pong's stamp does not feed the watch: an honest host sends
        // the state first. As a fixed point it counts on any link (`notePong`), and so does its place in the order of the
        // stamps (`noteOrder`): an honest host's stamps never go back on a link, so a state that arrives behind an answer
        // stamped later was held back, the deal's own state while this device waits for it included.
        if (this.stateHere()) this.noteStamp(m.now);
        this.noteOrder(m.now, null, null);
        this.notePong(m.at, m.now);
        // An answer after the welcome, on a link that has brought no state yet: the link's first state can now only be a
        // deal's (`pongAfterWelcome`); before any frame about a hand, the table had no hand under way (`pongBeforeHand`).
        if (this.welcomedOn === this.epoch && !this.stateHere()) this.pongAfterWelcome = this.epoch;
        // An answer to a ping sent after the join (the one behind it included): an honest host had already sent whatever it
        // had of a hand for this seat, right behind its welcome (`pongBeforeHand`, `pongOn`).
        if (afterJoin && this.handFrameOn !== this.epoch) this.pongBeforeHand = this.epoch;
        if (afterJoin) this.pongOn = this.epoch;
        // An honest host sends right behind its welcome whatever it has of a hand for this seat (a deal under way, a state,
        // a result): an answer that comes first on such a link says the table had no hand under way when it seated this
        // run, so every hand after the last one this client saw end begins while it holds the seat (`runFromHand`).
        if (this.welcomedOn === this.epoch && this.handFrameOn !== this.epoch && this.state.matchId !== null) {
          const next = this.handsEnded.size > 0 ? Math.max(...this.handsEnded) + 1 : 0;
          this.runFromHand = Math.max(this.runFromHand ?? 0, next);
        }
        return;
      }
      case 'clock': {
        this.aboutHand(m.hand);
        // Nor a clock frame: an honest host sends one only to a seat it has sent the turn's state.
        if (!this.stateHere()) return;
        const shown = this.linkShown as NonNullable<ClientFrames['linkShown']>;
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

  /** Record a state frame of the hand being played: its hash, timing and whether we owed a move. */
  private noteState(v: TableView, m: Extract<HostMessage, { t: 'state' }>, stamped: { at: number; atLo: number; ref: number | null; wref: number | null; live: boolean; working: boolean; seg: number } | null = null, onLink = false, behind = false): void {
    const play = this.playFor(v.handNumber);
    const digest = viewDigest(v);
    // (A state restored damaged may hold any hash or view, `cleanSeen`: it is not compared.) An honest host sends one
    // turn's state with one hash and exactly the view of that state for this seat, so a second copy that shows another
    // view is as much another state as one with another hash: it fails at once, and no cap on the record can then give
    // up the copy that disagrees before the audit (`keepSeen`).
    const prior = play.seen.find((s) => s.tc === v.turnCounter && s.kept !== false);
    if (prior && (prior.hash !== m.hash || (typeof prior.view === 'string' && prior.view !== digest))) this.flag(v.handNumber, `Host showed two different states for turn ${v.turnCounter}`);
    // From here on this client watched the hand, so every move credited to its player must be one it sent. A stretch the
    // server said another device held the seat in ends here (this device holds the seat again, and is shown the hand).
    if (play.ledgerFrom === null || (play.ledgerFrom === Number.POSITIVE_INFINITY && !this.state.kicked)) {
      play.ledgerFrom = v.turnCounter;
      // (So does a stretch a restore without the app's journal left open, `unjournaled`.)
      const lost = play.unjournaled?.find((x) => x.to === undefined);
      if (lost) lost.to = Math.max(lost.from, v.turnCounter);
      const open = play.otherDevice?.find((x) => x.to === undefined);
      if (open) open.to = Math.max(open.from, v.turnCounter);
      // A hand this device has no stretch for yet, first shown since the server said another device held the seat: that
      // device's from the deal up to this state.
      else if (this.elsewhereOpen && v.turnCounter > 0) play.otherDevice = closedOtherDevice(play.otherDevice, 0, v.turnCounter);
      this.elsewhereOpen = false;
    }
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
    // (A stamp, when there is one, is a finite figure: `intake`.)
    const now = m.now;
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
      // It arrived behind a frame of its link stamped later (`noteOrder`): the host held it back.
      ...(behind ? { behind: true } : {}),
      owes,
      // The figures the app shows (`state`): finite, as `intake` holds every state to.
      deadline: m.deadline,
      timeBank: m.timeBank,
      inBank: m.inTimeBank,
      hash: m.hash,
      view: digest,
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
   * restarted table may keep time anew, so a notice begins a new clock era, at most `MAX_RESTART_ERAS` times per hand on
   * show (`eraHand`, `erasInHand`): a second restart makes that hand amber (`AUDIT_CAVEATS.restartedAgain`: its clock
   * was measured afresh within it), and a third fails it, as does a second that names another hand than the one on show.
   * (A server restart blames nobody, and a real one may come twice in a hand; a server can say it restarted at will, so the
   * count is bounded.)
   */
  private noteRestore(h: number, r: number): void {
    // A restored table may be behind what it sent before it restarted (a later hand's deal included).
    this.aheadOf = null;
    if (this.handsEnded.has(h)) return;
    const on = this.activeHand();
    // Every rejoin during the hand brings the same notice again; a different one is another restart.
    if (this.rewinds.some((x) => x.hand === h && x.tc === r)) return;
    if (h < on) {
      this.flag(on, 'Host sent a frame about a hand or turn this device was not on');
      return;
    }
    const eras = this.eraHand === on ? this.erasInHand : 0;
    if (eras >= MAX_RESTART_ERAS) {
      this.flag(on, 'Host said it restarted this hand more than twice');
      return;
    }
    // A second restart in a hand resumes the hand on show: a restored table that had moved on past it would have sent its
    // record first (`sendMissed`), and this device would be on the next hand.
    if (eras > 0 && h !== on) {
      this.flag(on, 'Host sent a frame about a hand or turn this device was not on');
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
      this.dropSet(h);
      if (this.standInHand === h) this.standInHand = null;
      if (this.handStart?.handNumber === h) this.handStart = null;
      if (this.chainChecked === h) this.chainChecked = null;
      if (this.state.view?.handNumber === h && this.state.lastResult === null) this.update({ view: null, stateHash: null, deadline: null, intermissionDeadline: null, ceremony: 'idle', standIn: false });
    }
    // The host that restarted may keep time afresh: what was learned about its clock stops here.
    this.era++;
    this.eraHand = on;
    this.erasInHand = eras + 1;
    this.rewinds.push({ hand: h, tc: r, undone, ...(eras > 0 ? { again: true as const } : {}) });
    this.trimHands(this.rewinds, MAX_REWINDS, (x) => x.hand);
  }

  /**
   * The host refused a move: mark it in the ledger so the audit does not expect it in the log, and file the refusal for
   * the audit to judge (`checkRefusals`). Only a refusal of a seated player's move counts (`MOVE_REFUSALS`: the host names
   * the turn of every such move it refuses, and `intake` holds it to that): a `not_seated`, which it sends a link that
   * holds no seat, answers no move this seat made there, with or without a turn, and nor does any other code. Such a move
   * stays as sent, unanswered, for the rules on moves the table played over and on the seat's own moves played after it.
   */
  private noteRefusal(m: Extract<HostMessage, { t: 'error' }>): void {
    const code = m.code;
    if (!MOVE_REFUSALS.has(code) || !isInt(m.turnCounter)) return;
    const tc = m.turnCounter;
    // A refusal answers a move this seat made in the hand being played, the one on show (`act` files each move
    // under it), never the hand of whichever record was made last.
    const v = this.state.view;
    const play = v && !this.handsEnded.has(v.handNumber) ? this.plays.find((p) => p.hand === v.handNumber) : undefined;
    if (!play || !v) return;
    // (An honest host answers a move on the link it came over: only this link's moves, made in this run of the app.)
    const open = play.sent.filter((s) => !s.rejected && s.tc === tc && s.epoch === this.epoch && s.run === this.runId);
    const target = open[open.length - 1];
    // Every state the host reached before it refused has arrived before the refusal (frames come in order).
    const at = v.turnCounter;
    // Only a refusal of a move made in this hand counts here (a stray answer to an older hand's move does not).
    if (target) {
      target.rejected = code;
      target.refusedAt = at;
      play.refusals = [...(play.refusals ?? []), { tc, at, epoch: this.epoch, run: this.runId }].slice(-MAX_SENT);
    }
  }
}
