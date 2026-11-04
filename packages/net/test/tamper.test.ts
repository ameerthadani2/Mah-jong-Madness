/**
 * A host that bends the seed ceremony must not get a clean audit. Each case is a port of an audit
 * probe: the honest host is modified the way a cheating host would be, and the victim's client must
 * end the hand `failed` with the specific reason (or, where a cheat is indistinguishable from an
 * honest stand-in, never better than `partial`).
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, countsFromKinds, dealFromSnapshot, kindOf, legalActions, NUM_PLAY_KINDS, shanten, withRules, type GameState, type MatchSnapshot } from '@mjm/engine';
import { commitFor, deriveSeed, LoopbackHub, makeSecret, TableClient, TableHost, transportLink, type Audit, type HostMessage } from '../src/index';

const RULES = withRules({ handsPerMatch: 1 });

/** Private host internals the probes reach into. */
interface HostInternals {
  phase: string;
  game: GameState | null;
  matchId: string;
  snapshot: MatchSnapshot;
  hostSecret: string;
  seats: Array<{ seat: number; secret?: string; commit?: string; isBot: boolean }>;
  ceremonyAttempts: number;
  restarts: unknown[];
  audits: Audit[];
  checkCeremony: () => void;
  restartCeremony: (late: unknown[], cause: string) => void;
  beginHand: () => void;
}
const internals = (host: TableHost) => host as unknown as HostInternals;

function makeHost(hub: LoopbackHub, clock: { now: number }, roomCode: string, rules = RULES) {
  return new TableHost(hub.create('host'), { roomCode, rules, now: () => clock.now, matchId: 'probe' });
}

/** A client whose outgoing messages are recorded. */
function recordedClient(hub: LoopbackHub, id: string, name: string) {
  const t = hub.create(id);
  const sent: string[] = [];
  const send = t.send.bind(t);
  t.send = (to: string, msg: unknown) => {
    sent.push((msg as { t: string }).t);
    send(to, msg);
  };
  return { t, sent, client: new TableClient(transportLink(t, 'host'), name) };
}

/** Play the hand out for every human client; seats with no human move on the clock. */
function playOut(host: TableHost, clients: TableClient[], clock: { now: number }) {
  let guard = 0;
  while (host.phase === 'playing' && guard++ < 4000) {
    let acted = false;
    for (const c of clients) {
      const s = c.localState();
      if (!s || c.state.seat === null || legalActions(s, c.state.seat).length === 0) continue;
      c.act(chooseAction(s, c.state.seat, { seed: `t${c.state.seat}` })!);
      acted = true;
      break;
    }
    if (!acted) {
      clock.now += 60_000;
      host.tick();
    }
  }
  expect(host.phase).toBe('hand_over');
}

/** Starting shanten of seat 0 for a candidate deal (higher is worse for the victim). */
function startShanten(g: GameState): number {
  return shanten(countsFromKinds(g.players[0].hand.map(kindOf).filter((k) => k < NUM_PLAY_KINDS)), 5);
}

describe('tampering hosts (audit probes)', () => {
  it('A: withholding the commitments gets no reveal out of the client, and the hand fails', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const hsend = ht.send.bind(ht);
    ht.send = (to: string, msg: unknown) => {
      if ((msg as HostMessage).t === 'commits') return;
      hsend(to, msg);
    };
    const host = new TableHost(ht, { roomCode: 'ATA', rules: RULES, now: () => clock.now, matchId: 'probe' });
    const v = recordedClient(hub, 'p0', 'Victim');
    v.client.join();
    host.start();
    // The client refuses to reveal blind, so the host has nothing to grind against.
    expect(host.phase).toBe('reveal');
    expect(v.sent).not.toContain('reveal');
    clock.now += 10_001;
    host.tick();
    playOut(host, [v.client], clock);
    expect(v.sent).not.toContain('reveal');
    expect(v.client.state.auditStatus).toBe('failed');
    expect(v.client.state.auditFailures).toContain('Host asked for my secret before publishing all commitments');
  });

  it('B: a fake stand-in that lets the host pick the victim’s share is never better than partial', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const host = new TableHost(ht, { roomCode: 'ATB', rules: RULES, now: () => clock.now, matchId: 'probe' });
    const h = internals(host);
    const pt = hub.create('p0');
    const psend = pt.send.bind(pt);
    pt.send = (to: string, msg: unknown) => {
      if ((msg as { t: string }).t === 'commit') {
        // Grind the victim's share against the other (known) shares, claim it was a stand-in, drop the real commit.
        let best = '';
        let worst = -1;
        for (let i = 0; i < 40; i++) {
          const cand = makeSecret();
          const reveals = [{ seat: 0, secret: cand }, ...h.seats.filter((s) => s.seat !== 0).map((s) => ({ seat: s.seat, secret: s.secret! })), { seat: 4, secret: h.hostSecret }];
          const sh = startShanten(dealFromSnapshot(h.snapshot, seedOf(h, reveals), RULES));
          if (sh > worst) [worst, best] = [sh, cand];
        }
        h.seats[0].secret = best;
        h.seats[0].commit = commitFor(best);
        ht.send('p0', { t: 'stand_in', handNumber: h.snapshot.handNumber });
        h.checkCeremony();
        return;
      }
      psend(to, msg);
    };
    const c = new TableClient(transportLink(pt, 'host'), 'Victim');
    c.join();
    host.start();
    expect(c.state.standIn).toBe(true);
    playOut(host, [c], clock);
    expect(c.state.auditStatus).toBe('partial');
    expect(c.state.auditCaveats).toContain("The host supplied this seat's share");
  });

  it('C: a selective abort that blames a bot seat fails the audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'ATC');
    const h = internals(host);
    const orig = h.checkCeremony.bind(host);
    let aborts = 0;
    h.checkCeremony = () => {
      // Every share is in: dislike the deal and pretend the bot in seat 3 never revealed.
      if (h.phase === 'reveal' && h.seats.every((s) => s.secret) && aborts < 1) {
        aborts++;
        h.restartCeremony([h.seats[2]], 'no_reveal');
        return;
      }
      orig();
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    expect(aborts).toBe(1);
    playOut(host, [c], clock);
    expect(h.audits[0].restarts).toEqual([{ attempt: 1, seats: [2], cause: 'no_reveal' }]);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Restart 1 blames seat 3, which is a bot');
  });

  it('C: more restarts than the human seats could cause fails the audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'ATC2');
    const h = internals(host);
    const orig = h.checkCeremony.bind(host);
    let aborts = 0;
    h.checkCeremony = () => {
      // Blame the only human again and again (abort-probe7 ran this 387 times).
      if (h.phase === 'reveal' && h.seats.every((s) => s.secret) && aborts < 3) {
        aborts++;
        h.restartCeremony([], 'disconnect');
        return;
      }
      orig();
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    playOut(host, [c], clock);
    expect(h.audits[0].ceremonyAttempts).toBe(4);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('4 ceremony attempts is more than 2, the most an honest table with 1 human seats needs');
  });

  it('C: under-reporting the attempts the client saw fails the audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'ATC3');
    const h = internals(host);
    const orig = h.checkCeremony.bind(host);
    let aborts = 0;
    h.checkCeremony = () => {
      if (h.phase === 'reveal' && h.seats.every((s) => s.secret) && aborts < 1) {
        aborts++;
        h.restartCeremony([], 'no_reveal');
        return;
      }
      orig();
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    expect(host.phase).toBe('playing');
    // Rewrite history: claim the first deal was the only one.
    h.ceremonyAttempts = 1;
    h.restarts = [];
    playOut(host, [c], clock);
    expect(h.audits[0].ceremonyAttempts).toBe(1);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Audit reports 1 ceremony attempts but this seat was asked to commit 2 times');
  });

  it('D: beginHand() while a hand is being played is a no-op', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'ATD');
    const v = recordedClient(hub, 'p0', 'Victim');
    v.client.join();
    host.start();
    for (let i = 0; i < 3; i++) {
      const s = v.client.localState()!;
      if (legalActions(s, 0).length) v.client.act(chooseAction(s, 0)!);
    }
    expect(host.phase).toBe('playing');
    const before = JSON.stringify(internals(host).game);
    const commitsSent = v.sent.filter((t) => t === 'commit').length;
    internals(host).beginHand();
    expect(host.phase).toBe('playing');
    expect(JSON.stringify(internals(host).game)).toBe(before);
    expect(v.sent.filter((t) => t === 'commit').length).toBe(commitsSent);
    playOut(host, [v.client], clock);
    expect(v.client.state.auditStatus).toBe('ok');
  });

  it('D: a commit request for the hand in progress is refused and fails the audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const host = new TableHost(ht, { roomCode: 'ATD2', rules: RULES, now: () => clock.now, matchId: 'probe' });
    const v = recordedClient(hub, 'p0', 'Victim');
    v.client.join();
    host.start();
    const s = v.client.localState()!;
    if (legalActions(s, 0).length) v.client.act(chooseAction(s, 0)!);
    expect(host.phase).toBe('playing');
    const commitsSent = v.sent.filter((t) => t === 'commit').length;
    ht.send('p0', { t: 'commit_request', handNumber: v.client.state.view!.handNumber });
    expect(v.sent.filter((t) => t === 'commit').length).toBe(commitsSent);
    playOut(host, [v.client], clock);
    expect(v.client.state.auditStatus).toBe('failed');
    expect(v.client.state.auditFailures).toContain('Host re-dealt a hand in progress');
  });

  it('a host that skips a seat’s commit request for a later hand fails that hand’s audit', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const hsend = ht.send.bind(ht);
    let skip = false;
    ht.send = (to: string, msg: unknown) => {
      if (skip && (msg as HostMessage).t === 'commit_request') return;
      hsend(to, msg);
    };
    const host = new TableHost(ht, { roomCode: 'SKP', rules: withRules({ handsPerMatch: 2 }), now: () => clock.now, matchId: 'probe' });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    playOut(host, [c], clock);
    expect(c.state.auditStatus).toBe('ok');
    skip = true;
    c.ready();
    // The host waits out the commit window and stands in a share it never asked for.
    clock.now += 10_001;
    host.tick();
    playOut(host, [c], clock);
    expect(c.state.audits).toHaveLength(2);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Host never asked this seat to commit');
  });
});

describe('honest tables stay verified', () => {
  it('four humans with one late revealer: three verify ok and the late one partial', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'H4');
    const clients: TableClient[] = [];
    for (let i = 0; i < 4; i++) {
      const t = hub.create(`p${i}`);
      if (i === 2) {
        // Seat 3's first reveal is lost on the way.
        const send = t.send.bind(t);
        let dropped = false;
        t.send = (to: string, msg: unknown) => {
          if (!dropped && (msg as { t: string }).t === 'reveal') {
            dropped = true;
            return;
          }
          send(to, msg);
        };
      }
      const c = new TableClient(transportLink(t, 'host'), `P${i}`);
      c.join();
      clients.push(c);
    }
    host.start();
    expect(host.phase).toBe('reveal');
    clock.now += 10_001;
    host.tick();
    expect(host.phase).toBe('playing');
    playOut(host, clients, clock);
    const audit = internals(host).audits[0];
    expect(audit.ceremonyAttempts).toBe(2);
    expect(audit.restarts).toEqual([{ attempt: 1, seats: [2], cause: 'no_reveal' }]);
    expect(clients.map((c) => c.state.auditStatus)).toEqual(['ok', 'ok', 'partial', 'ok']);
    for (const c of clients) expect(c.state.auditFailures).toEqual([]);
    expect(clients[2].state.auditCaveats).toEqual(["The host supplied this seat's share"]);
  });

  it('two humans verify every hand of a match as ok', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, 'H2', withRules({ handsPerMatch: 2 }));
    const clients = [0, 1].map((i) => new TableClient(transportLink(hub.create(`p${i}`), 'host'), `P${i}`));
    for (const c of clients) c.join();
    host.start();
    let guard = 0;
    while (host.phase !== 'match_over' && guard++ < 20) {
      playOut(host, clients, clock);
      for (const c of clients) c.ready();
    }
    expect(host.phase).toBe('match_over');
    for (const c of clients) {
      expect(c.state.audits.length).toBeGreaterThan(1);
      for (const a of c.state.audits) expect([a.status, a.failures]).toEqual(['ok', []]);
    }
  });
});

function seedOf(h: HostInternals, reveals: Array<{ seat: number; secret: string }>): string {
  return deriveSeed(`${h.matchId}:${h.snapshot.handNumber}`, reveals);
}
