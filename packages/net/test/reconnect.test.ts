/**
 * Fairness on the reconnect path: one client per table across lost links and app restarts, the
 * honest host's rejoin behaviour, the status policy for restarted or interrupted deals, the log
 * bound to the player's own moves, the hand-0 anchor and the frozen bot set. Each modified host
 * below is a port of an assessment probe (X1, X2, X3, N1, N2, N3, N6).
 */
import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, hashState, kindOf, legalActions, newGame, replayHand, matchSnapshot, withRules, type Action, type GameState, type MatchSnapshot } from '@mjm/engine';
import { AUDIT_CAVEATS, LoopbackHub, MAX_AUDITS, TableClient, TableHost, transportLink, type Audit, type HostMessage, type Link, type SerializedClient } from '../src/index';

const RULES = withRules({ handsPerMatch: 1 });

interface SeatInternals {
  seat: number;
  secret?: string;
  commit?: string;
  isBot: boolean;
  connected: boolean;
  peerId: string | null;
  token?: string;
}
interface HostInternals {
  phase: string;
  game: GameState | null;
  snapshot: MatchSnapshot;
  seats: SeatInternals[];
  ceremonyBusy: boolean;
  ceremonyHand: number;
  audits: Audit[];
  checkCeremony: () => void;
  beginHand: (cause?: string, seats?: number[]) => void;
  restartCeremony: (late: SeatInternals[], cause: string) => void;
  apply: (seat: number, action: Action, source: 'player' | 'bot' | 'timeout') => void;
}
const internals = (host: TableHost) => host as unknown as HostInternals;

/** Bot moves wait in `queue` until the test runs them (so a hand does not finish while a player is away). */
function makeHost(hub: LoopbackHub, clock: { now: number }, code: string, rules = RULES, queue?: Array<() => void>) {
  return new TableHost(hub.create('host'), { roomCode: code, rules, now: () => clock.now, matchId: `m-${code}`, ...(queue ? { botDelayMs: 1, schedule: (fn: () => void) => void queue.push(fn) } : {}) });
}

/**
 * A link the test can cut (the client hears the close, the host sees the peer leave). `filter`
 * decides each outgoing message: true sends it, false loses it, 'hold' keeps it for `release()`.
 */
function droppable(hub: LoopbackHub, id: string, filter?: (msg: { t?: string }) => boolean | 'hold') {
  const t = hub.create(id);
  const held: Array<() => void> = [];
  if (filter) {
    const send = t.send.bind(t);
    t.send = (to: string, msg: unknown) => {
      const verdict = filter(msg as { t?: string });
      if (verdict === 'hold') held.push(() => send(to, msg));
      else if (verdict) send(to, msg);
    };
  }
  const closers = new Set<() => void>();
  const link: Link = {
    ...transportLink(t, 'host'),
    onClose: (cb) => {
      closers.add(cb);
      return () => closers.delete(cb);
    },
  };
  return {
    link,
    drop: () => {
      t.close();
      for (const cb of [...closers]) cb();
    },
    release: () => {
      for (const f of held.splice(0)) f();
    },
  };
}

/** Let the client's seat act until the hand ends; queued bot moves run next, then other seats move on the clock. */
function playOut(host: TableHost, c: TableClient, clock: { now: number }, queue: Array<() => void> = []) {
  let guard = 0;
  while (host.phase === 'playing' && guard++ < 4000) {
    const s = c.localState();
    const seat = c.state.seat;
    if (s && seat !== null && legalActions(s, seat).length > 0) c.act(chooseAction(s, seat, { seed: 'p' })!);
    else if (queue.length > 0) queue.shift()!();
    else {
      clock.now += 60_000;
      host.tick();
    }
  }
  expect(host.phase).toBe('hand_over');
}

describe('one client per table across reconnects', () => {
  it('rebind drops the old link’s subscriptions and keeps the record', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'RB');
    const first = droppable(hub, 'p0');
    const c = new TableClient(first.link, 'Victim', undefined, {}, { now: () => clock.now });
    c.join();
    host.start();
    playOut(host, c, clock);
    expect(c.state.audits).toHaveLength(1);
    first.drop();
    expect(c.state.disconnected).toBe(true);
    expect(c.state.kicked).toBe(false);
    let oldHandler: ((m: HostMessage) => void) | null = null;
    const old: Link = { ...first.link, onMessage: (cb) => ((oldHandler = cb), () => (oldHandler = null)) };
    // Rebinding onto a fresh link: messages on the old one are no longer heard.
    c.rebind(old);
    c.rebind(droppable(hub, 'p0b').link);
    expect(oldHandler).toBeNull();
    c.join();
    expect(c.state.connected).toBe(true);
    expect(c.state.disconnected).toBe(false);
    expect(c.state.seat).toBe(0);
    // The audit list and its verdict survive the reconnect.
    expect(c.state.audits).toHaveLength(1);
  });

  it('X1: a re-deal after the player revealed, hidden behind a dropped link and forged accounting, fails', () => {
    for (const mode of ['rebind', 'restore'] as const) {
      const clock = { now: 1_000_000 };
      const hub = new LoopbackHub();
      const host = makeHost(hub, clock, `X1${mode}`);
      const h = internals(host);
      let link = droppable(hub, 'p0', (m) => (m.t === 'reveal' ? 'hold' : true));
      let c = new TableClient(link.link, 'Victim', undefined, {}, { now: () => clock.now });
      const orig = h.checkCeremony.bind(host);
      let drops = 0;
      let attacking = false;
      h.checkCeremony = () => {
        if (attacking) return;
        if (!h.ceremonyBusy && h.phase === 'reveal' && h.seats.every((s) => s.secret) && drops === 0) {
          drops++;
          attacking = true;
          // The server drops the player after seeing its secret, wipes its own record and deals again.
          link.drop();
          link = droppable(hub, 'p0r');
          if (mode === 'rebind') c.rebind(link.link);
          else c = TableClient.restore(JSON.parse(JSON.stringify(c.serialize())), link.link, 'Victim', undefined, { token: c.state.token! }, { now: () => clock.now });
          c.join();
          attacking = false;
          h.ceremonyHand = -1;
          h.beginHand();
          return;
        }
        orig();
      };
      c.join();
      host.start();
      link.release();
      playOut(host, c, clock);
      expect(h.audits[0].ceremonyAttempts).toBe(1);
      expect(c.state.auditStatus).toBe('failed');
      expect(c.state.auditFailures).toContain("Host ran attempt 1 of this hand's deal twice");
    }
  });

  it('N2: a restart that blames the player after it revealed fails even though its link dropped', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'N2');
    const h = internals(host);
    let link = droppable(hub, 'p0', (m) => (m.t === 'reveal' ? 'hold' : true));
    const c = new TableClient(link.link, 'Victim', undefined, {}, { now: () => clock.now });
    const orig = h.checkCeremony.bind(host);
    let drops = 0;
    let attacking = false;
    h.checkCeremony = () => {
      if (attacking) return;
      if (!h.ceremonyBusy && h.phase === 'reveal' && h.seats.every((s) => s.secret) && drops === 0) {
        drops++;
        attacking = true;
        link.drop();
        link = droppable(hub, 'p0r');
        c.rebind(link.link);
        c.join();
        attacking = false;
        // Blamed for a 'disconnect' but asked for a fresh share instead of being stood in.
        h.beginHand('disconnect', [0]);
        return;
      }
      orig();
    };
    c.join();
    host.start();
    link.release();
    playOut(host, c, clock);
    expect(h.audits[0].restarts).toEqual([{ attempt: 1, seats: [0], cause: 'disconnect' }]);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Restart 1 blames this seat although it revealed, and the host then asked it for a new share instead of standing it in');
  });
});

describe('an honest host and a player whose link drops during the deal', () => {
  it('dropped before committing: the host re-sends stand_in on rejoin and the hand is partial, never failed', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const bots: Array<() => void> = [];
    const host = makeHost(hub, clock, 'HC', RULES, bots);
    let swallowCommit = true;
    let link = droppable(hub, 'p0', (m) => !(swallowCommit && m.t === 'commit'));
    const c = new TableClient(link.link, 'Flaky', undefined, {}, { now: () => clock.now });
    c.join();
    host.start();
    // The commitment never left the phone, then the link went: the host makes this seat's share and deals.
    link.drop();
    swallowCommit = false;
    expect(host.phase).toBe('playing');
    link = droppable(hub, 'p0r');
    c.rebind(link.link);
    c.join();
    expect(c.state.standIn).toBe(true);
    playOut(host, c, clock, bots);
    expect(c.state.auditFailures).toEqual([]);
    expect(c.state.auditStatus).toBe('partial');
    expect(c.state.auditCaveats).toEqual([AUDIT_CAVEATS.standIn, AUDIT_CAVEATS.linkLost]);
  });

  it('dropped before revealing: the restart stands the seat in, and the hand is partial, never failed', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const bots: Array<() => void> = [];
    const host = makeHost(hub, clock, 'HR', RULES, bots);
    let link = droppable(hub, 'p0', (m) => m.t !== 'reveal');
    const c = new TableClient(link.link, 'Flaky', undefined, {}, { now: () => clock.now });
    c.join();
    host.start();
    expect(host.phase).toBe('reveal');
    link.drop();
    expect(host.phase).toBe('playing');
    link = droppable(hub, 'p0r');
    c.rebind(link.link);
    c.join();
    playOut(host, c, clock, bots);
    const audit = internals(host).audits[0];
    expect(audit.restarts).toEqual([{ attempt: 1, seats: [0], cause: 'disconnect' }]);
    expect(c.state.auditFailures).toEqual([]);
    expect(c.state.auditStatus).toBe('partial');
    expect(c.state.auditCaveats).toEqual([AUDIT_CAVEATS.standIn, AUDIT_CAVEATS.restarted, AUDIT_CAVEATS.linkLost]);
  });

  it('dropped after revealing (the host has the secret): the share is used and the hand is partial for the lost link', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const bots: Array<() => void> = [];
    const host = makeHost(hub, clock, 'HV', RULES, bots);
    // A second human who reveals only when told, so the deal waits after the victim's reveal.
    const t2 = hub.create('p1');
    let other: TableClient | null = null;
    const held: Array<() => void> = [];
    const send2 = t2.send.bind(t2);
    t2.send = (to: string, msg: unknown) => {
      if ((msg as { t?: string }).t === 'reveal') held.push(() => send2(to, msg));
      else send2(to, msg);
    };
    other = new TableClient(transportLink(t2, 'host'), 'Other', undefined, {}, { now: () => clock.now });
    let link = droppable(hub, 'p0');
    const c = new TableClient(link.link, 'Victim', undefined, {}, { now: () => clock.now });
    c.join();
    other.join();
    host.start();
    expect(host.phase).toBe('reveal');
    link.drop();
    link = droppable(hub, 'p0r');
    c.rebind(link.link);
    c.join();
    for (const f of held) f();
    expect(host.phase).toBe('playing');
    // The victim plays; the other human is moved on the clock.
    playOut(host, c, clock, bots);
    expect(c.state.auditFailures).toEqual([]);
    expect(c.state.auditStatus).toBe('partial');
    expect(c.state.auditCaveats).toEqual([AUDIT_CAVEATS.linkLost]);
    expect(other.state.auditStatus).toBe('ok');
  });

  it('a link that drops and returns during play (not during the deal) keeps the hand ok', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const bots: Array<() => void> = [];
    const host = makeHost(hub, clock, 'HP', RULES, bots);
    let link = droppable(hub, 'p0');
    const c = new TableClient(link.link, 'Victim', undefined, {}, { now: () => clock.now });
    c.join();
    host.start();
    let acted = 0;
    for (let i = 0; i < 200 && acted < 3 && host.phase === 'playing'; i++) {
      const s = c.localState()!;
      if (legalActions(s, 0).length > 0) {
        c.act(chooseAction(s, 0)!);
        acted++;
      } else if (bots.length > 0) bots.shift()!();
    }
    link.drop();
    // A bot plays for the seat while it is away.
    for (let i = 0; i < 6 && bots.length > 0; i++) bots.shift()!();
    link = droppable(hub, 'p0r');
    c.rebind(link.link);
    c.join();
    playOut(host, c, clock, bots);
    expect([c.state.auditStatus, c.state.auditFailures, c.state.auditCaveats]).toEqual(['ok', [], []]);
  });
});

describe('the log is bound to the player’s own moves', () => {
  it('X2: a discard rewritten by the server (credited to the player) fails the audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'X2D');
    const t = hub.create('p0');
    const send = t.send.bind(t);
    let rewritten = 0;
    const c = new TableClient(transportLink(t, 'host'), 'Victim', undefined, {}, { now: () => clock.now });
    t.send = (to: string, msg: unknown) => {
      const m = msg as { t?: string; action?: Action };
      if (rewritten === 0 && m.t === 'action' && m.action?.type === 'discard') {
        const hand = c.state.view!.players[0].hand!;
        const other = hand.find((x) => kindOf(x) !== kindOf((m.action as { tile: number }).tile));
        if (other !== undefined) {
          rewritten++;
          msg = { ...m, action: { type: 'discard', tile: other } };
        }
      }
      send(to, msg);
    };
    c.join();
    host.start();
    playOut(host, c, clock);
    expect(rewritten).toBe(1);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures.some((f) => f.startsWith('The log changed a move this seat made'))).toBe(true);
  });

  it('X2: a win rewritten into a pass, or a win the table passed up for the seat, fails the audit', () => {
    let rewrittenHands = 0;
    let passedHands = 0;
    for (let i = 0; i < 120 && (rewrittenHands < 1 || passedHands < 1); i++) {
      const clock = { now: 1_000_000 };
      const hub = new LoopbackHub();
      const host = new TableHost(hub.create('host'), { roomCode: `X2-${i}`, rules: RULES, now: () => clock.now, matchId: `x2-${i}` });
      const t = hub.create('p0');
      const send = t.send.bind(t);
      const mode = rewrittenHands < 1 ? 'rewrite' : 'auto-pass';
      let hit = false;
      t.send = (to: string, msg: unknown) => {
        const m = msg as { t?: string; action?: Action };
        if (mode === 'rewrite' && m.t === 'action' && m.action?.type === 'hu' && c.state.view?.phase === 'claim') {
          hit = true;
          msg = { ...m, action: { type: 'pass' } };
        }
        send(to, msg);
      };
      const c = new TableClient(transportLink(t, 'host'), 'Victim', undefined, {}, { now: () => clock.now });
      c.join();
      host.start();
      let guard = 0;
      while (host.phase === 'playing' && guard++ < 4000) {
        const s = c.localState();
        const legal = s ? legalActions(s, 0) : [];
        if (mode === 'auto-pass' && !hit && s?.phase === 'claim' && legal.some((a) => a.type === 'hu')) {
          // The clock runs out honestly, but the table's move for the seat passes up the win.
          hit = true;
          clock.now += 10 * 60_000;
          internals(host).apply(0, { type: 'pass' }, 'timeout');
          continue;
        }
        if (s && legal.length > 0) c.act(chooseAction(s, 0)!);
        else {
          clock.now += 60_000;
          host.tick();
        }
      }
      if (!hit) continue;
      expect(c.state.auditStatus).toBe('failed');
      if (mode === 'rewrite') {
        rewrittenHands++;
        expect(c.state.auditFailures.some((f) => f.startsWith('The log changed a move this seat made'))).toBe(true);
      } else {
        passedHands++;
        expect(c.state.auditFailures.some((f) => f.startsWith('The table played for this seat and passed up its win'))).toBe(true);
        expect(c.state.auditFailures.some((f) => f.includes('clock had not run out'))).toBe(false);
      }
    }
    expect([rewrittenHands, passedHands]).toEqual([1, 1]);
  });

  it('a move the table makes for a connected seat before its clock runs out fails; a real timeout does not', () => {
    for (const early of [true, false]) {
      const clock = { now: 1_000_000 };
      const hub = new LoopbackHub();
      const host = makeHost(hub, clock, early ? 'AE' : 'AT');
      const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now });
      c.join();
      host.start();
      let done = false;
      let guard = 0;
      while (host.phase === 'playing' && guard++ < 4000) {
        const s = c.localState()!;
        if (!done && legalActions(s, 0).length > 0) {
          done = true;
          if (early) {
            // The server moves for the seat a second after showing it its turn.
            clock.now += 1_000;
            internals(host).apply(0, chooseAction(host.game!, 0)!, 'timeout');
          } else {
            // The player does nothing; the table times it out on its own clock.
            while (host.phase === 'playing' && legalActions(c.localState()!, 0).length > 0 && guard++ < 4000) {
              clock.now += 5_000;
              host.tick();
            }
          }
          continue;
        }
        if (legalActions(s, 0).length > 0) c.act(chooseAction(s, 0)!);
        else {
          clock.now += 60_000;
          host.tick();
        }
      }
      expect(host.phase).toBe('hand_over');
      const early1 = c.state.auditFailures.some((f) => f.includes('clock had not run out'));
      expect(early1).toBe(early);
      if (!early) expect([c.state.auditStatus, c.state.auditFailures]).toEqual(['ok', []]);
    }
  });

  it('a state the player was shown that the replay never reaches fails the audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const hsend = ht.send.bind(ht);
    let forged = false;
    ht.send = (to: string, msg: unknown) => {
      const m = msg as { t?: string; hash?: string; view?: { turnCounter: number } };
      if (!forged && m.t === 'state' && m.view && m.view.turnCounter === 3) {
        forged = true;
        msg = { ...m, hash: '0badc0de' };
      }
      hsend(to, msg);
    };
    const host = new TableHost(ht, { roomCode: 'SH', rules: RULES, now: () => clock.now, matchId: 'sh' });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now });
    c.join();
    host.start();
    playOut(host, c, clock);
    expect(forged).toBe(true);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('The state this seat was shown at turn 3 is not in the replay');
  });

  it('the engine logs who chose each move, and replays and hashes ignore it', () => {
    let s = newGame('src', RULES, 0);
    let plain = s;
    for (let i = 0; i < 12 && s.phase !== 'ended'; i++) {
      const seat = [0, 1, 2, 3].find((x) => legalActions(s, x).length > 0)!;
      const a = chooseAction(s, seat)!;
      s = applyAction(s, seat, a, i % 2 ? 'auto' : 'player');
      plain = applyAction(plain, seat, a);
    }
    expect(s.actionLog.map((e) => e.source)).toEqual(s.actionLog.map((_, i) => (i % 2 ? 'auto' : 'player')));
    expect(plain.actionLog.every((e) => e.source === undefined)).toBe(true);
    expect(hashState(s)).toBe(hashState(plain));
    expect(hashState(replayHand(matchSnapshot(newGame('src', RULES, 0)), 'src', RULES, s.actionLog))).toBe(hashState(s));
  });
});

describe('anchors and pinned match facts', () => {
  it('X3: hand 0 dealt from rewritten scores and a fake dealer streak fails the audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'X3', withRules({ handsPerMatch: 2 }));
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now });
    c.join();
    const h = internals(host);
    h.snapshot = { ...h.snapshot, scores: [-500, 0, 500, 0], dealerSeat: 2, dealerStreak: 3 };
    host.start();
    playOut(host, c, clock);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('The match started with scores, dealerSeat, dealerStreak different from a new match');
  });

  it('N3: scores rewritten between hands while the player is away fail the next audit, after a reconnect or an app restart', () => {
    for (const mode of ['rebind', 'restore'] as const) {
      const clock = { now: 1_000_000 };
      const hub = new LoopbackHub();
      const ht = hub.create('host');
      const hsend = ht.send.bind(ht);
      // The server does not re-send the finished hand to the returning seat.
      ht.send = (to: string, msg: unknown) => {
        const m = msg as { t?: string; audit?: { handNumber: number } };
        if (to === 'p0r' && m.t === 'hand_over' && m.audit?.handNumber === 0) return;
        hsend(to, msg);
      };
      const host = new TableHost(ht, { roomCode: `N3${mode}`, rules: withRules({ handsPerMatch: 4 }), now: () => clock.now, matchId: `n3-${mode}` });
      const h = internals(host);
      let link = droppable(hub, 'p0');
      let c = new TableClient(link.link, 'Victim', undefined, {}, { now: () => clock.now });
      c.join();
      host.start();
      playOut(host, c, clock);
      expect(c.state.auditStatus).toBe('ok');
      const saved: SerializedClient = JSON.parse(JSON.stringify(c.serialize()));
      link.drop();
      const origBegin = h.beginHand.bind(host);
      h.beginHand = (...args) => {
        h.snapshot = { ...h.snapshot, scores: h.snapshot.scores.map((s, i) => (i === 0 ? s - 300 : i === 2 ? s + 300 : s)) };
        h.beginHand = origBegin;
        origBegin(...args);
      };
      link = droppable(hub, 'p0r');
      if (mode === 'rebind') c.rebind(link.link);
      else c = TableClient.restore(saved, link.link, 'Victim', undefined, { token: saved.state.token! }, { now: () => clock.now });
      c.join();
      c.ready();
      // The intermission ends on the clock if 'ready' alone does not move the table on.
      if (host.phase === 'hand_over') {
        clock.now += 60_000;
        host.tick();
      }
      playOut(host, c, clock);
      expect(c.state.audits.map((a) => a.audit.handNumber)).toEqual([0, 1]);
      expect(c.state.auditStatus).toBe('failed');
      expect(c.state.auditFailures).toContain('Hand started with scores different from where the previous hand left them');
    }
  });

  it('N6: a welcome that moves the player to another seat mid-match is flagged and the seat stays pinned', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const host = new TableHost(ht, { roomCode: 'N6', rules: RULES, now: () => clock.now, matchId: 'n6' });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now });
    c.join();
    host.start();
    ht.send('p0', { t: 'welcome', seat: 2, roomCode: 'N6', rules: host.rules, seats: host.seatInfo(), matchId: 'n6', token: c.state.token });
    expect(c.state.seat).toBe(0);
    playOut(host, c, clock);
    expect(c.state.auditFailures).toContain('Host moved this seat to another seat mid-match');
  });

  it('N1: bots relabelled as humans after the first deal are flagged; phantom humans from the start only reach partial', () => {
    // Relabelled mid-match.
    {
      const clock = { now: 1_000_000 };
      const hub = new LoopbackHub();
      const ht = hub.create('host');
      const host = new TableHost(ht, { roomCode: 'N1a', rules: RULES, now: () => clock.now, matchId: 'n1a' });
      const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now });
      c.join();
      host.start();
      ht.send('p0', { t: 'lobby', seats: host.seatInfo().map((s) => ({ ...s, isBot: false })) });
      playOut(host, c, clock);
      expect(c.state.auditFailures).toContain('Host changed which seats are bots during the match');
    }
    // Phantom humans from the very first message: restarts that blame them leave the hand amber at best.
    {
      const clock = { now: 1_000_000 };
      const hub = new LoopbackHub();
      const ht = hub.create('host');
      const hsend = ht.send.bind(ht);
      ht.send = (to: string, msg: unknown) => {
        const m = msg as { t?: string; seats?: Array<{ isBot: boolean }> };
        if ((m.t === 'welcome' || m.t === 'lobby') && Array.isArray(m.seats)) msg = { ...m, seats: m.seats.map((s) => ({ ...s, isBot: false })) };
        hsend(to, msg);
      };
      const host = new TableHost(ht, { roomCode: 'N1b', rules: RULES, now: () => clock.now, matchId: 'n1b' });
      const h = internals(host);
      const link = droppable(hub, 'p0', (m) => (m.t === 'reveal' ? 'hold' : true));
      const c = new TableClient(link.link, 'Victim', undefined, {}, { now: () => clock.now });
      const orig = h.checkCeremony.bind(host);
      let restarts = 0;
      h.checkCeremony = () => {
        if (!h.ceremonyBusy && h.phase === 'reveal' && h.seats.every((s) => s.secret) && restarts < 2) {
          restarts++;
          h.restartCeremony([h.seats[restarts]], 'disconnect');
          return;
        }
        orig();
      };
      c.join();
      host.start();
      for (let k = 0; k < 5 && host.phase === 'reveal'; k++) link.release();
      playOut(host, c, clock);
      expect(h.audits[0].ceremonyAttempts).toBe(3);
      expect(c.state.auditStatus).toBe('partial');
      expect(c.state.auditCaveats).toContain(AUDIT_CAVEATS.restarted);
    }
  });
});

describe('the client’s record survives an app restart', () => {
  it('serialises to JSON and restores the audits, the chain and the pinned seat', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'SR', withRules({ handsPerMatch: 4 }));
    const first = droppable(hub, 'p0');
    const c = new TableClient(first.link, 'Victim', undefined, {}, { now: () => clock.now });
    c.join();
    host.start();
    playOut(host, c, clock);
    const saved = JSON.parse(JSON.stringify(c.serialize())) as SerializedClient;
    expect(saved.version).toBe(1);
    first.drop();
    const back = TableClient.restore(saved, droppable(hub, 'p0r').link, 'Victim', undefined, { token: saved.state.token! }, { now: () => clock.now });
    expect(back.state.audits).toHaveLength(1);
    expect(back.state.seat).toBe(0);
    expect(back.state.connected).toBe(false);
    back.join();
    back.ready();
    playOut(host, back, clock);
    expect(back.state.audits.map((a) => [a.audit.handNumber, a.status])).toEqual([
      [0, 'ok'],
      [1, 'ok'],
    ]);
  });

  it('keeps only the last 50 audits, and an unknown snapshot gives a client with no history', () => {
    const hub = new LoopbackHub();
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'A');
    const fake = { audit: { handNumber: 0, matchId: 'm' } as Audit, status: 'ok' as const, failures: [], caveats: [] };
    c.state = { ...c.state, audits: Array.from({ length: 70 }, (_, i) => ({ ...fake, audit: { ...fake.audit, handNumber: i } })) };
    const saved = c.serialize();
    expect(saved.state.audits).toHaveLength(MAX_AUDITS);
    expect(saved.state.audits[0].audit.handNumber).toBe(20);
    const junk = TableClient.restore({ version: 99 }, transportLink(hub.create('p1'), 'host'), 'A', undefined, { token: 'a'.repeat(32) });
    expect(junk.state.audits).toEqual([]);
    expect(junk.state.token).toBe('a'.repeat(32));
  });
});

describe('a seat opened on another device', () => {
  it('sets kicked, not disconnected, on the old client', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'KK');
    const a = new TableClient(transportLink(hub.create('p0'), 'host'), 'Phone');
    a.join();
    host.start();
    const b = new TableClient(transportLink(hub.create('p0-tablet'), 'host'), 'Tablet', undefined, { token: a.state.token! });
    b.join();
    expect(b.state.seat).toBe(0);
    expect(a.state.kicked).toBe(true);
    expect(a.state.disconnected).toBe(false);
    expect(a.state.connected).toBe(false);
  });
});
