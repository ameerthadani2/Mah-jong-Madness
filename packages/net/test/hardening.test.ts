import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink } from '../src/index';

describe('host hardening', () => {
  it('ignores malformed messages and never throws', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'H', rules: withRules({ handsPerMatch: 1 }) });
    const t = hub.create('p0');
    const junk = [null, 1, 'x', {}, { t: 5 }, { t: 'join' }, { t: 'join', name: 5, wantSeat: '__proto__' }, { t: 'action' }, { t: 'commit', hash: 'nope' }, { t: 'reveal', secret: 'x'.repeat(10_000) }, { t: 'chat' }, { t: 'emote', emote: 7 }];
    for (const j of junk) expect(() => t.send('host', j)).not.toThrow();
    expect((Array.prototype as unknown as { peerId?: unknown }).peerId).toBeUndefined();
    expect(host.phase).toBe('lobby');
    const c = new TableClient(transportLink(t, 'host'), 'Ok');
    c.join();
    expect(c.state.seat).toBe(0);
  });

  it('a guest can start a server-style table and add bots via requests', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'S', rules: withRules({ handsPerMatch: 1 }), fillWithBots: true });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Cap');
    c.join();
    c.requestBot();
    expect(c.state.seats.filter((s) => s.isBot)).toHaveLength(1);
    c.requestStart();
    expect(host.phase).toBe('playing');
    expect(c.state.view).not.toBeNull();
  });

  it('a stale peer id cannot be reused to take a seat after a disconnect', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'R', rules: withRules({ handsPerMatch: 1 }) });
    const t0 = hub.create('p0');
    const c0 = new TableClient(transportLink(t0, 'host'), 'Alice');
    c0.join();
    host.start();
    t0.close();
    // Attacker connects with the same transport id and no token.
    const evil = new TableClient(transportLink(hub.create('p0'), 'host'), 'Alice');
    evil.join();
    expect(evil.state.seat).toBeNull();
    expect(evil.state.lastError).toMatch(/in progress/);
  });

  it('flags a host that announces a different result than the replay produces', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'A', rules: withRules({ handsPerMatch: 1 }) });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Bob');
    c.join();
    host.start();
    // Let bots and timeouts finish the hand by disconnecting the human: the table pauses at hand_over.
    (hub as unknown as { nodes: Map<string, { close: () => void }> }).nodes.get('p0')!.close();
    expect(host.phase).toBe('hand_over');
    const token = c.state.token!;
    const c2 = new TableClient(transportLink(hub.create('p0b'), 'host'), 'Bob', undefined, { token });
    c2.join();
    expect(c2.state.auditStatus).toBe('ok');
    const audit = c2.state.lastAudit!;
    const fakeResult = { ...c2.state.lastResult!, scoreDelta: [999, -999, 0, 0] };
    const res = c2.verifyAudit(audit, c2.state.view!, fakeResult);
    expect(res.failures.join(' ')).toMatch(/Announced result differs/);
  });
});

describe('bot avatars', () => {
  it('bots never wear an avatar a player at the table already uses', () => {
    for (const mine of ['lady', 'uncle', 'shades', 'auntie', 'boss']) {
      const hub = new LoopbackHub();
      const host = new TableHost(hub.create('host'), { roomCode: 'AV', rules: withRules({ handsPerMatch: 1 }) });
      const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Me', mine);
      c.join();
      host.start();
      const avatars = host.seatInfo().map((s) => s.avatar);
      expect(new Set(avatars).size).toBe(4);
      expect(avatars.filter((a) => a === mine)).toHaveLength(1);
    }
  });
});
