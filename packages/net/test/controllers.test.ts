/**
 * Table controllers (only the opener or a club admin adds bots and starts) and evicting a seat:
 * the hooks the game server uses for club owner tools.
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { LoopbackHub, TableHost, type HostMessage } from '../src/index';

function peer(hub: LoopbackHub, id: string) {
  const t = hub.create(id);
  const received: HostMessage[] = [];
  t.onMessage((_from, m) => received.push(m as HostMessage));
  return { t, received, send: (msg: unknown) => t.send('host', msg) };
}

const errors = (received: HostMessage[]) => received.filter((m): m is Extract<HostMessage, { t: 'error' }> => m.t === 'error');
const welcome = (received: HostMessage[]) => received.find((m): m is Extract<HostMessage, { t: 'welcome' }> => m.t === 'welcome');

function table(isController?: (userId: string | undefined) => boolean) {
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: 'CTRL', rules: withRules({ handsPerMatch: 1 }), matchId: 'ctrl', isController });
  return { hub, host };
}

describe('table controllers', () => {
  it('refuses add_bot and start from a seated player who is not a controller (not_controller)', () => {
    const roles = new Set(['opener-1']);
    const { hub, host } = table((u) => !!u && roles.has(u));
    const opener = peer(hub, 'p0');
    const guest = peer(hub, 'p1');
    opener.send({ t: 'join', name: 'Opener', userId: 'opener-1' });
    guest.send({ t: 'join', name: 'Guest', userId: 'guest-22' });
    guest.send({ t: 'add_bot' });
    guest.send({ t: 'start' });
    expect(errors(guest.received).map((e) => e.code)).toEqual(['not_controller', 'not_controller']);
    expect(host.seatInfo().filter((s) => s.isBot)).toHaveLength(0);
    expect(host.phase).toBe('lobby');
    // The opener may.
    opener.send({ t: 'add_bot' });
    expect(host.seatInfo().filter((s) => s.isBot)).toHaveLength(1);
    // A role granted later (a new club admin) applies at once.
    roles.add('guest-22');
    guest.send({ t: 'start' });
    expect(host.phase).not.toBe('lobby');
  });

  it('lets any seated player start once no controller is connected at the table', () => {
    const { hub, host } = table((u) => u === 'opener-1');
    const opener = peer(hub, 'p0');
    const guest = peer(hub, 'p1');
    opener.send({ t: 'join', name: 'Opener', userId: 'opener-1' });
    guest.send({ t: 'join', name: 'Guest', userId: 'guest-22' });
    opener.t.close();
    guest.send({ t: 'add_bot' });
    expect(errors(guest.received)).toEqual([]);
    expect(host.seatInfo().filter((s) => s.isBot)).toHaveLength(1);
  });

  it('without controllers every seated player may add bots and start (local play)', () => {
    const { hub, host } = table();
    const a = peer(hub, 'p0');
    a.send({ t: 'join', name: 'A', userId: 'someone-1' });
    a.send({ t: 'start' });
    expect(errors(a.received)).toEqual([]);
    expect(host.phase).not.toBe('lobby');
  });
});

describe('evicting a seat', () => {
  it('frees a lobby seat and tells the player', () => {
    const { hub, host } = table();
    const a = peer(hub, 'p0');
    const b = peer(hub, 'p1');
    a.send({ t: 'join', name: 'A', userId: 'alice-1' });
    b.send({ t: 'join', name: 'B', userId: 'bobby-1' });
    expect(host.evictUser('bobby-1', 'Removed.')).toEqual([1]);
    expect(errors(b.received)).toEqual([{ t: 'error', code: 'evicted', message: 'Removed.' }]);
    expect(host.seatInfo()[1]).toMatchObject({ name: '', userId: undefined, connected: false, isBot: false, peerId: null });
    // Anyone may take the freed seat.
    const c = peer(hub, 'p2');
    c.send({ t: 'join', name: 'C', userId: 'carol-1' });
    expect(welcome(c.received)?.seat).toBe(1);
  });

  it('mid-match the bot plays the seat to the end, keeps the bot set, and the old token no longer reclaims it', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'EVCT', rules: withRules({ handsPerMatch: 1 }), matchId: 'evct' });
    const a = peer(hub, 'p0');
    const b = peer(hub, 'p1');
    a.send({ t: 'join', name: 'A', userId: 'alice-1' });
    b.send({ t: 'join', name: 'B', userId: 'bobby-1' });
    const token = welcome(b.received)!.token;
    host.start();
    const botsBefore = host.seatInfo().map((s) => s.isBot);
    host.evictUser('bobby-1');
    const s1 = host.seatInfo()[1];
    expect(s1).toMatchObject({ userId: undefined, connected: false, left: true, isBot: false });
    expect(s1.name).toMatch(/Bot/);
    expect(host.seatInfo().map((s) => s.isBot)).toEqual(botsBefore);
    expect(errors(b.received).map((e) => e.code)).toEqual(['evicted']);
    // The old token is void: presenting it again gets no seat back.
    const b2 = peer(hub, 'p1b');
    b2.send({ t: 'join', name: 'B', userId: 'bobby-1', token });
    expect(welcome(b2.received)).toBeUndefined();
    expect(host.seatInfo()[1].userId).toBeUndefined();
  });

  it('notifySeated reaches every connected human', () => {
    const { hub, host } = table();
    const a = peer(hub, 'p0');
    a.send({ t: 'join', name: 'A', userId: 'alice-1' });
    host.notifySeated({ t: 'error', code: 'table_closed', message: 'Closed.' });
    expect(errors(a.received)).toEqual([{ t: 'error', code: 'table_closed', message: 'Closed.' }]);
  });
});
