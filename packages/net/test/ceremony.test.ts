import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules } from '@mjm/engine';
import { commitFor, LoopbackHub, makeSecret, TableClient, TableHost, transportLink, type HostMessage, type SerializedHost } from '../src/index';

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
    expect(audit.restartReasons[0]).toMatch(/did not reveal/);
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
