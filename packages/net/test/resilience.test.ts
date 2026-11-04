import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink, type SerializedHost } from '../src/index';

function stepHumans(host: TableHost, clients: TableClient[], max = 3000): void {
  let guard = 0;
  while (host.phase === 'playing' && guard++ < max) {
    let acted = false;
    for (const c of clients) {
      const s = c.localState();
      if (!s || c.state.seat === null || !c.state.connected) continue;
      if (legalActions(s, c.state.seat).length === 0) continue;
      const a = chooseAction(s, c.state.seat, { seed: `h${c.state.seat}` });
      if (a) {
        c.act(a);
        acted = true;
        break;
      }
    }
    if (!acted) break;
  }
}

describe('time bank', () => {
  it('moves into the bank after the base clock and auto-plays when the bank is empty', () => {
    let now = 1_000_000;
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'TB', rules: withRules({ handsPerMatch: 1, turnSeconds: 5, timeBankSeconds: 10 }), now: () => now });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Slow');
    c.join();
    host.start();
    // Wait until it is our move
    let guard = 0;
    while (legalActions(c.localState()!, 0).length === 0 && guard++ < 10) {
      now += 100;
      host.tick();
    }
    expect(legalActions(c.localState()!, 0).length).toBeGreaterThan(0);
    expect(c.state.timeBank).toBe(10);
    expect(c.state.inTimeBank).toBe(false);
    const hashBefore = c.state.stateHash;
    now += 5_100; // base clock expires
    host.tick();
    expect(c.state.inTimeBank).toBe(true);
    expect(c.state.stateHash).toBe(hashBefore); // no auto-play yet
    expect(c.state.deadline).toBeGreaterThan(now);
    now += 10_100; // bank exhausted
    host.tick();
    expect(c.state.inTimeBank).toBe(false);
    expect(c.state.timeBank).toBe(0);
    expect(c.state.stateHash).not.toBe(hashBefore); // bot acted for us
  });

  it('charges the bank for time used past the base clock when the player acts', () => {
    let now = 1_000_000;
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'TB2', rules: withRules({ handsPerMatch: 1, turnSeconds: 5, timeBankSeconds: 20 }), now: () => now });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Thinker');
    c.join();
    host.start();
    now += 5_000 + 4_000; // 4 s into the bank
    host.tick();
    expect(c.state.inTimeBank).toBe(true);
    const s = c.localState()!;
    c.act(chooseAction(s, 0)!);
    // Next time our clock arms, the bank should show ~16 s
    let guard = 0;
    while (legalActions(c.localState()!, 0).length === 0 && guard++ < 50) {
      now += 50;
      host.tick();
    }
    expect(c.state.timeBank).toBeLessThanOrEqual(16);
    expect(c.state.timeBank).toBeGreaterThanOrEqual(15);
  });
});

describe('crash recovery', () => {
  it('a client reclaims its seat with the rejoin token after a bot stood in', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'RJ', rules: withRules({ handsPerMatch: 1 }) });
    const t0 = hub.create('p0');
    const c0 = new TableClient(transportLink(t0, 'host'), 'Alice');
    c0.join();
    host.start();
    const token = c0.state.token!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // Crash: transport disappears mid-hand. Bots finish the hand, then the table pauses for Alice.
    t0.close();
    expect(host.phase).toBe('hand_over');
    expect(host.nextDeadline()).toBeNull();
    host.tick();
    expect(host.phase).toBe('hand_over');
    // New device/process rejoins with the token under a different name.
    const c0b = new TableClient(transportLink(hub.create('p0b'), 'host'), 'Alice-on-new-phone', undefined, { token });
    c0b.join();
    expect(c0b.state.seat).toBe(0);
    expect(c0b.state.view).not.toBeNull();
    expect(c0b.state.lastResult).not.toBeNull();
    expect(host.nextDeadline()).not.toBeNull();
    c0b.ready();
    expect(['playing', 'match_over']).toContain(host.phase);
    if (host.phase === 'playing') stepHumans(host, [c0b]);
    expect(['hand_over', 'match_over']).toContain(host.phase);
  });

  it('the host can be serialised mid-hand and restored in a new process; the audit still verifies', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'SR', rules: withRules({ handsPerMatch: 1 }), matchId: 'persist' });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Bob');
    c.join();
    host.start();
    // Make a couple of moves
    for (let i = 0; i < 3 && host.phase === 'playing'; i++) {
      const s = c.localState()!;
      if (legalActions(s, 0).length > 0) c.act(chooseAction(s, 0)!);
    }
    const token = c.state.token!;
    const snapshot: SerializedHost = JSON.parse(JSON.stringify(host.serialize()));
    host.close();

    // "App restarts": brand-new hub, host restored from the snapshot, client rejoins with token.
    const hub2 = new LoopbackHub();
    const host2 = new TableHost(hub2.create('host'), { roomCode: 'ignored', restore: snapshot });
    expect(host2.roomCode).toBe('SR');
    expect(host2.matchId).toBe('persist');
    const c2 = new TableClient(transportLink(hub2.create('p0'), 'host'), 'Bob', undefined, { token });
    c2.join();
    expect(c2.state.seat).toBe(0);
    expect(c2.state.view).not.toBeNull();
    stepHumans(host2, [c2]);
    expect(host2.phase).toBe('hand_over');
    expect(c2.state.lastResult).not.toBeNull();
    // Replay from the hand snapshot must still match the host's final hash, even though this client missed the start.
    // Its share was not part of this deal, so the hand verifies as partial rather than ok.
    expect(c2.state.auditFailures).toEqual([]);
    expect(c2.state.auditStatus).toBe('partial');
    expect(c2.state.auditCaveats).toEqual(['Joined during this hand; log verified, share not used']);
  });
});
