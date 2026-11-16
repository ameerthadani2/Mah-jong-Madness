/**
 * A host that bends the seed ceremony must not get a clean audit. Each case is a port of an audit
 * probe: the honest host is modified the way a cheating host would be, and the victim's client must
 * end the hand `failed` with the specific reason (or, where a cheat is indistinguishable from an
 * honest stand-in, never better than `partial`).
 */
import { describe, expect, it, vi } from 'vitest';
import { chooseAction, countsFromKinds, dealFromSnapshot, kindOf, legalActions, NUM_PLAY_KINDS, shanten, withRules, type GameState, type MatchSnapshot } from '@mjm/engine';
import { AUDIT_CAVEATS, commitFor, deriveSeed, failureKey, LoopbackHub, makeSecret, sha256Hex, TableClient, TableHost, transportLink, type Audit, type HostMessage, type Link, type Reveal } from '../src/index';
import { Missed, scenario } from './support';

const RULES = withRules({ handsPerMatch: 1 });

/** Private host internals the probes reach into. */
interface HostInternals {
  phase: string;
  game: GameState | null;
  matchId: string;
  snapshot: MatchSnapshot;
  hostSecret: string;
  seats: Array<{ seat: number; secret?: string; commit?: string; isBot: boolean }>;
  hostCommit: string;
  deadline: number | null;
  ceremonyAttempts: number;
  restarts: unknown[];
  audits: Audit[];
  checkCeremony: () => void;
  restartCeremony: (late: unknown[], cause: string) => void;
  beginHand: (cause?: string, seats?: number[]) => void;
  reveals: () => Reveal[];
  commits: () => Array<{ seat: number; hash: string }>;
  armClocks: () => void;
  broadcastState: () => void;
  runBots: () => void;
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
  it('four humans with one late revealer: nobody fails, and the restart keeps every hand at partial', () => {
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
    expect(clients.map((c) => c.state.auditStatus)).toEqual(['partial', 'partial', 'partial', 'partial']);
    for (const c of clients) expect(c.state.auditFailures).toEqual([]);
    for (const i of [0, 1, 3]) expect(clients[i].state.auditCaveats).toEqual([AUDIT_CAVEATS.restarted]);
    expect(clients[2].state.auditCaveats).toEqual(["The host supplied this seat's share", AUDIT_CAVEATS.restarted]);
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

describe('extra shares and re-published commitments (review probes)', () => {
  /**
   * A cheating host's seed over every reveal it lists, extras included (the pre-v2 derivation, which
   * a client used to accept): it deals from this and publishes the extra share in the audit.
   */
  const anySeed = (key: string, reveals: Reveal[]) => sha256Hex(`mjm-seed:${key}:${[...reveals].sort((a, b) => a.seat - b.seat).map((r) => r.secret).join('|')}`);

  it.each([
    ['an out-of-range seat 9', 9],
    ['a second seat-0 share', 0],
    ['a second seat-4 share', 4],
  ])('E: %s picked after every reveal fails the audit', (_label, extraSeat) => {
    // Port of ceremony/p1_extra_reveal.ts and verify-ceremony/probe.test.ts.
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, `AE${extraSeat}`);
    const h = internals(host);
    const realReveals = h.reveals.bind(host);
    const orig = h.checkCeremony.bind(host);
    let ground = false;
    h.checkCeremony = () => {
      if (ground || h.phase !== 'reveal' || !h.seats.every((s) => s.secret)) return orig();
      ground = true;
      // Every real share is in, the victim's included: grind a sixth one for the worst deal.
      const key = `${h.matchId}:${h.snapshot.handNumber}`;
      let worst = -1;
      let pick = { seed: '', extra: '' };
      for (let i = 0; i < 20; i++) {
        const extra = makeSecret();
        const seed = anySeed(key, [...realReveals(), { seat: extraSeat, secret: extra }]);
        const sh = startShanten(dealFromSnapshot(h.snapshot, seed, RULES));
        if (sh > worst) [worst, pick] = [sh, { seed, extra }];
      }
      h.reveals = () => [...realReveals(), { seat: extraSeat, secret: pick.extra }];
      h.game = dealFromSnapshot(h.snapshot, pick.seed, RULES);
      h.phase = 'playing';
      h.deadline = null;
      h.armClocks();
      h.broadcastState();
      h.runBots();
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    expect(ground).toBe(true);
    playOut(host, [c], clock);
    expect(c.state.lastAudit!.reveals).toHaveLength(6);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Audit must list exactly one secret for each of seats 0–4');
  });

  it('F: re-publishing the commitments after the victim revealed fails the audit', () => {
    // Port of ceremony/p6_recommit.ts and verify-ceremony/recommit.ts.
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const host = new TableHost(ht, { roomCode: 'AF', rules: RULES, now: () => clock.now, matchId: 'probe' });
    const h = internals(host);
    const orig = h.checkCeremony.bind(host);
    let swapped = false;
    h.checkCeremony = () => {
      if (!swapped && h.phase === 'reveal' && h.seats.every((s) => s.secret)) {
        swapped = true;
        // The victim's secret is known: grind the host share, then publish the new set of commitments.
        let best = h.hostSecret;
        let worst = -1;
        for (let i = 0; i < 20; i++) {
          h.hostSecret = makeSecret();
          const sh = startShanten(dealFromSnapshot(h.snapshot, seedOf(h, h.reveals()), RULES));
          if (sh > worst) [worst, best] = [sh, h.hostSecret];
        }
        h.hostSecret = best;
        h.hostCommit = commitFor(best);
        ht.send('p0', { t: 'commits', handNumber: h.snapshot.handNumber, commits: h.commits() });
      }
      orig();
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    expect(swapped).toBe(true);
    playOut(host, [c], clock);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Host changed the commitments after publishing them');
  });

  it('F: an identical re-send of the commitments (a returning seat) is accepted quietly', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const ht = hub.create('host');
    const host = new TableHost(ht, { roomCode: 'AF2', rules: RULES, now: () => clock.now, matchId: 'probe' });
    const h = internals(host);
    const orig = h.checkCeremony.bind(host);
    let resent = false;
    h.checkCeremony = () => {
      if (!resent && h.phase === 'reveal' && h.seats.every((s) => s.secret)) {
        resent = true;
        ht.send('p0', { t: 'commits', handNumber: h.snapshot.handNumber, commits: [...h.commits()].reverse() });
      }
      orig();
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    expect(resent).toBe(true);
    playOut(host, [c], clock);
    expect([c.state.auditStatus, c.state.auditFailures]).toEqual(['ok', []]);
  });
});

describe('selective aborts (review probes)', () => {
  /** A host that re-deals once after seeing every reveal, the victim's included. */
  function abortOnce(code: string, humans: number, abort: (h: HostInternals) => void, times = 1) {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, code);
    const h = internals(host);
    const orig = h.checkCeremony.bind(host);
    let aborts = 0;
    h.checkCeremony = () => {
      if (aborts < times && h.phase === 'reveal' && h.seats.every((s) => s.secret)) {
        aborts++;
        abort(h);
        return;
      }
      orig();
    };
    const clients = Array.from({ length: humans }, (_, i) => new TableClient(transportLink(hub.create(`p${i}`), 'host'), `P${i}`));
    for (const c of clients) c.join();
    host.start();
    expect(aborts).toBe(times);
    playOut(host, clients, clock);
    return { clients, audit: h.audits[0] };
  }

  it.each([
    ['host_restarted', []],
    ['no_reveal', []],
    ['disconnect', []],
  ])('G: a restart (%s) that blames nobody while the victim stayed connected fails the audit', (cause, seats) => {
    // Port of ceremony/p2_unblamed_restart.ts and verify-ceremony/probe.ts.
    const { clients, audit } = abortOnce(`AG-${cause}`, 1, (h) => h.beginHand(cause, seats));
    expect(audit.ceremonyAttempts).toBe(2);
    expect(clients[0].state.auditStatus).toBe('failed');
    expect(clients[0].state.auditFailures).toContain('Restart 1 blames no seat, yet this seat saw every attempt without losing its link');
  });

  it.each(['no_reveal', 'disconnect'])('G: blaming the victim (%s) after it revealed, without standing it in, fails the audit', (cause) => {
    const { clients, audit } = abortOnce(`AGV-${cause}`, 1, (h) => h.beginHand(cause, [0]));
    expect(audit.restarts).toEqual([{ attempt: 1, seats: [0], cause }]);
    expect(clients[0].state.standIn).toBe(false);
    expect(clients[0].state.auditStatus).toBe('failed');
    expect(clients[0].state.auditFailures).toContain('Restart 1 blames this seat although it revealed, and the host then asked it for a new share instead of standing it in');
  });

  it('G: blaming the victim and standing it in (what an honest host does) is never better than partial', () => {
    const { clients } = abortOnce('AGS', 1, (h) => h.restartCeremony([h.seats[0]], 'no_reveal'));
    expect(clients[0].state.auditFailures).toEqual([]);
    expect(clients[0].state.auditStatus).toBe('partial');
  });

  it('G: blaming a seat again after it was stood in fails the audit', () => {
    // Two humans so two restarts stay within the 1 + humans bound; the second names seat 1 again.
    const { clients, audit } = abortOnce('AGA', 2, (h) => h.beginHand('no_reveal', [0]), 2);
    expect(audit.restarts).toEqual([
      { attempt: 1, seats: [0], cause: 'no_reveal' },
      { attempt: 2, seats: [0], cause: 'no_reveal' },
    ]);
    for (const c of clients) {
      expect(c.state.auditStatus).toBe('failed');
      expect(c.state.auditFailures).toContain('Restart 2 blames seat 1 again after the host had stood it in');
    }
  });
});

describe('hands chain onto one another (review probes)', () => {
  /** Two hands of a four-hand match; `rewrite` may change the host's match state before the second deal. */
  function twoHands(code: string, rewrite?: (h: HostInternals, first: MatchSnapshot) => void) {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, code, withRules({ handsPerMatch: 4 }));
    const h = internals(host);
    const origBegin = h.beginHand.bind(host);
    let first: MatchSnapshot | null = null;
    h.beginHand = (...args) => {
      if (first === null) first = structuredClone(h.snapshot);
      else if (rewrite && h.snapshot.handNumber !== first.handNumber) rewrite(h, first);
      origBegin(...args);
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    playOut(host, [c], clock);
    const firstStatus = c.state.auditStatus;
    c.ready();
    expect(host.phase).toBe('playing');
    playOut(host, [c], clock);
    return { c, firstStatus };
  }

  it('an honest two-hand match verifies both hands as ok', () => {
    const { c, firstStatus } = twoHands('CH0');
    expect(firstStatus).toBe('ok');
    expect(c.state.audits.map((a) => [a.status, a.failures])).toEqual([
      ['ok', []],
      ['ok', []],
    ]);
  });

  it('a host that rewrites the scores between hands fails the next audit', () => {
    // Port of ceremony/p3_chain.ts ("scores").
    const { c, firstStatus } = twoHands('CH1', (h) => {
      h.snapshot = { ...h.snapshot, scores: h.snapshot.scores.map((s, i) => (i === 0 ? s - 9999 : s + 3333)) };
    });
    expect(firstStatus).toBe('ok');
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Hand started with scores different from where the previous hand left them');
  });

  it('a host that moves the dealer between hands fails the next audit', () => {
    // Port of verify-ceremony/v_chain.ts.
    const { c } = twoHands('CH2', (h) => {
      h.snapshot = { ...h.snapshot, dealerSeat: (h.snapshot.dealerSeat + 2) % 4, dealerStreak: 7 };
    });
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Hand started with dealerSeat, dealerStreak different from where the previous hand left them');
  });

  it('a host that deals a finished hand again fails the re-deal’s audit', () => {
    // Port of ceremony/p3_chain.ts ("same-hand"): void hand 1 and deal it afresh.
    const { c } = twoHands('CH3', (h, first) => {
      h.snapshot = structuredClone(first);
    });
    expect(c.state.audits).toHaveLength(2);
    expect(c.state.audits[0].status).toBe('ok');
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Host asked to deal a hand that was already played');
  });
});

describe('honest lossy tables', () => {
  it.each([
    ['dropped (A misses its 1st and 2nd reveal, B its 2nd and 3rd)', [1, 2], [2, 3], false],
    ['dropped (A misses 1–3, B misses 2–4)', [1, 2, 3], [2, 3, 4], false],
    ['delayed past the window (A 1st and 2nd, B 2nd and 3rd)', [1, 2], [2, 3], true],
  ])('two humans with reveals %s: both audits pass and attempts stay within 1 + humans', (_label, loseA, loseB, delay) => {
    // Port of ceremony/p8_flaky.ts, p8b_flaky_stuck.ts and verify-ceremony/v1.ts.
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, `LT${loseA.join('')}${delay ? 'd' : ''}`);
    const held: Array<() => void> = [];
    const lossy = (id: string, lose: number[]) => {
      const t = hub.create(id);
      const send = t.send.bind(t);
      let n = 0;
      t.send = (to: string, msg: unknown) => {
        if ((msg as { t: string }).t === 'reveal' && lose.includes(++n)) {
          if (delay) held.push(() => send(to, msg));
          return;
        }
        send(to, msg);
      };
      return new TableClient(transportLink(t, 'host'), id);
    };
    const a = lossy('a', loseA);
    const b = lossy('b', loseB);
    a.join();
    b.join();
    host.addBot();
    host.addBot();
    host.start();
    const attempts: number[] = [];
    for (let i = 0; i < 8 && host.phase !== 'playing'; i++) {
      attempts.push(internals(host).ceremonyAttempts);
      expect(host.phase).not.toBe('lobby');
      const late = held.splice(0);
      clock.now += 10_001;
      host.tick();
      for (const deliver of late) deliver();
    }
    expect(host.phase).toBe('playing');
    expect(Math.max(...attempts, internals(host).ceremonyAttempts)).toBeLessThanOrEqual(3);
    playOut(host, [a, b], clock);
    const audit = internals(host).audits[0];
    expect(audit.ceremonyAttempts).toBeLessThanOrEqual(3);
    // Each human is blamed at most once.
    const named = audit.restarts.flatMap((r) => r.seats);
    expect(new Set(named).size).toBe(named.length);
    for (const c of [a, b]) {
      expect(c.state.auditFailures).toEqual([]);
      expect(c.state.auditStatus).toBe('partial');
    }
  });
});

describe('a failed ceremony is recoverable', () => {
  /** A host whose own check fails once (a host bug), so it gives up on the deal and returns to the lobby. */
  function failOnce(code: string) {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock, code);
    const h = internals(host);
    const orig = h.checkCeremony.bind(host);
    let broken = false;
    h.checkCeremony = () => {
      if (!broken && h.phase === 'reveal' && h.seats.every((s) => s.secret)) {
        broken = true;
        h.seats[2].secret = makeSecret();
      }
      orig();
    };
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'P');
    c.join();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host.start();
    errors.mockRestore();
    expect(host.phase).toBe('lobby');
    expect(c.state.lastError).toMatch(/could not verify/);
    return { host, c, clock };
  }

  it('a start from a seated player deals the hand again', () => {
    const { host, c, clock } = failOnce('RF1');
    c.requestStart();
    expect(host.phase).toBe('playing');
    playOut(host, [c], clock);
    // The host abandoned a deal after every share was in: this seat cannot call that hand fair.
    expect(c.state.auditStatus).toBe('failed');
  });

  it('the next tick deals the hand again while a player is connected', () => {
    const { host, clock } = failOnce('RF2');
    host.tick();
    expect(host.phase).toBe('lobby');
    clock.now += 5_001;
    host.tick();
    expect(host.phase).toBe('playing');
  });
});

/**
 * A seat that drops keeps its clock, and its client holds the table to that on its own clock: the
 * table may move for the seat behind a dropped link only when the time the device was without one
 * is long enough for the seat's clock to have run out. The cases are the third assessment's
 * attacks on a modified server, and the honest tables that must not be mistaken for them.
 */
describe('a server that plays for a seat behind a dropped link (assessment probes)', () => {
  const TURN = 15_000;
  const BANK = 30_000;
  const CLOCKED = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
  const DOWN_EARLY = (turn: number) => `The table played for this seat while its connection was down, before its clock could have run out (turn ${turn})`;
  const UP_EARLY = (turn: number) => `The table played for this seat while it was connected and its clock had not run out (turn ${turn})`;
  const BANK_TAKEN = (turn: number) => `The table took time from this seat's time bank while its connection was down (turn ${turn})`;
  type StateMsg = Extract<HostMessage, { t: 'state' }>;
  interface Server {
    game: GameState | null;
    botTimerArmed: boolean;
    apply: (seat: number, action: NonNullable<ReturnType<typeof chooseAction>>, source: 'player' | 'bot' | 'timeout') => void;
    stateMsg: (seat: number) => HostMessage;
    runBots: () => void;
    afterHand: () => void;
  }
  let links = 0;

  /** One human at seat 0. `skew`: how far the device's clock is from the server's. `paced`: bot moves wait for `step()`. */
  function seat(code: string, opts: { rules?: typeof CLOCKED; skew?: number; paced?: boolean } = {}) {
    const clock = { now: 1_000_000, ahead: 0 };
    const hub = new LoopbackHub();
    const timers: Array<() => void> = [];
    const pace = opts.paced ? { botDelayMs: 600, schedule: (fn: () => void) => void timers.push(fn) } : {};
    const host = new TableHost(hub.create('host'), { roomCode: code, rules: opts.rules ?? CLOCKED, now: () => clock.now + clock.ahead, matchId: `m-${code}`, intermissionSeconds: 5, ...pace });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now + (opts.skew ?? 0) });
    c.join();
    host.start();
    const t = {
      clock,
      host,
      c,
      s: host as unknown as Server,
      owes: () => host.phase === 'playing' && !!c.localState() && legalActions(c.localState()!, 0).length > 0,
      discarding: () => t.owes() && legalActions(c.localState()!, 0).every((a) => a.type === 'discard'),
      act: () => c.act(chooseAction(c.localState()!, 0, { seed: 'p' })!),
      /** Run the next bot move that is waiting; false when none is. */
      step: () => {
        const f = timers.shift();
        if (f) f();
        return !!f;
      },
      /** Let time pass on both clocks, the server ticking every half second. */
      wait: (ms: number) => {
        for (let left = ms; left > 0; left -= 500) {
          clock.now += Math.min(500, left);
          host.tick();
        }
      },
      drop: () => (c as unknown as { link: Link }).link.close(),
      back: () => {
        c.rebind(transportLink(hub.create(`p0r${links++}`), 'host'));
        c.join();
      },
      /** The seat plays its own moves until `stop` says so (true: stopped there); false when the hand ended first. */
      playUntil: (stop: () => boolean) => {
        for (let guard = 0; guard < 6000 && host.phase === 'playing'; guard++) {
          if (stop()) return true;
          if (t.owes()) t.act();
          else if (!t.step()) t.wait(60_000);
        }
        return false;
      },
      finish: () => {
        t.playUntil(() => false);
        expect(host.phase).not.toBe('playing');
      },
      verdict: () => [c.state.auditStatus, c.state.auditFailures, c.state.auditCaveats],
    };
    return t;
  }
  /** Stops `playUntil` on the seat's `n`-th discard of the hand. */
  const nthDiscard = (t: ReturnType<typeof seat>, n: number) => {
    let seen = 0;
    let counted = -1;
    return () => {
      if (!t.discarding() || t.host.game!.turnCounter === counted) return false;
      counted = t.host.game!.turnCounter;
      return ++seen === n;
    };
  };
  const need = (cond: boolean) => {
    if (!cond) throw new Missed();
  };

  it.each([0, 5 * 3_600_000, -7 * 3_600_000])('a one-second drop with the seat played inside it fails the hand (device clock off by %i ms)', (skew) =>
    scenario(() => {
      const t = seat('DP1', { skew });
      need(t.playUntil(nthDiscard(t, 3)));
      const turn = t.host.game!.turnCounter;
      // The server closes the socket, plays the seat 150 ms later, and lets the player back in before a second is up.
      t.drop();
      t.clock.now += 150;
      t.s.apply(0, chooseAction(t.host.game!, 0)!, 'timeout');
      t.clock.now += 850;
      t.back();
      t.finish();
      expect(t.c.state.auditStatus).toBe('failed');
      expect(t.c.state.auditFailures).toContain(DOWN_EARLY(turn));
      expect(failureKey(DOWN_EARLY(turn))).toBe('playedWhileDown');
      expect(t.c.state.auditCaveats).toEqual([]);
    }));

  it.each(['zero', 'honest'] as const)('after a blip between turns the server cannot run the clock out early with the link up (time bank stated: %s)', (stated) =>
    scenario(() => {
      const t = seat(`BZ${stated}`);
      let forge = false;
      const orig = t.s.stateMsg.bind(t.host);
      t.s.stateMsg = (n) => {
        const m = orig(n) as StateMsg;
        return forge && n === 0 ? { ...m, timeBank: 0 } : m;
      };
      need(t.playUntil(nthDiscard(t, 3)));
      // The seat takes its time over this move: into its bank, by 5 s or by 20 s.
      const over = stated === 'zero' ? 5_000 : 20_000;
      t.wait(TURN + over);
      t.s.botTimerArmed = true;
      t.act();
      // The blip comes while the seat owes nothing. On its return the server states the bank: 0, or what is left of it.
      t.drop();
      t.clock.now += 800;
      forge = stated === 'zero';
      t.back();
      const returned = t.host.game!.turnCounter;
      t.s.botTimerArmed = false;
      t.s.runBots();
      // The seat's next discard, with no move of its own on the new link before it.
      need(t.host.phase === 'playing' && t.discarding());
      const turn = t.host.game!.turnCounter;
      // 200 ms into the turn the server stamps its frames far enough ahead for the clock to look spent, and plays.
      t.clock.now += 200;
      t.clock.ahead += TURN + (stated === 'zero' ? 0 : BANK - over) - 400;
      t.s.apply(0, chooseAction(t.host.game!, 0)!, 'timeout');
      t.finish();
      expect(t.c.state.auditStatus).toBe('failed');
      expect(t.c.state.auditFailures).toEqual(stated === 'zero' ? [UP_EARLY(turn), BANK_TAKEN(returned)] : [UP_EARLY(turn)]);
      expect(failureKey(BANK_TAKEN(returned))).toBe('bankTaken');
    }));

  it('the rest of a match played inside a two-second drop fails every hand of it', () => {
    const t = seat('RM1', { rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }) });
    t.finish();
    expect(t.host.phase).toBe('hand_over');
    expect(t.verdict()).toEqual(['ok', [], []]);
    t.drop();
    // The server deals and plays every remaining hand on its own clock, the seat's turns with them.
    for (let guard = 0; guard < 20_000 && t.host.phase !== 'match_over'; guard++) {
      if (t.host.phase === 'hand_over') t.s.afterHand();
      else {
        t.clock.ahead += 60_000;
        t.host.tick();
      }
    }
    expect(t.host.phase).toBe('match_over');
    t.clock.now += 2_000;
    t.back();
    const missed = t.c.state.audits.filter((a) => a.audit.handNumber > 0 && a.caveats.includes(AUDIT_CAVEATS.away));
    expect(missed.length).toBeGreaterThan(0);
    for (const a of missed) {
      expect(a.status).toBe('failed');
      expect(a.failures.map(failureKey)).toContain('playedWhileDown');
    }
    expect(t.c.state.auditStatus).toBe('failed');
  });

  it.each([0, -7 * 3_600_000])('honest: a seat away for longer than its clock is timed out, and the hand is amber with the reason (device clock off by %i ms)', (skew) =>
    scenario(() => {
      const t = seat('LD1', { skew, paced: true });
      need(t.playUntil(nthDiscard(t, 2)));
      t.drop();
      t.wait(TURN + BANK + 1_000);
      // The table plays a few more of the seat's turns before its player is back.
      for (let i = 0; i < 12; i++) t.step();
      need(t.host.phase === 'playing');
      t.back();
      t.finish();
      expect(t.verdict()).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }));

  it('honest: back 700 ms after its clock ran out, the seat is not mistaken for one played early', () =>
    scenario(() => {
      const t = seat('LD2', { paced: true });
      need(t.playUntil(nthDiscard(t, 2)));
      t.wait(10_000);
      t.drop();
      t.wait(TURN + BANK - 10_000 + 500);
      need(t.host.game!.actionLog.some((e) => e.seat === 0 && e.source === 'auto'));
      t.clock.now += 700;
      t.back();
      t.finish();
      expect(t.verdict()).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }));

  it('honest: a hand that ends while the seat is away is amber when its result reaches the returning seat', () =>
    scenario(() => {
      const t = seat('LD3', { rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }) });
      need(t.playUntil(nthDiscard(t, 2)));
      t.drop();
      t.wait(TURN + BANK + 1_000);
      expect(t.host.phase).toBe('hand_over');
      t.clock.now += 90_000;
      t.back();
      const first = t.c.state.audits[0];
      expect([first.status, first.failures, first.caveats]).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }));

  it('honest: a player who leaves on purpose is played at once, and coming straight back does not fail the hand', () =>
    scenario(() => {
      const t = seat('LV1', { paced: true });
      need(t.playUntil(nthDiscard(t, 2)));
      t.c.leave();
      for (let i = 0; i < 6; i++) t.step();
      need(t.host.phase === 'playing' && t.host.game!.actionLog.some((e) => e.seat === 0 && e.source === 'auto'));
      t.clock.now += 1_000;
      t.back();
      t.finish();
      expect(t.verdict()).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }));
});

function seedOf(h: HostInternals, reveals: Array<{ seat: number; secret: string }>): string {
  return deriveSeed(`${h.matchId}:${h.snapshot.handNumber}`, reveals);
}
