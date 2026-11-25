/**
 * The ground truth of a run, which the phone never sees: every move its client sent and every move the server wrote into
 * the log in its place, every frame the honest host sent the phone and what of it reached the phone (whole, changed or
 * not at all), every notice and whether it was true, every run of the client and of the app, and what each run showed
 * the player in the end. The oracle (oracle.ts) judges the phone's verdicts against it.
 */
import type { Action, GameState } from '@mjm/engine';
import type { ClientMessage, HostMessage, SerializedClient, TableClient } from '../../src/index';
import { engine, net } from './load';
import type { Line, Phone, Sim } from './sim';
import type { StateKind } from './scenario';

export interface Verdict {
  status: string;
  failures: string[];
  caveats: string[];
}

/** What a run of the client showed: its hands' verdicts and the end of the match. */
export interface Shown {
  audits: Map<number, Verdict>;
  matchOver: boolean;
  matchEndVerified: boolean;
  matchFailed: boolean;
  matchId: string | null;
}

export interface RunInfo {
  run: number;
  appRun: number;
  /** initial, restore (from the saved slot), archive (a kept record), token (the token alone), fresh (nothing), other. */
  how: string;
  createdAt: number;
  endedAt: number | null;
  /** For a run taken up from a record: the latest turn of each hand the record holds a state of. */
  recordLatest: Map<number, number>;
  /** When the run was first shown a state of each hand. */
  firstShown: Map<number, number>;
  welcomedAt: number | null;
  /** The record the run was taken up from was saved this long before it was taken up (ms). */
  recordAge: number | null;
  /** The run is the first on a new phone (another app, nothing of the last one's records). */
  newDevice: boolean;
  shown: Shown | null;
  /** The run was made from a record with what the app's journal held for its match (`TableClientOptions.journal`). */
  journal: boolean;
  /** A run that joined holding no record took one up at its first welcome (the lookup by match): moved, when it was kept under another room. */
  tookUpAtWelcome: { moved: boolean } | null;
  /** A run restored from the saved slot: when the record it took up was put there (null for other runs). */
  recordAt: number | null;
  /** A welcome that said another device had held the seat reached the run (the first such, when). */
  elsewhereAt: number | null;
}

export interface LineInfo {
  n: number;
  run: number;
  openedAt: number;
  closedAt: number | null;
  welcomedAt: number | null;
  /** Hands with a frame of theirs (a state, a deal frame, a result) delivered on the line. */
  brought: Set<number>;
  /** Hands with a state delivered on the line, and when the first one came. */
  statesOf: Set<number>;
  firstStateAt: Map<number, number>;
  committed: Set<number>;
  revealed: Set<number>;
  /** Answers to pings that reached the phone on the line: when, and when the host sent them. */
  pongs: Array<{ at: number; sentAt: number }>;
  evictedAt: number | null;
  evictFalse: boolean;
  /** A frame about the game reached the phone on the line after its eviction. */
  frameAfterEvict: boolean;
}

/** A decision the host asked of seat 0. */
export interface DecisionInfo {
  key: string;
  hand: number;
  tc: number;
  kind: StateKind;
  startedAt: number;
  /** When the honest table would time the seat out (its turn clock and bank, by the host's clock). */
  deadline: number;
  /** The host sent the decision's state on these lines. */
  sentOn: Array<{ line: number; at: number }>;
  /** It reached these runs of the phone. */
  reached: Array<{ line: number; run: number; at: number }>;
  playedAt: number | null;
  playedBy: LogMove | null;
}

export interface MoveContext {
  run: number;
  appRun: number;
  appRunning: boolean;
  /** The player's client was up (a run active). */
  hasClient: boolean;
  line: number | null;
  lineOpen: boolean;
  /** The client had taken a notice that the seat was opened on another device, and no later run had been welcomed since. */
  kicked: boolean;
  evicted: boolean;
  /** A run of the phone was shown a state of this hand before the move. */
  shownHand: boolean;
  /** The current run was shown a state of this hand before the move. */
  shownThisRun: boolean;
  stoodIn: boolean;
  fixedPoint: boolean;
  /** The table's rule (`timeoutAction`) gives this very move here. */
  isRuleMove: boolean;
  /** How long before the seat's whole clock would have run out the move came (negative: after it). */
  earlyBy: number;
  restoredNotice: boolean;
  /** An app restart, a resume from Home or a new client happened during the decision. */
  runChanged: boolean;
}

export interface LogMove {
  hand: number;
  n: number;
  action: Action;
  source: 'player' | 'auto';
  origin: 'victim' | 'other' | 'forged' | 'table';
  at: number;
  /** The line a move from the phone came on, and the turn it was sent at. */
  line: number | null;
  msgTc: number | null;
  decision: DecisionInfo | null;
  ctx: MoveContext;
}

export interface SentMove {
  run: number;
  line: number;
  hand: number | null;
  tc: number | null;
  action: Action;
  at: number;
}

export interface DroppedMove {
  id: number;
  run: number;
  line: number;
  at: number;
  hand: number;
  hostTc: number;
  msgTc: number | null;
  action: Action;
  /** Legal in the host's state when the server dropped it. */
  legal: boolean;
  /** The decision it answered was due this long after it was sent. */
  leftMs: number;
  /** Refusals the server sent for it; `reachedAt`: when one reached the phone (null: lost with its link or the app). */
  refusals: Array<{ at: number; code: string; turn: number | null; legalNow: boolean; afterState: boolean; reachedAt: number | null; run: number | null }>;
  /** Another move of the phone, sent on the same line since, played while this one was still legal. */
  replacedBy: LogMove | null;
  /** The line it went out on broke before the table moved past it. */
  lineBroke: boolean;
}

export interface Intent {
  run: number;
  hand: number;
  tc: number;
  action: Action;
  at: number;
  sent: boolean;
  kicked: boolean;
  evicted: boolean;
}

export interface Notice {
  kind: 'seatTaken' | 'elsewhere' | 'evicted' | 'restored' | 'standIn' | 'repick' | 'newMatch' | 'fakeEnd';
  at: number;
  line: number | null;
  run: number;
  falseNotice: boolean;
  hand: number | null;
}

/** Where `m` is about: its hand, when it names one. */
export function handOf(m: HostMessage): number | null {
  switch (m.t) {
    case 'state':
      return m.view?.handNumber ?? null;
    case 'clock':
      return m.hand;
    case 'hand_over':
    case 'hand_missed':
      return m.audit?.handNumber ?? null;
    case 'commit_request':
    case 'commits':
    case 'reveal_request':
    case 'stand_in':
      return m.handNumber;
    default:
      return null;
  }
}

const GAME_FRAMES = new Set(['state', 'clock', 'hand_over', 'hand_missed', 'commit_request', 'commits', 'reveal_request', 'stand_in', 'match_over', 'restored', 'welcome']);

/** The latest turn of each hand a saved record holds a state of. */
function latestTurns(rec: SerializedClient | null): Map<number, number> {
  const out = new Map<number, number>();
  const plays = (rec as unknown as { plays?: Array<{ hand: number; seen?: Array<{ tc?: number }> }> } | null)?.plays ?? [];
  for (const p of plays) for (const s of p.seen ?? []) if (typeof s.tc === 'number') out.set(p.hand, Math.max(out.get(p.hand) ?? -1, s.tc));
  return out;
}

export function shownBy(c: TableClient): Shown {
  const st = c.state as TableClient['state'] & { matchFailed?: boolean };
  const audits = new Map<number, Verdict>();
  for (const a of st.audits ?? []) audits.set(a.audit.handNumber, { status: a.status, failures: [...a.failures], caveats: [...a.caveats] });
  // A build before the failed-match flag shows a match failed by a red hand in its list.
  const matchFailed = typeof st.matchFailed === 'boolean' ? st.matchFailed : [...audits.values()].some((v) => v.status === 'failed');
  return { audits, matchOver: st.matchOver, matchEndVerified: st.matchEndVerified, matchFailed, matchId: st.matchId };
}

export class Truth {
  sim!: Sim;
  /** Who is making the host apply a move right now (a message from a phone). */
  origin: { kind: 'victim' | 'other'; line: Line; m: ClientMessage } | null = null;
  readonly runs: RunInfo[] = [];
  readonly lines = new Map<number, LineInfo>();
  readonly decisions = new Map<string, DecisionInfo>();
  readonly log: LogMove[] = [];
  readonly sent: SentMove[] = [];
  /** Every refusal of a move (`illegal`, `not_playing`, `wrong_seat`) that reached the phone: its line, the turn it names, when. */
  readonly refusalsSeen: Array<{ line: number; turn: number | null; at: number }> = [];
  readonly dropped: DroppedMove[] = [];
  readonly intents: Intent[] = [];
  readonly notices: Notice[] = [];
  readonly doctored: Array<{ run: number; line: number; hand: number; tc: number; at: number }> = [];
  readonly repicks: Array<{ hand: number; at: number }> = [];
  readonly appStops: Array<{ appRun: number; at: number; startAt: number | null }> = [];
  readonly kicks: Array<{ run: number; at: number; endAt: number | null; falseNotice: boolean }> = [];
  readonly stoodIn = new Set<number>();
  /** Hands a run of the phone showed red, at any moment (and when it first did). */
  readonly redSeen = new Map<number, string[]>();
  readonly redSeenAt = new Map<number, number>();
  /** When each hand's result first reached the phone, and when the host dealt each hand. */
  readonly resultsReached = new Map<number, number>();
  readonly dealtAt = new Map<number, number>();
  /** Every state the host sent the phone, and every one that reached it, by hand and turn. */
  readonly statesSent = new Map<string, Array<{ line: number; at: number }>>();
  readonly statesReached = new Map<string, Array<{ line: number; run: number; at: number }>>();
  readonly crashes: string[] = [];
  /** The events of the scenario as they began and ended. */
  readonly timeline: string[] = [];
  /** The last record the app saved. */
  savedRecord: SerializedClient | null = null;
  savedAt: number | null = null;
  readonly restoredNotices: Array<{ run: number; at: number; hand: number; tc: number; line: number }> = [];
  /** When the host's match ended (a client started after it is a new visit to the room, not the player's table). */
  matchOverAt: number | null = null;
  /** The server made a deal frame or the record of a hand go to another match (a new match id). */
  otherMatch = false;
  goneRoutes: string[] = [];
  freshPhones = 0;
  otherDeviceActive = false;
  readonly otherDeviceSpans: Array<{ from: number; to: number | null }> = [];
  private eraStart = 0;
  /** The refusal each error frame of the server's making carries. */
  private readonly refusalFrames = new WeakMap<object, DroppedMove['refusals'][number]>();
  /** When the app wrote the table's record to its slot. */
  readonly saveTimes: number[] = [];
  private lastApp: object | null = null;
  /** Whether the client of the run about to start was given what the app's journal held (`journalGiven`). */
  private journalPending = false;
  private sentTotal = 0;
  private droppedId = 0;
  private decisionNow: DecisionInfo | null = null;

  attach(sim: Sim): void {
    this.sim = sim;
  }
  private get now(): number {
    return this.sim.clock.now;
  }
  private get phone(): Phone {
    return this.sim.phone;
  }
  private runInfo(run: number): RunInfo | undefined {
    return this.runs.find((r) => r.run === run);
  }
  note(text: string): void {
    this.timeline.push(`${((this.now - 2_000_000) / 1000).toFixed(1)}s ${text}`);
  }

  // --------------------------------------------------------------- the phone's runs and lines

  runStarted(p: Phone, how: string): void {
    const rec = how === 'restore' ? (p.app.slot?.client ?? null) : how === 'archive' ? null : null;
    const newDevice = this.lastApp !== null && this.lastApp !== p.app;
    this.lastApp = p.app;
    this.runs.push({ run: p.run, appRun: p.appRun, how, createdAt: this.now, endedAt: null, recordLatest: latestTurns(rec), firstShown: new Map(), welcomedAt: null, recordAge: how === 'restore' && p.app.slot ? p.app.now() - p.app.slot.savedAt : null, newDevice, shown: null, journal: this.journalPending, tookUpAtWelcome: null, elsewhereAt: null, recordAt: how === 'restore' ? p.app.slotAt : null });
    this.journalPending = false;
    this.note(`client run ${p.run} (${how})`);
  }
  /** The client about to start is given what the app's journal holds for its match (or nothing). */
  journalGiven(given: boolean): void {
    this.journalPending = given;
  }
  /** A run that joined holding no record took one up at its first welcome (`moved`: kept under another room). */
  tookUpAtWelcome(run: number, moved: boolean, rec: SerializedClient): void {
    const r = this.runInfo(run);
    if (r) {
      r.tookUpAtWelcome = { moved };
      r.recordLatest = latestTurns(rec);
    }
    this.note(`client run ${run} took up a kept record of the match at its welcome${moved ? ' (kept under another room)' : ''}`);
  }
  runEnded(_p: Phone, c: TableClient): void {
    const r = this.runs[this.runs.length - 1];
    if (!r || r.endedAt !== null) return;
    r.endedAt = this.now;
    r.shown = shownBy(c);
    this.sampleRed(r.shown);
  }
  appStopped(p: Phone): void {
    this.appStops.push({ appRun: p.appRun, at: this.now, startAt: null });
    this.note('app stopped');
  }
  appStarted(p: Phone): void {
    const s = this.appStops[this.appStops.length - 1];
    if (s && s.startAt === null) s.startAt = this.now;
    this.note(`app started (process ${p.appRun})`);
  }
  saved(_p: Phone, rec: SerializedClient | null): void {
    this.savedRecord = rec;
    this.savedAt = this.now;
    if (rec) this.saveTimes.push(this.now);
  }
  lineOpened(l: Line): void {
    this.lines.set(l.n, { n: l.n, run: l.run, openedAt: this.now, closedAt: null, welcomedAt: null, brought: new Set(), statesOf: new Set(), firstStateAt: new Map(), committed: new Set(), revealed: new Set(), pongs: [], evictedAt: null, evictFalse: false, frameAfterEvict: false });
  }
  lineClosed(l: Line): void {
    const li = this.lines.get(l.n);
    if (li && li.closedAt === null) li.closedAt = this.now;
  }
  serverRestarted(): void {
    this.eraStart = this.now;
    this.note('server restarted');
  }
  otherDevice(active: boolean): void {
    this.otherDeviceActive = active;
    if (active) this.otherDeviceSpans.push({ from: this.now, to: null });
    else {
      const s = this.otherDeviceSpans[this.otherDeviceSpans.length - 1];
      if (s && s.to === null) s.to = this.now;
    }
  }
  crash(msg: string): void {
    if (this.crashes.length < 5) this.crashes.push(msg);
  }

  // --------------------------------------------------------------- frames

  hostSent(l: Line, m: HostMessage): void {
    if (m.t !== 'state') return;
    const key = `${m.view.handNumber}:${m.view.turnCounter}`;
    if (!this.dealtAt.has(m.view.handNumber)) this.dealtAt.set(m.view.handNumber, this.now);
    // The host sends a turn's state as it reaches the turn, before the step that notes the decision.
    this.statesSent.set(key, [...(this.statesSent.get(key) ?? []), { line: l.n, at: this.now }]);
    const d = this.decisions.get(key);
    if (d && d.playedAt === null) d.sentOn.push({ line: l.n, at: this.now });
  }
  delivered(l: Line, m: HostMessage): void {
    const li = this.lines.get(l.n);
    const run = this.runInfo(l.run);
    if (!li) return;
    const h = handOf(m);
    if (li.evictedAt !== null && GAME_FRAMES.has(m.t)) li.frameAfterEvict = true;
    if (m.t === 'error' && m.code === 'evicted') li.evictedAt ??= this.now;
    if (m.t === 'welcome') {
      li.welcomedAt ??= this.now;
      if (run) run.welcomedAt ??= this.now;
      if (run && m.elsewhere === true) run.elsewhereAt ??= this.now;
      this.note(`client run ${l.run} welcomed on link ${l.n}${m.elsewhere === true ? ' (another device held the seat)' : ''}`);
    }
    // The stretch a seat-taken notice opens lasts until the phone is shown the hand again (docs/FAIRNESS.md: "from the
    // latest turn your phone was shown until your phone is shown the hand again"), on a later run of its client.
    if (m.t === 'state') for (const k of this.kicks) if (k.endAt === null && k.run < l.run) k.endAt = this.now;
    if (m.t === 'pong') li.pongs.push({ at: this.now, sentAt: this.sim.hostSentAt(m) ?? this.now });
    if (m.t === 'error' && (m.code === 'illegal' || m.code === 'not_playing' || m.code === 'wrong_seat')) this.refusalsSeen.push({ line: l.n, turn: typeof m.turnCounter === 'number' ? m.turnCounter : null, at: this.now });
    const refusal = this.refusalFrames.get(m);
    if (refusal && refusal.reachedAt === null) {
      refusal.reachedAt = this.now;
      refusal.run = l.run;
    }
    if (h !== null && m.t !== 'hand_missed') li.brought.add(h);
    if (m.t === 'state') {
      const hand = m.view.handNumber;
      li.statesOf.add(hand);
      if (!li.firstStateAt.has(hand)) li.firstStateAt.set(hand, this.now);
      if (run && !run.firstShown.has(hand)) run.firstShown.set(hand, this.now);
      const key = `${hand}:${m.view.turnCounter}`;
      this.statesReached.set(key, [...(this.statesReached.get(key) ?? []), { line: l.n, run: l.run, at: this.now }]);
      const d = this.decisions.get(key);
      if (d) d.reached.push({ line: l.n, run: l.run, at: this.now });
    }
    if (m.t === 'stand_in') this.stoodIn.add(m.handNumber);
    if ((m.t === 'hand_over' || m.t === 'hand_missed') && h !== null && !this.resultsReached.has(h)) this.resultsReached.set(h, this.now);
    if (m.t === 'restored') this.restoredNotices.push({ run: l.run, at: this.now, hand: m.handNumber, tc: m.turnCounter, line: l.n });
  }
  /** After the client took `m`: the notices it took, and what it shows. */
  afterDelivered(l: Line, m: HostMessage, c: TableClient): void {
    // A changed view the client took and put on the screen (one it refused, or took nothing from that link for, was not shown).
    if (m.t === 'state' && this.sim.adversaryDoctored(m) && c.state.view && JSON.stringify(c.state.view) === JSON.stringify(m.view)) this.doctored.push({ run: l.run, line: l.n, hand: m.view.handNumber, tc: m.view.turnCounter, at: this.now });
    if (c.state.kicked && !this.kicks.some((k) => k.run === l.run)) {
      const n = [...this.notices].reverse().find((x) => (x.kind === 'seatTaken' || x.kind === 'elsewhere') && x.run === l.run);
      this.kicks.push({ run: l.run, at: this.now, endAt: null, falseNotice: n ? n.falseNotice : !this.otherDeviceActive });
      this.note(`client run ${l.run} took the seat-taken notice`);
    }
    if (m.t === 'hand_over' || m.t === 'hand_missed' || m.t === 'match_over') this.sampleRed(shownBy(c));
  }
  private sampleRed(s: Shown): void {
    for (const [h, v] of s.audits) {
      if (v.status !== 'failed' || this.redSeen.has(h)) continue;
      this.redSeen.set(h, v.failures.map((f) => net.failureKey(f) ?? f));
      this.redSeenAt.set(h, this.now);
    }
  }
  clientSent(l: Line, m: ClientMessage): void {
    const li = this.lines.get(l.n);
    const v = this.phone.client?.state.view ?? null;
    if (m.t === 'action') {
      this.sentTotal++;
      this.sent.push({ run: l.run, line: l.n, hand: v ? v.handNumber : null, tc: typeof m.turnCounter === 'number' ? m.turnCounter : null, action: m.action, at: this.now });
    }
    const ceremonyHand = this.sim.hostInside().snapshot.handNumber;
    if (li && m.t === 'commit') li.committed.add(ceremonyHand);
    if (li && m.t === 'reveal') li.revealed.add(ceremonyHand);
  }
  sentCount(): number {
    return this.sentTotal;
  }
  /** The server kept a message of the phone's from the table. */
  droppedUp(l: Line, m: ClientMessage): void {
    if (m.t !== 'action') return;
    const g = this.sim.host.game;
    let legal = false;
    try {
      legal = !!g && this.sim.hostInside().phase === 'playing' && engine.isLegal(g, 0, m.action);
    } catch {
      legal = false;
    }
    const d = this.decisionNow;
    this.dropped.push({ id: ++this.droppedId, run: l.run, line: l.n, at: this.now, hand: g?.handNumber ?? -1, hostTc: g?.turnCounter ?? -1, msgTc: typeof m.turnCounter === 'number' ? m.turnCounter : null, action: m.action, legal, leftMs: d && g && d.hand === g.handNumber && d.tc === g.turnCounter ? d.deadline - this.now : 0, refusals: [], replacedBy: null, lineBroke: false });
  }
  lastDropped(): DroppedMove | null {
    return this.dropped[this.dropped.length - 1] ?? null;
  }
  /** The server answered a dropped move with a refusal. */
  refusal(d: DroppedMove, code: string, turn: number | null, afterState: boolean, m: HostMessage): void {
    const g = this.sim.host.game;
    let legalNow = false;
    try {
      legalNow = !!g && g.handNumber === d.hand && engine.isLegal(g, 0, d.action);
    } catch {
      legalNow = false;
    }
    const r = { at: this.now, code, turn, legalNow, afterState, reachedAt: null as number | null, run: null as number | null };
    d.refusals.push(r);
    this.refusalFrames.set(m, r);
  }
  notice(kind: Notice['kind'], l: Line | null, falseNotice: boolean, hand: number | null = null): void {
    this.notices.push({ kind, at: this.now, line: l ? l.n : null, run: l ? l.run : this.phone.run, falseNotice, hand });
    // An eviction counts from when its notice reaches the phone (`delivered`).
    if (kind === 'evicted' && l) {
      const li = this.lines.get(l.n);
      if (li) li.evictFalse = falseNotice;
    }
  }
  repicked(hand: number): void {
    this.repicks.push({ hand, at: this.now });
  }
  intent(p: Phone, s: GameState, a: Action, sent: boolean): void {
    const li = p.line ? this.lines.get(p.line.n) : undefined;
    this.intents.push({ run: p.run, hand: s.handNumber, tc: s.turnCounter, action: a, at: this.now, sent, kicked: !!p.client?.state.kicked, evicted: !!li && li.evictedAt !== null && !li.frameAfterEvict });
  }

  // --------------------------------------------------------------- the host's log

  decision(g: GameState, kind: StateKind, deadline: number): void {
    const key = `${g.handNumber}:${g.turnCounter}`;
    if (this.decisions.has(key)) {
      this.decisionNow = this.decisions.get(key)!;
      return;
    }
    const d: DecisionInfo = { key, hand: g.handNumber, tc: g.turnCounter, kind, startedAt: this.now, deadline, sentOn: [...(this.statesSent.get(key) ?? [])], reached: [...(this.statesReached.get(key) ?? [])], playedAt: null, playedBy: null };
    this.decisions.set(key, d);
    this.decisionNow = d;
  }
  currentDecision(): DecisionInfo | null {
    const g = this.sim.host.game;
    const d = this.decisionNow;
    return d && g && d.hand === g.handNumber && d.tc === g.turnCounter && d.playedAt === null ? d : null;
  }
  /** Before the host applies a move: a dropped move of the phone's still legal here is being replaced by this one. */
  beforeApply(seat: number, a: Action, before: GameState | null): void {
    if (seat !== 0 || !before || this.origin?.kind !== 'victim') return;
    const line = this.origin.line.n;
    for (const d of this.dropped) {
      if (!d.legal || d.replacedBy || d.line !== line || d.hand !== before.handNumber || d.lineBroke) continue;
      // The seat's decision the lost move was for was settled since (the table played for it, say): nothing is pending.
      if (this.log.some((x) => x.hand === d.hand && x.at >= d.at && x.n >= d.hostTc)) continue;
      let still = false;
      try {
        still = engine.isLegal(before, 0, d.action) && !engine.sameAction(d.action, a, before, 0);
      } catch {
        still = false;
      }
      if (still) (d as DroppedMove & { pendingReplace?: boolean }).pendingReplace = true;
    }
  }
  applied(seat: number, a: Action, source: string, origin: Truth['origin'], forging: 'player' | 'auto' | null, before: GameState | null, after: GameState | null): void {
    if (seat !== 0 || !before || !after) return;
    const entry = after.actionLog[after.actionLog.length - 1];
    const kind: LogMove['origin'] = forging ? 'forged' : origin ? (origin.kind === 'victim' ? 'victim' : 'other') : 'table';
    const p = this.phone;
    const li = p.line ? this.lines.get(p.line.n) : undefined;
    const run = this.runInfo(p.run);
    const d = this.decisions.get(`${before.handNumber}:${before.turnCounter}`) ?? null;
    const rule = this.sim.timeoutMove(before);
    // A fixed point between the two clocks: an answer to a ping reached this run of the client in this run of the server.
    const since = Math.max(run?.createdAt ?? 0, this.eraStart);
    const fixedPoint = [...this.lines.values()].some((x) => x.run === p.run && x.pongs.some((t) => t.at >= since));
    const ctx: MoveContext = {
      run: p.run,
      appRun: p.appRun,
      appRunning: p.running,
      hasClient: !!p.client,
      line: p.line ? p.line.n : null,
      lineOpen: !!p.line && p.line.open,
      kicked: this.kicks.some((k) => k.endAt === null),
      evicted: !!li && li.evictedAt !== null && !li.frameAfterEvict,
      shownHand: this.runs.some((r) => r.firstShown.has(before.handNumber)),
      shownThisRun: !!run && run.firstShown.has(before.handNumber),
      stoodIn: this.stoodIn.has(before.handNumber),
      fixedPoint,
      isRuleMove: !!rule && engine.sameAction(rule, a, before, 0),
      earlyBy: d ? d.deadline - this.now : 0,
      restoredNotice: !!d && this.restoredNotices.some((r) => r.at >= d.startedAt && r.hand === before.handNumber),
      runChanged: !!d && this.runs.some((r) => r.createdAt > d.startedAt),
    };
    const lm: LogMove = { hand: before.handNumber, n: entry?.n ?? before.turnCounter, action: a, source: source === 'player' ? 'player' : 'auto', origin: kind, at: this.now, line: origin ? origin.line.n : null, msgTc: origin && origin.m.t === 'action' && typeof origin.m.turnCounter === 'number' ? origin.m.turnCounter : null, decision: d, ctx };
    this.log.push(lm);
    if (d && d.playedAt === null) {
      d.playedAt = this.now;
      d.playedBy = lm;
    }
    for (const x of this.dropped as Array<DroppedMove & { pendingReplace?: boolean }>) {
      if (x.pendingReplace) {
        x.pendingReplace = false;
        if (kind === 'victim') x.replacedBy = lm;
      }
    }
  }

  // --------------------------------------------------------------- the end

  step(): void {
    // A line that broke while a dropped move of its own was still open.
    for (const d of this.dropped) {
      if (d.lineBroke) continue;
      const li = this.lines.get(d.line);
      if (li && li.closedAt !== null) {
        const dec = this.decisions.get(`${d.hand}:${d.hostTc}`);
        if (!dec || dec.playedAt === null || dec.playedAt > li.closedAt) d.lineBroke = true;
      }
    }
  }
  finish(sim: Sim): void {
    const c = sim.phone.client;
    if (c) this.runEnded(sim.phone, c);
  }
}
