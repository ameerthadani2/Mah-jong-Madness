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
 * `TableClient` is this file: what the app calls (join, act, ping, checkLink, leave, the state it shows), saving and
 * restoring (`serialize`, `restore`, `fromArchive`) and binding to a link. It is built on one concern a file:
 * `clientcore.ts` (everything it keeps, each record with what it is for), `clientledger.ts` (the hands it follows and
 * who held the seat), `clientwatch.ts` (the link watch and the clocks), `clientaudit.ts` (the audit of a hand) with
 * `clientreplay.ts` (the replay), and `clientframes.ts` (what it does with each frame). The words of the audit are in
 * `clientwords.ts`. Beside them: `clientrecords.ts` (the records it keeps and their saved form, and the guards on what
 * the host sends), `clientclock.ts` (its clock and what it knows of the host's) and `clientmoves.ts` (the table's
 * published move rule and the check of when the table may play this seat).
 */
import { sanitizeRules, viewToState, type Action, type GameState, type HandResult, type MatchSnapshot, type TableView } from '@mjm/engine';
import type { Link } from './host';
import type { Audit, ClientMessage, HostMessage } from './messages';
import { keptAudit, MOVE_REFUSALS } from './intake';
import { isFrame, type Transport, type Unsubscribe } from './transport';
import { BANK_ROUND_MS, MAX_PAUSES, MAX_PING_SCOPES, MAX_PINGS, MAX_RUN_SCOPES, ownClockFrom, type OwnClock, type TableClientOptions } from './clientclock';
import { clockTrack, isBotSkill, ownRun, streakEnd } from './clientmoves';
import { cleanCeremony, cleanJournal, cleanPlay, cleanRunScope, CLIENT_SNAPSHOT_VERSION, fitRecord, lastAuditOf, isCommitSet, isInt, isLateTurnRecord, isObject, isPassedClaimRecord, journalEntry, MAX_SENT, openOtherDevice, savedPlay, withSum, type GapStart, type RunScope, type SentAction, type SerializedClient } from './clientrecords';
import type { AuditCheck } from './clientwords';
import { MAX_AUDITS, MAX_HAND_RECORDS, MAX_RESTART_ERAS, type RedHand, type ClientState } from './clientcore';
import { ClientFrames } from './clientframes';

export { AUDIT_CAVEATS, AUDIT_FAILURES, auditFailure, caveatKey, failureKey, type AuditCaveat, type AuditCheck, type AuditFailure, type AuditStatus, type LateTurnRecord, type PassedClaim, type PassedClaimRecord } from './clientwords';
export { MAX_AUDITS, type ChatLine, type ClientState, type RedHand } from './clientcore';
export { MOVE_SLACK_MS } from './clientreplay';
export { clientClock, SILENT_ANSWER_MS, steadyClock, type KeptRecord, type OwnClock, type TableClientOptions } from './clientclock';
export { tableRule } from './clientmoves';
export { CLIENT_SNAPSHOT_VERSION, type JournalEntry, type SerializedClient } from './clientrecords';

/** How many failures of a red hand, and how many characters of each, the list kept apart from the record holds. */
const RED_FAILURES = 8;
const RED_FAILURE_CHARS = 300;

export function transportLink(transport: Transport, hostPeerId: string): Link {
  return {
    send: (msg) => transport.send(hostPeerId, msg),
    onMessage: (cb) => transport.onMessage((from, msg) => from === hostPeerId && cb(msg as HostMessage)),
    close: () => transport.close(),
    onClose: (cb) => transport.onClose?.(cb) ?? (() => undefined),
  };
}

export class TableClient extends ClientFrames {
  /** A client for the player `name` at the table `link` leads to; `ClientCore` (clientcore.ts) sets up what it keeps. */
  constructor(link: Link, name: string, avatar?: string, identity: { token?: string; userId?: string } = {}, opts: TableClientOptions = {}) {
    super(link, name, avatar, identity, opts);
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

  /**
   * A client for a table whose record this device kept after the server said the table was gone, or after it gave the
   * table up (the app keeps such records for a while, under the room and the match). It joins with the record's token and
   * says which hands of the match it holds (`have`), and it takes the record up as `restore` does at the table's first
   * word about the table, as long as that is not a `welcome` naming another match: another match at this room code is
   * another table (codes are used again once a table is gone), and the client then goes on as one that joined with
   * nothing (no record, no token). It joins as the device the record was made on (`device`), as `restore` does: a
   * table that says another device held the seat since means one that is not this one. An unknown or damaged record
   * gives a client built from `identity` alone.
   */
  static fromArchive(saved: unknown, link: Link, name: string, avatar?: string, identity: { token?: string; userId?: string } = {}, opts: TableClientOptions = {}): TableClient {
    const d = TableClient.loadable(saved, name, avatar);
    if (!d) return new TableClient(link, name, avatar, identity, opts);
    const token = identity.token ?? (typeof d.state.token === 'string' && d.state.token ? d.state.token : undefined);
    const c = new TableClient(link, name, avatar, { ...identity, ...(token ? { token } : {}) }, opts);
    c.pending = d;
    // (This device kept a record at this table: not its first run there, whether or not the record is taken up.)
    c.firstRun = false;
    if (typeof d.device === 'string' && /^[\w-]{6,64}$/.test(d.device)) c.deviceId = d.device;
    return c;
  }

  /** A copy of `saved` when it is a record of a match that loads (as `restore` would find); null otherwise: it is no record. */
  private static loadable(saved: unknown, name: string, avatar?: string): SerializedClient | null {
    if (!isObject(saved) || saved.version !== CLIENT_SNAPSHOT_VERSION || !isObject(saved.state) || typeof saved.state.matchId !== 'string') return null;
    const d = JSON.parse(JSON.stringify(saved)) as SerializedClient;
    const idle: Link = { send: () => undefined, onMessage: () => () => undefined, close: () => undefined };
    try {
      new TableClient(idle, name, avatar, {}, {}).load(JSON.parse(JSON.stringify(d)) as SerializedClient);
    } catch {
      return null;
    }
    return d;
  }

  /**
   * The first welcome naming a match (`m`) that this client holds no record of: the app may keep one of that match
   * (`TableClientOptions.keptRecord`, asked once). One of this seat that loads is taken up as a kept record given to
   * `fromArchive` is (`takeUp`), with the app's journal of the match; the join on this link said nothing of the hands it
   * holds, so an honest table sends no records of the hands that ended meanwhile, and a hand the table moved past is amber
   * (`closeUnheard`). One the app kept under another room than the one this client joined (`moved`): an honest server runs
   * a match under one room code for its life, so the hand the record was on fails, and the match with it. The red hands
   * the app kept apart are kept as `keepRed` keeps them, also when no record comes.
   */
  protected override lookUpKept(m: Extract<HostMessage, { t: 'welcome' }>): void {
    const ask = this.keptRecord;
    this.keptRecord = null;
    if (!ask) return;
    let k: ReturnType<NonNullable<TableClientOptions['keptRecord']>>;
    try {
      k = ask(m.matchId);
    } catch {
      return;
    }
    if (!isObject(k)) return;
    const d = TableClient.loadable(k.client, this.name, this.avatar);
    const seat = d && isObject(d.state) ? d.state.seat : null;
    if (d && d.state.matchId === m.matchId && (seat === null || seat === undefined || seat === m.seat)) {
      const joinedAs = this.deviceId;
      this.pending = d;
      this.pendingRed = k.red ?? null;
      this.journal = Array.isArray(k.journal) ? k.journal : undefined;
      this.takeUp(m.matchId);
      if (this.state.matchId === m.matchId) {
        // The table holds the seat under the device this client joined as: it stays this client's, or its next join would
        // be counted as another move of the seat.
        this.deviceId = joinedAs;
        this.tookUpAtWelcome = true;
      }
      if (k.moved === true && this.state.matchId === m.matchId) {
        this.flag(this.activeHand(), 'Host ran this match under another room code than the one this device kept its record of');
        this.update({ matchFailed: true, matchEndVerified: false });
      }
      return;
    }
    if (k.red !== undefined) this.redLater = k.red;
  }

  private load(d: SerializedClient): void {
    this.fresh = false;
    this.firstRun = false;
    if (typeof d.device === 'string' && /^[\w-]{6,64}$/.test(d.device)) this.deviceId = d.device;
    this.handovers = isInt(d.handovers) && d.handovers >= 0 ? d.handovers : null;
    const st = d.state;
    // Each audit as this build files it (`keptAudit`, as `intake` cuts every audit that comes): a record an earlier build
    // saved may hold them whole (`restartReasons` and all), and a result the table sends again is compared with the one
    // on file, like with like. The last audit stays the entry of the list it is.
    const savedAudits = Array.isArray(st.audits) ? st.audits.slice(-MAX_AUDITS) : [];
    const savedLast = lastAuditOf(st, d.lastAuditAt);
    const audits = savedAudits.map((a) => (isObject(a) && isObject(a.audit) ? { ...a, audit: keptAudit(a.audit) } : a));
    const lastAt = savedLast ? savedAudits.findIndex((a) => isObject(a) && a.audit === savedLast) : -1;
    this.state = {
      ...this.state,
      ...st,
      rules: st.rules ? sanitizeRules(st.rules) : null,
      audits,
      // The last audit is saved once, as the entry of the list it is (`lastAuditAt`); records saved before carry it whole.
      lastAudit: lastAt >= 0 ? audits[lastAt].audit : savedLast ? keptAudit(savedLast) : null,
      claimsPassedAway: Array.isArray(st.claimsPassedAway) ? st.claimsPassedAway.filter(isPassedClaimRecord).map((x) => ({ hand: x.hand, turn: x.turn, claim: x.claim, ...(x.late === true ? { late: true } : {}) })) : [],
      turnsShownLate: Array.isArray(st.turnsShownLate) ? st.turnsShownLate.filter(isLateTurnRecord).map((x) => ({ hand: x.hand, late: x.late.slice(), of: x.of })) : [],
      token: this.identity.token ?? st.token ?? null,
      connected: false,
      disconnected: true,
      kicked: false,
      heldElsewhere: false,
      chat: [],
      emotes: [],
      rttMs: null,
      lastError: null,
      lastErrorCode: null,
    };
    this.secret = d.secret;
    // (A record saved before the sets were kept per hand holds one set, under `commits` and `commitsHand`.)
    const sets = Array.isArray(d.commitSets) ? d.commitSets : d.commits && isInt(d.commitsHand) ? [{ hand: d.commitsHand, commits: d.commits }] : [];
    this.commitSets = sets.filter((x) => isObject(x) && isInt(x.hand) && isCommitSet(x.commits)).map((x) => ({ hand: x.hand, commits: x.commits.map((c) => ({ seat: c.seat, hash: c.hash })) }));
    this.commitHand = d.commitHand;
    this.aheadOf = isInt(d.aheadOf) ? d.aheadOf : null;
    this.standInHand = d.standInHand;
    this.joinedHand = d.joinedHand;
    this.firstHand = d.firstHand;
    this.noHistory = d.noHistory === true;
    this.handsEnded = new Set((Array.isArray(d.handsEnded) ? d.handsEnded : []).filter(isInt));
    this.tamper = new Map((Array.isArray(d.tamper) ? d.tamper : []).filter((e): e is [number, string[]] => Array.isArray(e) && isInt(e[0]) && Array.isArray(e[1])).map(([h, list]) => [h, list.filter((x) => typeof x === 'string')]));
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
    this.brokenHand = isInt(d.brokenHand) ? d.brokenHand : null;
    this.chainGap = d.chainGap === true || this.gapHand !== null;
    this.missedMoves = d.missedMoves === true;
    // (A record saved before the flag was kept says so by the audits it holds of this match.)
    const matchFailed = st.matchFailed === true || this.state.audits.some((a) => isObject(a) && a.status === 'failed' && isObject(a.audit) && a.audit.matchId === this.state.matchId);
    this.state = { ...this.state, matchFailed, matchEndVerified: this.matchEnded && !this.chainGap && !this.missedMoves && !matchFailed && this.state.matchOver };
    this.rewinds = Array.isArray(d.rewinds) ? d.rewinds.filter((x) => isObject(x) && isInt(x.hand) && isInt(x.tc)).map((x) => ({ hand: x.hand, tc: x.tc, undone: x.undone === true, ...(x.again === true ? { again: true as const } : {}) })) : [];
    this.eraHand = isInt(d.eraHand) ? d.eraHand : null;
    this.erasInHand = this.eraHand === null ? 0 : isInt(d.erasInHand) && d.erasInHand >= 1 ? Math.min(d.erasInHand, MAX_RESTART_ERAS) : 1;
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
    this.seq = Math.max(0, isInt(d.sentSeq) ? d.sentSeq : 0, ...this.plays.flatMap((p) => p.sent.map((x) => (isInt(x.seq) ? x.seq : 0))));
    // With the app's journal, the moves filed after the record was written go back into it: this client then knows every
    // move this device sent, over every run of the app (`writeAhead`).
    const whole = this.takeJournal(d);
    this.journalWhole = whole;
    this.elsewhereOpen = d.elsewhereOpen === true;
    // What this device did before the app stopped is not all on record (it may have left the table).
    this.noteOwnAbsence();
    this.lapse = true;
    // The app stopped: the link it had is gone. Without a journal, moves sent just before the last save may be missing
    // from the ledger, so it vouches for the log of a hand still under way only from the next state it sees.
    // (Every such hand, whichever record was made last.) Before the latest state the record holds it still does: the
    // record saved that stretch (`serialize`, `vouchedThrough`), and `cleanPlay` read it back if storage left it whole.
    // A hand whose every move went to the journal before it went out (`PlayRecord.whole`) keeps its ledger as it was.
    this.noteLinkLost();
    for (const play of this.plays) {
      if (this.handsEnded.has(play.hand) || (whole && play.whole)) continue;
      // Such a hand restored without a journal that vouches (the app holds no list for the match, or one with a gap or that
      // storage damaged): a move this device sent after the record was written may be missing from it, and the journal
      // that would hold it is gone. A missing journal vouches for nothing: from the latest turn the record holds until
      // this client is shown the hand again, a move credited to the player that the record does not hold makes the hand
      // amber and keeps the end of the match unverified (`unjournaled`), where a record an earlier build wrote leaves it
      // unchecked.
      if (play.whole) play.unjournaled = openOtherDevice(play.unjournaled, this.lastShown(play.hand));
      play.ledgerFrom = Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Put the moves the app's journal holds that the record `d` does not (filed after it was written) back into their hands'
   * records, in the order they were filed. True when the journal vouches for the record: this client files moves through the
   * journal (`writeAhead`), was given it (`TableClientOptions.journal`), every entry is what a client wrote, and the entries
   * after the record's last move (`sentSeq`) run on without a gap. A hand under way whose ledger was kept whole then keeps
   * it (`load`). False otherwise: the restored client vouches as one with no journal does.
   */
  private takeJournal(d: SerializedClient): boolean {
    const list = this.journal;
    this.journal = undefined;
    const matchId = this.state.matchId;
    if (!this.writeAhead || !Array.isArray(list) || typeof matchId !== 'string') return false;
    const { ok, entries, last } = cleanJournal(list, matchId);
    if (!ok) return false;
    let next = (isInt(d.sentSeq) && d.sentSeq > 0 ? d.sentSeq : 0) + 1;
    for (const e of entries) {
      if (e.seq < next) continue;
      if (e.seq !== next) return false;
      next++;
    }
    for (const e of entries) {
      if (this.handsEnded.has(e.hand)) continue;
      let play = this.plays.find((p) => p.hand === e.hand);
      if (!play) {
        // A hand that began after the record was written: every move this device sent in it is in the journal, and the
        // ledger vouched from where its first entry says.
        play = { hand: e.hand, seen: [], sent: [], ledgerFrom: e.from, whole: true };
        this.plays.push(play);
        this.trimHands(this.plays, MAX_HAND_RECORDS, (p) => p.hand);
      }
      if (play.sent.some((x) => x.seq === e.seq)) continue;
      play.sent.push({ tc: e.tc, action: e.action, epoch: e.epoch, at: e.at, run: e.run, seg: e.seg, seq: e.seq });
      if (play.sent.length > MAX_SENT) play.sent.splice(0, play.sent.length - MAX_SENT);
    }
    // In the order they were filed (moves filed without a journal, by an earlier build, before any that were).
    for (const play of this.plays) play.sent.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    this.seq = Math.max(this.seq, last);
    // The links the journal's moves went out on are gone too: the next one is a new link.
    for (const e of entries) if (e.epoch > this.epoch) this.epoch = e.epoch;
    return true;
  }

  /**
   * The hands of the match this client is in that it found red, each with its first few failures (a hand still under way
   * that the table was already caught out in among them): a list small enough for the app to save apart from the record
   * of the table (a few hundred characters a hand), so that a red verdict outlives a save of the record that was not
   * written (`keepRed`).
   */
  redHands(): RedHand[] {
    const m = this.state.matchId;
    if (!m) return [];
    const byHand = new Map<number, string[]>();
    const add = (hand: number, failures: readonly string[]) => byHand.set(hand, [...new Set([...(byHand.get(hand) ?? []), ...failures])]);
    for (const a of this.state.audits) if (a.status === 'failed' && a.audit.matchId === m && isInt(a.audit.handNumber)) add(a.audit.handNumber, a.failures);
    // A hand not yet ended that this client has already caught the table out in: its audit will carry these failures.
    for (const [hand, flags] of this.tamper) if (flags.length > 0 && !this.handsEnded.has(hand)) add(hand, flags);
    return [...byHand].map(([hand, failures]) => ({ matchId: m, hand, failures: failures.slice(0, RED_FAILURES).map((f) => f.slice(0, RED_FAILURE_CHARS)) }));
  }

  /**
   * Red hands the app kept apart from the record (`redHands`) that the record this client was restored from does not show
   * red: the app could not write the record after the hand failed, and storage still held an older one. Each is red again
   * (a hand that has ended in the record is listed with its failures; one that has not carries them into its own audit),
   * and so is the match. Entries for another match, or that do not hold together, are left out.
   */
  override keepRed(list: unknown): void {
    if (this.pending) {
      this.pendingRed = list;
      return;
    }
    const m = this.state.matchId;
    // A client that holds no match yet keeps them for the match its first welcome names.
    if (!m) {
      if (Array.isArray(list)) this.redLater = list;
      return;
    }
    if (!Array.isArray(list)) return;
    let audits = this.state.audits;
    let any = false;
    for (const x of list) {
      if (!isObject(x) || x.matchId !== m || !isInt(x.hand) || x.hand < 0 || !Array.isArray(x.failures)) continue;
      const failures = [...new Set(x.failures.filter((f): f is string => typeof f === 'string' && f.length > 0).slice(0, RED_FAILURES).map((f) => f.slice(0, RED_FAILURE_CHARS)))];
      if (failures.length === 0 || audits.some((a) => a.status === 'failed' && a.audit.matchId === m && a.audit.handNumber === x.hand)) continue;
      any = true;
      if (this.handsEnded.has(x.hand)) {
        const audit: Audit = { matchId: m, handNumber: x.hand, seed: '', commits: [], reveals: [], log: [], finalHash: '', rngVersion: '', ceremonyAttempts: 0, restarts: [], restartReasons: [] };
        audits = [...audits, { audit, status: 'failed' as const, failures, caveats: [] }].slice(-MAX_AUDITS);
      } else for (const f of failures) this.flag(x.hand, f);
    }
    if (any) this.update({ audits, matchFailed: true, matchEndVerified: false });
  }

  /**
   * Everything needed to carry on verifying after an app restart (see `TableClient.restore`). It keeps exactly what this
   * client keeps in memory: every collection is already held to its cap as it grows (`trimHands`, `flag`), never at
   * the cost of the hand this client is on, so it is written whole and comes back the same.
   */
  serialize(): SerializedClient {
    const { chat: _c, emotes: _e, rttMs: _r, ...state } = this.state;
    void _c;
    void _e;
    void _r;
    return fitRecord({
      version: CLIENT_SNAPSHOT_VERSION,
      state: { ...state, audits: state.audits.slice(-MAX_AUDITS) },
      device: this.deviceId,
      ...(this.handovers !== null ? { handovers: this.handovers } : {}),
      secret: this.secret,
      // The set of the hand last published, as records saved before the sets were kept per hand hold it.
      commits: this.commitSets[this.commitSets.length - 1]?.commits ?? null,
      commitHand: this.commitHand,
      aheadOf: this.aheadOf,
      commitsHand: this.commitSets[this.commitSets.length - 1]?.hand ?? null,
      commitSets: this.commitSets.map((x) => ({ hand: x.hand, commits: x.commits.map((c) => ({ ...c })) })),
      standInHand: this.standInHand,
      joinedHand: this.joinedHand,
      firstHand: this.firstHand,
      noHistory: this.noHistory,
      handsEnded: [...this.handsEnded].sort((a, b) => a - b),
      tamper: [...this.tamper.entries()].map(([h, list]) => [h, list.slice()]),
      handStart: this.handStart,
      records: this.records,
      // Each frame goes with its check figure, so a restored record can tell a damaged frame (`cleanSeen`), and so
      // does each answer to a ping and first ping of a scope: each measures only the frames of the run that made it.
      // A hand under way goes with the stretch its ledger vouches for up to the latest state it holds (`vouchedThrough`):
      // the record is written after those states came, and every move is filed before it goes out, so every move made
      // before the latest of them is in it. A client restored from it (`load`, which vouches again only from its next
      // state) still holds the log to those moves.
      plays: this.plays.map((p) => {
        const vouched = this.vouchedThrough(p);
        return savedPlay(vouched === p.vouched ? p : { ...p, vouched });
      }),
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
      brokenHand: this.brokenHand,
      chainGap: this.chainGap,
      missedMoves: this.missedMoves,
      rewinds: this.rewinds,
      eraHand: this.eraHand,
      erasInHand: this.erasInHand,
      lapseHand: this.lapseHand,
      lapseDeal: this.lapseDeal,
      ...(this.seq > 0 ? { sentSeq: this.seq } : {}),
      ...(this.elsewhereOpen ? { elsewhereOpen: true as const } : {}),
      clock: { era: this.era, base: { ...this.clockBase }, lastStamp: this.lastStamp, ownAbsences: this.ownAbsences.slice(), gapVerdicts: this.gapVerdicts.slice(), runs: this.runScopes().map(withSum) },
    }, (h) => this.handsEnded.has(h));
  }

  protected override bind(link: Link): void {
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
      // Nor from a link the table took the seat away on (`evictedLink`). A frame about the table there, a welcome included,
      // is the server's own making: it fails the hand on show. (Not the answers a table gives a link that holds no seat: a
      // pong, or an error that refuses no move. They say nothing about the table, and are not taken either.)
      if (this.evictedLink === link) {
        const t = (m as { t: string }).t;
        const code = (m as { code?: unknown }).code;
        if (t !== 'pong' && !(t === 'error' && !(typeof code === 'string' && MOVE_REFUSALS.has(code)))) {
          const problem = 'Host sent table frames on a connection where this device held no seat';
          this.flag(this.activeHand(), problem);
          // (No result of that hand comes to this client now: the failure is put on show at once.)
          this.failNow(problem);
        }
        return;
      }
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
    const have = this.have();
    this.joinHave = { epoch: this.epoch, have };
    const joinAt = this.now();
    this.joinOut = { epoch: this.epoch, out: this.send({ t: 'join', name: this.name, avatar: this.avatar, wantSeat, token, userId: this.identity.userId, have, device: this.deviceId }), at: joinAt };
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
    // A kept record not yet taken up says it for the match it holds.
    const d = this.pending;
    if (d) {
      const ended = (Array.isArray(d.handsEnded) ? d.handsEnded : []).filter(isInt);
      return ended.length > 0 ? Math.max(...ended) : d.atStart === true ? -1 : undefined;
    }
    if (this.state.matchId === null) return undefined;
    if (this.handsEnded.size > 0) return Math.max(...this.handsEnded);
    return this.atStart ? -1 : undefined;
  }

  /**
   * Send a move for this seat. It is filed first (`PlayRecord.sent`), so the audit holds the log to it whatever the table
   * answers; with the app's journal (`TableClientOptions.writeAhead`) it then goes to the journal, and out once the journal
   * has it: a client restored from the record and the journal knows every move this device sent.
   */
  act(action: Action): void {
    // Nor does it send a move once its seat was opened on another device (the player takes the seat back from Home first),
    // or taken away on this link.
    if (!this.mayAct()) return;
    const v = this.state.view;
    const tc = v && isInt(v.turnCounter) ? v.turnCounter : undefined;
    const msg: ClientMessage = { t: 'action', seat: this.state.seat as number, action, expectHash: this.state.stateHash ?? undefined, turnCounter: tc };
    if (!v || tc === undefined) {
      this.send(msg);
      return;
    }
    const play = this.playFor(v.handNumber);
    const at = this.now();
    this.ran(at);
    const filed: SentAction = { tc, action, epoch: this.epoch, at, run: this.runId, seg: this.seg(), ...(this.writeAhead ? { seq: ++this.seq } : {}) };
    play.sent.push(filed);
    if (play.sent.length > MAX_SENT) play.sent.splice(0, play.sent.length - MAX_SENT);
    const hook = this.writeAhead;
    if (!hook) {
      this.sendMove(msg, filed);
      return;
    }
    // Not sent: off the record, so it vouches for nothing in the log.
    const drop = () => {
      const i = play.sent.indexOf(filed);
      if (i >= 0) play.sent.splice(i, 1);
    };
    // Not written down: not sent, and off the record (the player may make the move again).
    const unfile = () => {
      drop();
      this.update({ lastError: 'This move could not be saved on this device, so it was not sent.', lastErrorCode: 'move_unsaved' });
    };
    let wrote: void | Promise<void>;
    try {
      wrote = hook(journalEntry(this.state.matchId ?? '', v.handNumber, filed as SentAction & { seq: number; at: number; run: string; seg: number }, play.ledgerFrom));
    } catch {
      unfile();
      return;
    }
    if (!wrote || typeof (wrote as Promise<void>).then !== 'function') {
      this.sendMove(msg, filed);
      return;
    }
    // Out on the link it was filed for, once the journal has it, as long as this client may still move there and the hand
    // it was made in is still under way (and off the record if not: the link it was made on is gone, or the seat with it,
    // or the hand is over). A table plays a move in whatever hand it has on: one written after its hand ended would be
    // played in the next, whose record does not hold it, for a seat whose player never chose it there.
    const link = this.link;
    const epoch = this.epoch;
    const hand = v.handNumber;
    (wrote as Promise<void>).then(
      () => {
        const under = !this.handsEnded.has(hand) && this.state.view?.handNumber === hand;
        if (this.link === link && this.epoch === epoch && this.mayAct() && under) this.sendMove(msg, filed);
        else drop();
      },
      unfile,
    );
  }

  /** This client may send a move now: it holds a seat on the link in use, and has been shown a state there. */
  private mayAct(): boolean {
    if (this.state.seat === null || this.state.kicked || this.evictedOn === this.epoch) return false;
    // A view from before the link was lost says nothing about the table now: wait for the first state on this link.
    return this.viewEpoch === this.epoch;
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
  override ping(): void {
    const at = this.now();
    if (this.pings.has(at)) return;
    const play = this.handOnShow();
    const seg = this.seg();
    const ping = { seg, hand: play ? play.hand : null, epoch: this.epoch, out: 0 };
    this.pings.set(at, ping);
    if (this.pings.size > MAX_PINGS) this.pings.delete(this.pings.keys().next().value as number);
    if (play) {
      play.pinged = (play.pinged ?? 0) + 1;
      const from = (play.pingedFrom ??= []);
      if (!from.some((p) => p.era === this.era && p.run === this.runId && p.seg === seg)) {
        from.push({ era: this.era, run: this.runId, seg, at });
        if (from.length > MAX_PING_SCOPES) from.shift();
      }
    }
    ping.out = this.send({ t: 'ping', at });
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

  /** This device's clock as the table client reads it (`clientClock`): what `ownClock` is measured against. */
  clockNow(): number {
    return this.now();
  }

  /**
   * The kept record (`pending`) at the table's first word about the table: taken up as `restore` takes a record up, unless
   * that word is a welcome naming another match than the record's. That is another table under the same room code: the
   * client goes on as one that joined with nothing (no record, no token), and on this link it does not judge the records
   * an honest table sends in answer to the hands its join said it held (`haveOfOther`), which are of the table's own match.
   */
  protected override takeUp(matchId: string | null): void {
    const d = this.pending as SerializedClient;
    this.pending = null;
    if (matchId === null || matchId === d.state.matchId) {
      try {
        this.load(d);
        // The join went out on this link before the record was taken up: what it said holds for the link as it is now.
        if (this.joinHave) this.joinHave = { ...this.joinHave, epoch: this.epoch };
        const red = this.pendingRed;
        this.pendingRed = null;
        if (red !== null) this.keepRed(red);
        return;
      } catch {
        // (`fromArchive` found it loads.) A record that does not load is no record: nothing of it counts.
        this.resetMatch();
        this.state = { ...this.state, audits: [], lastAudit: null, auditStatus: 'unverified', auditFailures: [], auditCaveats: [] };
      }
    }
    this.pendingRed = null;
    this.noHistory = false;
    this.lapse = false;
    this.fresh = true;
    this.state = { ...this.state, token: null, matchId: null, seat: null };
    if (this.joinHave && this.joinHave.epoch === this.epoch && this.joinHave.have !== undefined) this.haveOfOther = this.epoch;
    if (this.joinHave) this.joinHave = { ...this.joinHave, have: undefined };
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
}
