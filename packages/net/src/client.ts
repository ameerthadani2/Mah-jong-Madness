/**
 * Table client: joins a host, takes part in the seed ceremony, sends actions,
 * keeps the latest seat view, and verifies every hand's audit.
 *
 * The client never takes the host's word for how the ceremony went: it records
 * what it saw itself (which hands it was asked to commit to, how many attempts,
 * whether it was stood in, whether the commitments arrived before it revealed)
 * and checks the audit against that record.
 */
import { hashState, replayHand, sanitizeRules, stableStringify, viewToState, WALL_RNG_VERSION, type Action, type GameState, type HandResult, type MatchSnapshot, type RuleSet, type TableView } from '@mjm/engine';
import { commitFor, deriveSeed, makeSecret, verifyReveals, type Commitment } from './fairness';
import type { Link } from './host';
import { RESTART_CAUSES, type Audit, type ClientMessage, type HostMessage, type SeatInfo } from './messages';
import type { Transport, Unsubscribe } from './transport';

/**
 * `ok`: this seat's own share protected the seed and every check passed.
 * `partial`: every check on the log and the published shares passed, but this seat's share did not
 * protect the seed (the host stood in for it, or the seat joined mid-hand).
 * `failed`: a check failed or the host misbehaved during the hand.
 */
export type AuditStatus = 'ok' | 'partial' | 'failed' | 'unverified';

export interface AuditCheck {
  status: AuditStatus;
  failures: string[];
  caveats: string[];
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
  /** Rejoin token from the host; persist it to resume after a crash. */
  token: string | null;
  /** Remaining time bank (seconds) and whether the clock is currently eating into it. */
  timeBank: number;
  inTimeBank: boolean;
  /** Every audited hand this session, newest last. */
  audits: Array<{ audit: Audit; status: AuditStatus; failures: string[]; caveats: string[] }>;
  chat: ChatLine[];
  emotes: Array<{ seat: number; emote: string; at: number }>;
  lastError: string | null;
  rttMs: number | null;
  /** The host used a stand-in random share for us this hand (we committed too late). */
  standIn: boolean;
  /** The link to the host was lost; resume from Home with the saved token. */
  disconnected: boolean;
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
  if (!Array.isArray(c) || c.length !== 5) return false;
  const seats = new Set<number>();
  for (const x of c) {
    if (!isObject(x) || !isInt(x.seat) || x.seat < 0 || x.seat > 4 || typeof x.hash !== 'string' || !HEX64.test(x.hash)) return false;
    seats.add(x.seat);
  }
  return seats.size === 5;
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
    token: null,
    timeBank: 0,
    inTimeBank: false,
    audits: [],
    chat: [],
    emotes: [],
    lastError: null,
    rttMs: null,
    standIn: false,
    disconnected: false,
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
  /** We joined with a rejoin token, so we may have missed earlier attempts of the first hand we see. */
  private rejoined = false;
  /** Hands whose `hand_over` we received. */
  private readonly handsEnded = new Set<number>();
  /** `commit_request`s received per hand. */
  private readonly attemptsSeen = new Map<number, number>();
  /** Most human seats at the table during each hand's ceremony. */
  private readonly humansAt = new Map<number, number>();
  /** Host misbehaviour seen during each hand. */
  private readonly tamper = new Map<number, string[]>();
  /** Match snapshot at the start of the current hand, needed to replay the audit. */
  private handStart: MatchSnapshot | null = null;
  private readonly listeners = new Set<(s: ClientState) => void>();
  private readonly unsub: Unsubscribe;

  constructor(
    private readonly link: Link,
    private readonly name: string,
    private readonly avatar?: string,
    private readonly identity: { token?: string; userId?: string } = {},
  ) {
    this.unsub = link.onMessage((m) => {
      try {
        this.onMessage(m);
      } catch (e) {
        this.update({ lastError: `Ignored a malformed message from the table (${(e as Error).message}).` });
      }
    });
    link.onClose?.(() => this.update({ connected: false, disconnected: true, lastError: 'Connection to the table was lost.' }));
    if (identity.token) this.state = { ...this.state, token: identity.token };
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
    if (token) this.rejoined = true;
    this.send({ t: 'join', name: this.name, avatar: this.avatar, wantSeat, token, userId: this.identity.userId });
  }

  act(action: Action): void {
    if (this.state.seat === null) return;
    this.send({ t: 'action', seat: this.state.seat, action, expectHash: this.state.stateHash ?? undefined });
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
    this.send({ t: 'ping', at: Date.now() });
  }

  leave(): void {
    this.send({ t: 'leave' });
    this.unsub();
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
  }

  /** The first state of a hand we were never asked to commit to: we arrived after its deal. */
  private noteHand(hand: number): void {
    if (this.firstHand !== null) return;
    this.firstHand = hand;
    if (this.commitHand !== hand) this.joinedHand = hand;
  }

  private onMessage(m: HostMessage): void {
    if (!isObject(m) || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'welcome':
        this.update({ connected: true, seat: m.seat, roomCode: m.roomCode, rules: sanitizeRules(m.rules), seats: Array.isArray(m.seats) ? m.seats : [], matchId: m.matchId, token: m.token, lastError: null });
        return;
      case 'lobby':
        if (Array.isArray(m.seats)) this.update({ seats: m.seats });
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
        if (this.firstHand === null) this.firstHand = h;
        this.attemptsSeen.set(h, (this.attemptsSeen.get(h) ?? 0) + 1);
        this.humansAt.set(h, Math.max(this.humansAt.get(h) ?? 0, this.state.seats.filter((s) => !s.isBot).length));
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
      case 'stand_in':
        // Only meaningful while this attempt's commitments are still being collected. Our secret is
        // kept: the audit must still show it was not used.
        if (m.handNumber !== this.commitHand || this.state.ceremony !== 'committed') return;
        this.standInHand = m.handNumber;
        this.update({ standIn: true });
        return;
      case 'disconnected':
        this.update({ connected: false, disconnected: true, lastError: 'This seat was opened on another device.' });
        return;
      case 'commits': {
        if (!isInt(m.handNumber)) return;
        const h = m.handNumber;
        if (!isCommitSet(m.commits)) {
          this.flag(h, 'Host published a malformed set of commitments');
          this.update({ lastError: 'The table sent a malformed set of commitments.' });
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
        this.send({ t: 'reveal', secret: this.secret });
        this.update({ ceremony: 'revealed' });
        return;
      }
      case 'state': {
        if (!isView(m.view)) {
          this.update({ lastError: 'The table sent a malformed state.' });
          return;
        }
        this.noteHand(m.view.handNumber);
        const first = !this.state.view || this.state.view.handNumber !== m.view.handNumber || this.state.lastResult !== null;
        if (first || !this.handStart) this.handStart = snapshotFromView(m.view);
        this.update({ view: m.view, stateHash: m.hash, deadline: m.deadline, timeBank: m.timeBank, inTimeBank: m.inTimeBank, lastResult: null, lastError: null, ceremony: 'idle' });
        return;
      }
      case 'hand_over': {
        if (!isView(m.view) || !isAudit(m.audit) || !isObject(m.result)) {
          this.update({ lastError: 'The table sent a malformed hand result.' });
          return;
        }
        this.noteHand(m.audit.handNumber);
        this.handsEnded.add(m.audit.handNumber);
        const { status, failures, caveats } = this.verifyAudit(m.audit, m.view, m.result);
        const audits = this.state.audits.some((a) => a.audit.handNumber === m.audit.handNumber && a.audit.matchId === m.audit.matchId)
          ? this.state.audits
          : [...this.state.audits, { audit: m.audit, status, failures, caveats }];
        this.update({ view: m.view, lastResult: m.result, lastAudit: m.audit, auditStatus: status, auditFailures: failures, auditCaveats: caveats, deadline: null, audits });
        return;
      }
      case 'match_over':
        if (!isView(m.view) || !Array.isArray(m.scores)) {
          this.update({ lastError: 'The table sent a malformed match result.' });
          return;
        }
        this.update({ view: m.view, matchOver: true, finalScores: m.scores, deadline: null });
        return;
      case 'chat':
        if (typeof m.text !== 'string') return;
        this.update({ chat: [...this.state.chat.slice(-99), { seat: m.seat, name: m.name, text: m.text, at: Date.now() }] });
        return;
      case 'emote':
        if (typeof m.emote !== 'string') return;
        this.update({ emotes: [...this.state.emotes.slice(-20), { seat: m.seat, emote: m.emote, at: Date.now() }] });
        return;
      case 'error':
        this.update({ lastError: typeof m.message === 'string' ? m.message : 'The table reported an error.' });
        return;
      case 'pong':
        if (typeof m.at === 'number') this.update({ rttMs: Date.now() - m.at });
        return;
      default:
        return;
    }
  }

  /**
   * Verify a hand audit against what this client saw: misbehaviour recorded during the hand, whether
   * we took part in the deal, our own share, the commitments we were shown, the reveals, the seed,
   * a replay of the log, and the ceremony accounting.
   */
  verifyAudit(audit: Audit, finalView: TableView, announced?: HandResult): AuditCheck {
    const failures: string[] = [];
    const caveats: string[] = [];
    if (!this.state.rules || !this.state.matchId) return { status: 'unverified', failures: ['No match context'], caveats };
    if (!isAudit(audit) || !isView(finalView)) return { status: 'failed', failures: ['The audit is malformed'], caveats };
    const h = audit.handNumber;
    const me = this.state.seat;

    // 1. Anything the host did wrong while the hand was under way.
    failures.push(...(this.tamper.get(h) ?? []));

    // 2. Participation.
    const tookPart = this.commitHand === h;
    const stoodIn = this.standInHand === h;
    const joined = !tookPart && this.joinedHand === h;
    if (joined) caveats.push('Joined during this hand; log verified, share not used');
    else if (!tookPart) failures.push('Host never asked this seat to commit');

    // 3. Our own share.
    if (tookPart && stoodIn) caveats.push("The host supplied this seat's share");
    else if (tookPart && this.secret) {
      const mine = audit.commits.find((c) => c.seat === me);
      if (!mine || mine.hash !== commitFor(this.secret)) failures.push('Host altered my commitment');
      const myReveal = audit.reveals.find((r) => r.seat === me);
      if (!myReveal || myReveal.secret !== this.secret) failures.push('Host altered my secret');
    }

    // 4. The commitments we were shown before revealing.
    if (this.commits && this.commitsHand === h) {
      for (const c of this.commits) {
        const a = audit.commits.find((x) => x.seat === c.seat);
        if (!a || a.hash !== c.hash) failures.push(`Commitment for seat ${c.seat} changed after the fact`);
      }
    } else if (tookPart) failures.push('The commitments for this hand never arrived');

    // 5. Reveals, seed and replay.
    const rv = verifyReveals(audit.commits, audit.reveals);
    if (!rv.ok) failures.push(`Reveals do not match commitments for seats ${rv.badSeats.join(', ')}`);
    if (audit.commits.length !== 5 || !audit.commits.some((c) => c.seat === 4)) failures.push('Audit is missing a contributor share');
    if (audit.rngVersion !== WALL_RNG_VERSION) failures.push(`Unknown shuffle construction ${audit.rngVersion}`);
    const seed = deriveSeed(`${this.state.matchId}:${h}`, audit.reveals);
    if (seed !== audit.seed) failures.push('Seed was not derived from the revealed secrets');
    const start = this.handStart && this.handStart.handNumber === h ? this.handStart : snapshotFromView(finalView, true);
    try {
      const replayed = replayHand(start, audit.seed, this.state.rules, audit.log);
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

    // 6. Ceremony accounting: restarts must be the ones an honest table could produce.
    failures.push(...this.checkAccounting(audit));

    const status: AuditStatus = failures.length > 0 ? 'failed' : caveats.length > 0 ? 'partial' : 'ok';
    return { status, failures, caveats };
  }

  private checkAccounting(audit: Audit): string[] {
    const failures: string[] = [];
    const h = audit.handNumber;
    const attempts = audit.ceremonyAttempts;
    const restarts = Array.isArray(audit.restarts) ? audit.restarts : null;
    if (!isInt(attempts) || attempts < 1) return ['Audit does not say how many ceremonies were run'];
    if (!restarts) return ['Audit does not list the ceremony restarts'];
    if (restarts.length !== attempts - 1) failures.push(`Audit lists ${restarts.length} restarts for ${attempts} ceremony attempts`);
    const humans = this.humansAt.get(h) ?? this.state.seats.filter((s) => !s.isBot).length;
    if (attempts > 1 + humans) failures.push(`${attempts} ceremony attempts is more than ${1 + humans}, the most an honest table with ${humans} human seats needs`);
    restarts.forEach((r, i) => {
      if (!isObject(r) || r.attempt !== i + 1 || !Array.isArray(r.seats) || !RESTART_CAUSES.includes(r.cause)) {
        failures.push(`Restart ${i + 1} is malformed`);
        return;
      }
      for (const s of r.seats) {
        if (!isInt(s) || s < 0 || s > 3) failures.push(`Restart ${i + 1} names seat ${String(s)}, which is not a player seat`);
        else if (this.state.seats[s]?.isBot) failures.push(`Restart ${i + 1} blames seat ${s + 1}, which is a bot`);
      }
    });
    const seen = this.attemptsSeen.get(h) ?? 0;
    // Without a rejoin we saw every attempt; after one we may have missed earlier attempts of the first hand.
    const sawFirstAttempt = !this.rejoined || this.handsEnded.has(h - 1);
    if (sawFirstAttempt && seen > 0 && attempts !== seen) failures.push(`Audit reports ${attempts} ceremony attempts but this seat was asked to commit ${seen} times`);
    else if (attempts < seen) failures.push(`Audit reports ${attempts} ceremony attempts but this seat was asked to commit ${seen} times`);
    return failures;
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
