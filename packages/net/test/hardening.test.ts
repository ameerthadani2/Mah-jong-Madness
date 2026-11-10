import { describe, expect, it } from 'vitest';
import { withRules, type TableView } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink, type Audit } from '../src/index';

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
    // It arrived after the deal: the log verifies but its share was never part of the seed.
    expect(c2.state.auditStatus).toBe('partial');
    expect(c2.state.auditFailures).toEqual([]);
    expect(c2.state.auditCaveats).toEqual(['Joined during this hand; log verified, share not used']);
    const audit = c2.state.lastAudit!;
    const fakeResult = { ...c2.state.lastResult!, scoreDelta: [999, -999, 0, 0] };
    const res = c2.verifyAudit(audit, c2.state.view!, fakeResult);
    expect(res.status).toBe('failed');
    expect(res.failures.join(' ')).toMatch(/Announced result differs/);
  });
});

describe('client hardening', () => {
  it('junk state, hand_over, commits and match_over frames never throw and set lastError', () => {
    const hub = new LoopbackHub();
    // A fake host: a bare transport sending hand-crafted frames.
    const fake = hub.create('host');
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Target');
    fake.send('p0', { t: 'welcome', seat: 0, roomCode: 'J', rules: { basePoints: 'lots', evil: true }, seats: [], matchId: 'junk', token: 'f'.repeat(32) });
    expect(c.state.seat).toBe(0);
    expect(c.state.rules!.basePoints).toBeTypeOf('number');
    expect((c.state.rules as unknown as Record<string, unknown>).evil).toBeUndefined();
    const players = [0, 1, 2, 3].map(() => ({ handCount: 16, melds: [], flowers: [], discards: [] }));
    const view = { handNumber: 0, players, scores: [0, 0, 0, 0] };
    const junk: unknown[] = [
      { t: 'state' },
      { t: 'state', view: null },
      { t: 'state', view: { handNumber: 0, players: 'x', scores: [] } },
      { t: 'state', view: { handNumber: 0, players: [{}, {}], scores: [0, 0, 0, 0] } },
      { t: 'state', view: { handNumber: 0, players: [{}, {}, {}, {}], scores: [0, 0, 0, 0] } },
      { t: 'state', view: { ...view, players: players.map((p) => ({ ...p, handCount: 1e9 })) } },
      { t: 'hand_over' },
      { t: 'hand_over', view, result: {}, audit: { commits: 5 } },
      { t: 'hand_over', view, result: {}, audit: { handNumber: 0, seed: 's', commits: [], reveals: null, log: [] } },
      { t: 'commits', handNumber: 0, commits: 'x' },
      { t: 'commits', handNumber: 0, commits: [{ seat: 0, hash: 'zz' }, 1, 2, 3, 4] },
      { t: 'match_over', view: 7, scores: [0, 0, 0, 0] },
      { t: 'match_over', view, scores: 'none' },
    ];
    for (const frame of junk) {
      c.state.lastError = null;
      expect(() => fake.send('p0', frame)).not.toThrow();
      expect(c.state.lastError, JSON.stringify(frame)).not.toBeNull();
    }
    // Frames with no usable shape are ignored outright.
    for (const frame of [null, 5, 'x', {}, { t: 7 }, { t: 'stand_in' }, { t: 'reveal_request' }, { t: 'chat' }, { t: 'emote', emote: {} }, { t: 'pong' }]) {
      expect(() => fake.send('p0', frame)).not.toThrow();
    }
    expect(c.state.view).toBeNull();
    expect(c.state.matchOver).toBe(false);
    expect(c.state.chat).toEqual([]);
    // A malformed audit handed to the verifier is a failure, not an exception.
    const bad = c.verifyAudit({ handNumber: 0 } as unknown as Audit, view as unknown as TableView);
    expect(bad.status).toBe('failed');
    // An audit that passes the shape guard but holds junk share lists is checked (not thrown on) and fails.
    expect(() => fake.send('p0', { t: 'hand_over', view, result: {}, audit: { handNumber: 0, seed: 's', commits: [null], reveals: [null], log: [] } })).not.toThrow();
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Audit must list exactly one commitment for each of seats 0–4');
    expect(c.state.auditFailures).toContain('Audit must list exactly one secret for each of seats 0–4');
  });

  it('a client notices when its own transport closes', () => {
    let closed: (() => void) | null = null;
    const t = new LoopbackHub().create('p0');
    const wrapped = Object.assign(t, {
      onClose: (cb: () => void) => {
        closed = cb;
        return () => undefined;
      },
    });
    const c = new TableClient(transportLink(wrapped, 'host'), 'Me');
    expect(closed).not.toBeNull();
    closed!();
    expect(c.state.disconnected).toBe(true);
    expect(c.state.connected).toBe(false);
  });
});

describe('chat and emote limits', () => {
  it('lets each seat chat once a second with a burst of five, and emote once every two seconds', () => {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    new TableHost(hub.create('host'), { roomCode: 'CH', rules: withRules({ handsPerMatch: 1 }), now: () => clock.now });
    const loud = new TableClient(transportLink(hub.create('p0'), 'host'), 'Loud');
    const quiet = new TableClient(transportLink(hub.create('p1'), 'host'), 'Quiet');
    loud.join();
    quiet.join();
    const phrases = ['nice', 'sorry', 'gg', 'hurry', 'goodHand', 'dealtIn', 'oneMore', 'faster', 'nice', 'sorry'];
    for (const id of phrases) loud.chat(id);
    expect(quiet.state.chat.map((l) => l.text)).toEqual(phrases.slice(0, 5));
    // Another seat has its own allowance.
    quiet.chat('gg');
    expect(quiet.state.chat).toHaveLength(6);
    clock.now += 1_000;
    loud.chat('oneMore');
    loud.chat('faster');
    expect(quiet.state.chat.map((l) => l.text).slice(-2)).toEqual(['gg', 'oneMore']);
    loud.emote('thumbs');
    loud.emote('thumbs');
    expect(quiet.state.emotes).toHaveLength(1);
    clock.now += 1_000;
    loud.emote('thumbs');
    expect(quiet.state.emotes).toHaveLength(1);
    clock.now += 1_000;
    loud.emote('thumbs');
    expect(quiet.state.emotes).toHaveLength(2);
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
