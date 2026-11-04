import { describe, expect, it, vi } from 'vitest';
import { chooseAction, legalActions, withRules } from '@mjm/engine';
import { commitFor, LoopbackHub, makeSecret, MAX_CEREMONY_ATTEMPTS, TableClient, TableHost, transportLink, type HostEvent, type HostMessage, type SerializedHost } from '../src/index';

/** A raw peer that commits but never reveals (a phone that backgrounds mid-ceremony). */
function silentRevealer(hub: LoopbackHub, id: string, name: string) {
  const t = hub.create(id);
  const received: HostMessage[] = [];
  t.onMessage((_from, m) => {
    const msg = m as HostMessage;
    received.push(msg);
    if (msg.t === 'commit_request') t.send('host', { t: 'commit', hash: commitFor(makeSecret()) });
  });
  t.send('host', { t: 'join', name });
  return { t, received };
}

function makeHost(hub: LoopbackHub, clock: { now: number }) {
  return new TableHost(hub.create('host'), { roomCode: 'CER', rules: withRules({ handsPerMatch: 1 }), now: () => clock.now, matchId: 'cer' });
}

describe('ceremony robustness', () => {
  it('a connected player who misses the reveal stays human, keeps receiving state, and the table never deadlocks', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock);
    const late = silentRevealer(hub, 'p0', 'Late');
    host.start();
    expect(host.phase).toBe('reveal');
    clock.now += 10_001;
    host.tick();
    // One restart: the host supplied the late seat's share and dealt.
    expect(host.phase).toBe('playing');
    const seat0 = host.seatInfo()[0];
    expect(seat0.isBot).toBe(false);
    expect(seat0.connected).toBe(true);
    expect(seat0.name).toBe('Late');
    const kinds = late.received.map((m) => m.t);
    expect(kinds).toContain('stand_in');
    expect(kinds.lastIndexOf('stand_in')).toBeGreaterThan(kinds.lastIndexOf('commit_request'));
    expect(kinds).toContain('state');
    // Bots never act for a connected human: the human's clock eventually times out instead.
    let guard = 0;
    while (host.phase === 'playing' && guard++ < 500) {
      clock.now += 60_000;
      host.tick();
    }
    expect(host.phase).toBe('hand_over');
    expect(late.received.some((m) => m.t === 'hand_over')).toBe(true);
    const audit = host.audits[host.audits.length - 1];
    expect(audit.ceremonyAttempts).toBe(2);
    expect(audit.restarts).toEqual([{ attempt: 1, seats: [0], cause: 'no_reveal' }]);
    expect(audit.restartReasons[0]).toMatch(/seat 1 did not reveal/);
    // The hand_over intermission still expires because a human is connected.
    expect(host.nextDeadline()).not.toBeNull();
  });

  it('a late revealer does not cause an honest second player to be stood in, and the honest player audits OK', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock);
    silentRevealer(hub, 'p0', 'Late');
    const honest = new TableClient(transportLink(hub.create('p1'), 'host'), 'Honest');
    honest.join();
    host.start();
    clock.now += 10_001;
    host.tick();
    expect(host.phase).toBe('playing');
    expect(honest.state.standIn).toBe(false);
    // Finish the hand: the honest player acts, the late player times out.
    let guard = 0;
    while (host.phase === 'playing' && guard++ < 3000) {
      const s = honest.localState();
      if (s && legalActions(s, 1).length > 0) honest.act(chooseAction(s, 1)!);
      else {
        clock.now += 60_000;
        host.tick();
      }
    }
    expect(host.phase).toBe('hand_over');
    expect(honest.state.auditStatus).toBe('ok');
    expect(honest.state.auditFailures).toEqual([]);
  });

  it('a stood-in player still audits OK (its own secret is simply not checked)', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock);
    // A real client whose reveal is dropped once: intercept the first reveal.
    const t = hub.create('p0');
    const originalSend = t.send.bind(t);
    let dropped = false;
    t.send = (to: string, msg: unknown) => {
      if (!dropped && (msg as { t?: string }).t === 'reveal') {
        dropped = true;
        return;
      }
      originalSend(to, msg);
    };
    const c = new TableClient(transportLink(t, 'host'), 'Flaky');
    c.join();
    host.start();
    clock.now += 10_001;
    host.tick();
    expect(host.phase).toBe('playing');
    expect(c.state.standIn).toBe(true);
    let guard = 0;
    while (host.phase === 'playing' && guard++ < 3000) {
      const s = c.localState();
      if (s && legalActions(s, 0).length > 0) c.act(chooseAction(s, 0)!);
    }
    expect(c.state.auditStatus).toBe('ok');
  });
});

/** A raw peer that commits automatically and reveals only when told to (it keeps its secret in `secret`). */
function manualPeer(hub: LoopbackHub, id: string, name: string, opts: { autoCommit?: boolean; token?: string; secret?: string } = {}) {
  const t = hub.create(id);
  const received: HostMessage[] = [];
  const peer = { t, received, secret: opts.secret ?? '', token: '' };
  t.onMessage((_from, m) => {
    const msg = m as HostMessage;
    received.push(msg);
    if (msg.t === 'welcome') peer.token = msg.token;
    if (msg.t === 'commit_request' && opts.autoCommit !== false) {
      peer.secret = makeSecret();
      t.send('host', { t: 'commit', hash: commitFor(peer.secret) });
    }
    if (msg.t === 'reveal_request' && peer.secret) t.send('host', { t: 'reveal', secret: peer.secret });
  });
  t.send('host', { t: 'join', name, token: opts.token });
  return peer;
}

describe('ceremony accounting on the host', () => {
  it('a seat that returns during the reveal phase gets the commitments before the reveal request', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock);
    const a = manualPeer(hub, 'pa', 'A', { autoCommit: false });
    const b = manualPeer(hub, 'pb', 'B');
    host.start();
    expect(host.phase).toBe('commit');
    // B committed, then its connection dropped before the reveal phase began.
    const bSecret = b.secret;
    b.t.close();
    a.secret = makeSecret();
    a.t.send('host', { t: 'commit', hash: commitFor(a.secret) });
    expect(host.phase).toBe('reveal');
    const back = manualPeer(hub, 'pb2', 'B', { token: b.token, secret: bSecret });
    const kinds = back.received.map((m) => m.t);
    expect(kinds.indexOf('commits')).toBeGreaterThan(-1);
    expect(kinds.indexOf('commits')).toBeLessThan(kinds.indexOf('reveal_request'));
    expect(host.phase).toBe('playing');
    expect(host.serialize().ceremonyAttempts).toBe(1);
  });

  it('a share that fails the host’s own check ends the ceremony without blaming any seat', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock);
    const h = host as unknown as { checkCeremony: () => void; phase: string; seats: Array<{ secret?: string }> };
    const orig = h.checkCeremony.bind(host);
    h.checkCeremony = () => {
      // A host bug: a bot's stored share no longer matches its commitment.
      if (h.phase === 'reveal' && h.seats.every((s) => s.secret)) h.seats[2].secret = makeSecret();
      orig();
    };
    const p = manualPeer(hub, 'p0', 'P');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host.start();
    errors.mockRestore();
    expect(host.phase).toBe('lobby');
    const failed = p.received.find((m) => m.t === 'error') as Extract<HostMessage, { t: 'error' }>;
    expect(failed.code).toBe('ceremony_failed');
    expect(p.received.filter((m) => m.t === 'commit_request')).toHaveLength(1);
    expect(host.serialize().restarts).toEqual([]);
  });

  it(`gives up after ${MAX_CEREMONY_ATTEMPTS} attempts at one hand and returns to the lobby`, () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock);
    const p = silentRevealer(hub, 'p0', 'Stuck');
    host.start();
    const restart = (host as unknown as { restartCeremony: (late: unknown[], cause: string) => void }).restartCeremony.bind(host);
    for (let i = 1; i < MAX_CEREMONY_ATTEMPTS; i++) restart([], 'no_reveal');
    expect(host.phase).toBe('reveal');
    expect(host.serialize().ceremonyAttempts).toBe(MAX_CEREMONY_ATTEMPTS);
    restart([], 'no_reveal');
    expect(host.phase).toBe('lobby');
    expect(p.received.filter((m) => m.t === 'commit_request')).toHaveLength(MAX_CEREMONY_ATTEMPTS);
    expect(p.received.some((m) => m.t === 'error' && m.code === 'ceremony_failed')).toBe(true);
  });

  it('counts hands won per seat and reports the result on hand_over events', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'HW', rules: withRules({ handsPerMatch: 2 }), now: () => clock.now, matchId: 'hw' });
    const events: HostEvent[] = [];
    host.onEvent((e) => events.push(e));
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Watcher');
    c.join();
    host.start();
    let wins = 0;
    let guard = 0;
    while (host.phase !== 'match_over' && guard++ < 20_000) {
      const s = c.localState();
      if (host.phase === 'hand_over') {
        wins += c.state.lastResult!.wins.length;
        c.ready();
      } else if (s && host.phase === 'playing' && legalActions(s, 0).length > 0) c.act(chooseAction(s, 0)!);
      else {
        clock.now += 60_000;
        host.tick();
      }
    }
    expect(host.phase).toBe('match_over');
    const handOvers = events.filter((e) => e.type === 'hand_over');
    expect(handOvers.length).toBeGreaterThan(1);
    for (const e of handOvers) expect(e.result).toBeDefined();
    const last = events[events.length - 1];
    expect(last.handsWon.reduce((x, y) => x + y, 0)).toBe(wins);
    expect(host.handsWon()).toEqual(last.handsWon);
    expect(handOvers.reduce((n, e) => n + e.result!.wins.length, 0)).toBe(wins);
  });

  it('refuses to restore a snapshot of an unknown version', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'V', rules: withRules({ handsPerMatch: 1 }) });
    const snap = { ...host.serialize(), version: 2 } as unknown as SerializedHost;
    expect(() => new TableHost(new LoopbackHub().create('host'), { roomCode: 'V', restore: snap })).toThrow(/version/);
  });
});

describe('seat ownership', () => {
  it('a vacated lobby seat gets a fresh token; the previous occupant cannot reclaim it', () => {
    const hub = new LoopbackHub();
    new TableHost(hub.create('host'), { roomCode: 'TOK', rules: withRules({ handsPerMatch: 1 }) });
    const t0 = hub.create('p0');
    const first = new TableClient(transportLink(t0, 'host'), 'First');
    first.join();
    const oldToken = first.state.token!;
    expect(first.state.seat).toBe(0);
    t0.close();
    const second = new TableClient(transportLink(hub.create('p1'), 'host'), 'Second');
    second.join();
    expect(second.state.seat).toBe(0);
    expect(second.state.token).not.toBe(oldToken);
    const back = new TableClient(transportLink(hub.create('p0b'), 'host'), 'First', undefined, { token: oldToken });
    back.join();
    expect(back.state.seat).not.toBe(0);
    expect(second.state.disconnected).toBe(false);
  });

  it('a host restored mid-ceremony only lets token holders sit, and ignores start/add_bot until they return', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const host = makeHost(hub, clock);
    const late = silentRevealer(hub, 'p0', 'Owner');
    host.start();
    expect(host.phase).toBe('reveal');
    const welcome = late.received.find((m) => m.t === 'welcome') as Extract<HostMessage, { t: 'welcome' }>;
    const snapshot: SerializedHost = JSON.parse(JSON.stringify(host.serialize()));
    host.close();
    const hub2 = new LoopbackHub();
    const restored = new TableHost(hub2.create('host'), { roomCode: 'x', restore: snapshot, now: () => clock.now });
    const stranger = new TableClient(transportLink(hub2.create('s'), 'host'), 'Stranger');
    stranger.join();
    expect(stranger.state.seat).toBeNull();
    stranger.requestStart();
    stranger.requestBot();
    expect(restored.phase).toBe('lobby');
    const owner = new TableClient(transportLink(hub2.create('o'), 'host'), 'Owner', undefined, { token: welcome.token });
    owner.join();
    expect(owner.state.seat).toBe(0);
    expect(restored.phase).toBe('playing');
    // The interrupted ceremony stays on the record for this hand.
    const after = restored.serialize();
    expect(after.ceremonyAttempts).toBe(2);
    expect(after.restarts).toEqual([{ attempt: 1, seats: [], cause: 'host_restarted' }]);
  });

  it('rejoining after the match ended shows the final scores', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'END', rules: withRules({ handsPerMatch: 1 }) });
    const t = hub.create('p0');
    const c = new TableClient(transportLink(t, 'host'), 'Ender');
    c.join();
    host.start();
    let guard = 0;
    while (host.phase !== 'match_over' && guard++ < 5000) {
      const s = c.localState();
      if (host.phase === 'hand_over') c.ready();
      else if (s && legalActions(s, 0).length > 0) c.act(chooseAction(s, 0)!);
    }
    expect(host.phase).toBe('match_over');
    const token = c.state.token!;
    t.close();
    const again = new TableClient(transportLink(hub.create('p0b'), 'host'), 'Ender', undefined, { token });
    again.join();
    expect(again.state.matchOver).toBe(true);
    expect(again.state.finalScores).not.toBeNull();
  });
});
