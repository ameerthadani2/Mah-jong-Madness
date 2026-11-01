/**
 * Table client: joins a host, takes part in the seed ceremony, sends actions,
 * keeps the latest seat view, and verifies every hand's audit.
 */
import { hashState, replayHand, stableStringify, viewToState, type Action, type GameState, type HandResult, type MatchSnapshot, type RuleSet, type TableView } from '@mjm/engine';
import { commitFor, deriveSeed, makeSecret, verifyReveals, type Commitment } from './fairness';
import type { Link } from './host';
import type { Audit, ClientMessage, HostMessage, SeatInfo } from './messages';
import type { Transport, Unsubscribe } from './transport';

export type AuditStatus = 'ok' | 'failed' | 'unverified';

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
  matchOver: boolean;
  finalScores: number[] | null;
  /** Rejoin token from the host; persist it to resume after a crash. */
  token: string | null;
  /** Remaining time bank (seconds) and whether the clock is currently eating into it. */
  timeBank: number;
  inTimeBank: boolean;
  /** Every audited hand this session, newest last. */
  audits: Array<{ audit: Audit; status: AuditStatus; failures: string[] }>;
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
  };
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
    this.unsub = link.onMessage((m) => this.onMessage(m));
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
    this.send({ t: 'join', name: this.name, avatar: this.avatar, wantSeat, token: this.state.token ?? this.identity.token, userId: this.identity.userId });
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

  private onMessage(m: HostMessage): void {
    switch (m.t) {
      case 'welcome':
        this.update({ connected: true, seat: m.seat, roomCode: m.roomCode, rules: m.rules, seats: m.seats, matchId: m.matchId, token: m.token, lastError: null });
        return;
      case 'lobby':
        this.update({ seats: m.seats });
        return;
      case 'commit_request':
        this.secret = makeSecret();
        this.commits = null;
        this.send({ t: 'commit', hash: commitFor(this.secret) });
        this.update({ ceremony: 'committed', standIn: false });
        return;
      case 'stand_in':
        // Our own share was replaced; the audit will still verify every other property.
        this.secret = null;
        this.update({ standIn: true });
        return;
      case 'disconnected':
        this.update({ connected: false, disconnected: true, lastError: 'This seat was opened on another device.' });
        return;
      case 'commits':
        this.commits = m.commits;
        return;
      case 'reveal_request':
        if (this.secret) this.send({ t: 'reveal', secret: this.secret });
        this.update({ ceremony: 'revealed' });
        return;
      case 'state': {
        const first = !this.state.view || this.state.view.handNumber !== m.view.handNumber || this.state.lastResult !== null;
        if (first || !this.handStart) this.handStart = snapshotFromView(m.view);
        this.update({ view: m.view, stateHash: m.hash, deadline: m.deadline, timeBank: m.timeBank, inTimeBank: m.inTimeBank, lastResult: null, lastError: null, ceremony: 'idle' });
        return;
      }
      case 'hand_over': {
        const { status, failures } = this.verifyAudit(m.audit, m.view, m.result);
        const audits = this.state.audits.some((a) => a.audit.handNumber === m.audit.handNumber && a.audit.matchId === m.audit.matchId)
          ? this.state.audits
          : [...this.state.audits, { audit: m.audit, status, failures }];
        this.update({ view: m.view, lastResult: m.result, lastAudit: m.audit, auditStatus: status, auditFailures: failures, deadline: null, audits });
        return;
      }
      case 'match_over':
        this.update({ view: m.view, matchOver: true, finalScores: m.scores, deadline: null });
        return;
      case 'chat':
        this.update({ chat: [...this.state.chat.slice(-99), { seat: m.seat, name: m.name, text: m.text, at: Date.now() }] });
        return;
      case 'emote':
        this.update({ emotes: [...this.state.emotes.slice(-20), { seat: m.seat, emote: m.emote, at: Date.now() }] });
        return;
      case 'error':
        this.update({ lastError: m.message });
        return;
      case 'pong':
        this.update({ rttMs: Date.now() - m.at });
        return;
      default:
        return;
    }
  }

  /**
   * Verify a hand audit: our own commitment is present and unchanged, every
   * reveal matches its commitment, the seed derives from the reveals, and
   * replaying the log reproduces the host's final state hash.
   */
  verifyAudit(audit: Audit, finalView: TableView, announced?: HandResult): { status: AuditStatus; failures: string[] } {
    const failures: string[] = [];
    if (!this.state.rules || !this.state.matchId) return { status: 'unverified', failures: ['No match context'] };
    if (this.secret) {
      const mine = audit.commits.find((c) => c.seat === this.state.seat);
      if (!mine || mine.hash !== commitFor(this.secret)) failures.push('Host altered my commitment');
      const myReveal = audit.reveals.find((r) => r.seat === this.state.seat);
      if (!myReveal || myReveal.secret !== this.secret) failures.push('Host altered my secret');
    }
    if (this.commits) {
      for (const c of this.commits) {
        const a = audit.commits.find((x) => x.seat === c.seat);
        if (!a || a.hash !== c.hash) failures.push(`Commitment for seat ${c.seat} changed after the fact`);
      }
    }
    const rv = verifyReveals(audit.commits, audit.reveals);
    if (!rv.ok) failures.push(`Reveals do not match commitments for seats ${rv.badSeats.join(', ')}`);
    const seed = deriveSeed(`${this.state.matchId}:${audit.handNumber}`, audit.reveals);
    if (seed !== audit.seed) failures.push('Seed was not derived from the revealed secrets');
    const start = this.handStart && this.handStart.handNumber === audit.handNumber ? this.handStart : snapshotFromView(finalView, true);
    try {
      const replayed = replayHand(start, audit.seed, this.state.rules, audit.log);
      if (hashState(replayed) !== audit.finalHash) failures.push('Replaying the action log does not reproduce the final state');
      // The result and scores the host announced must be the ones the replay produces.
      if (announced && stableStringify(replayed.result) !== stableStringify(announced)) failures.push('Announced result differs from the replayed hand');
      if (replayed.scores.join(',') !== finalView.scores.join(',')) failures.push('Announced scores differ from the replayed hand');
      // The replayed state must agree with everything we were shown about our own seat.
      if (this.state.seat !== null && finalView.players[this.state.seat].hand) {
        const mine = replayed.players[this.state.seat].hand.slice().sort((a, b) => a - b).join(',');
        const shown = finalView.players[this.state.seat].hand!.slice().sort((a, b) => a - b).join(',');
        if (mine !== shown) failures.push('My final hand differs from the replay');
      }
    } catch (e) {
      failures.push(`Replay failed: ${(e as Error).message}`);
    }
    return { status: failures.length === 0 ? 'ok' : 'failed', failures };
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
