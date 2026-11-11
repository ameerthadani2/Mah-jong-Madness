import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { LoopbackHub, TableHost, type HostMessage } from '../src/index';

/** A raw peer that records what the host sends it. */
function peer(hub: LoopbackHub, id: string) {
  const t = hub.create(id);
  const received: HostMessage[] = [];
  t.onMessage((_from, m) => received.push(m as HostMessage));
  return { t, received, send: (msg: unknown) => t.send('host', msg) };
}

const welcome = (received: HostMessage[]) => received.find((m): m is Extract<HostMessage, { t: 'welcome' }> => m.t === 'welcome');
const errors = (received: HostMessage[]) => received.filter((m): m is Extract<HostMessage, { t: 'error' }> => m.t === 'error');

function makeHost(hub: LoopbackHub) {
  return new TableHost(hub.create('host'), { roomCode: 'SEAT', rules: withRules({ handsPerMatch: 1 }), matchId: 'seat' });
}

describe('one seat per account', () => {
  it('refuses a second seat to an account that already holds one (already_seated)', () => {
    const hub = new LoopbackHub();
    const host = makeHost(hub);
    const a = peer(hub, 'p0');
    const b = peer(hub, 'p1');
    a.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
    b.send({ t: 'join', name: 'Alice again', userId: 'alice-1' });
    expect(welcome(a.received)?.seat).toBe(0);
    expect(welcome(b.received)).toBeUndefined();
    expect(errors(b.received).map((e) => e.code)).toEqual(['already_seated']);
    expect(host.seatInfo().filter((s) => s.userId === 'alice-1')).toHaveLength(1);
    // Another account still sits.
    const c = peer(hub, 'p2');
    c.send({ t: 'join', name: 'Carol', userId: 'carol-1' });
    expect(welcome(c.received)?.seat).toBe(1);
  });

  it('a rejoin token cannot bind a second seat to an account seated elsewhere', () => {
    const hub = new LoopbackHub();
    const host = makeHost(hub);
    const a = peer(hub, 'p0');
    const b = peer(hub, 'p1');
    a.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
    b.send({ t: 'join', name: 'Bob', userId: 'bobby-1' });
    host.start();
    const bobToken = welcome(b.received)!.token;
    // Bob's token, presented by Alice's account (a second device on Alice's account that learnt it).
    const x = peer(hub, 'p9');
    x.send({ t: 'join', name: 'Alice', userId: 'alice-1', token: bobToken });
    expect(errors(x.received).map((e) => e.code)).toEqual(['already_seated']);
    expect(host.seatInfo()[1].userId).toBe('bobby-1');
    expect(host.seatInfo()[1].connected).toBe(true);
    // Bob himself rejoining his own seat with his token is fine.
    const b2 = peer(hub, 'p1b');
    b2.send({ t: 'join', name: 'Bob', userId: 'bobby-1', token: bobToken });
    expect(welcome(b2.received)?.seat).toBe(1);
  });

  it('the same account rejoining its own seat with its token is not refused', () => {
    const hub = new LoopbackHub();
    const host = makeHost(hub);
    const a = peer(hub, 'p0');
    a.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
    host.start();
    const token = welcome(a.received)!.token;
    a.t.close();
    const a2 = peer(hub, 'p0b');
    a2.send({ t: 'join', name: 'Alice', userId: 'alice-1', token });
    expect(welcome(a2.received)?.seat).toBe(0);
    expect(errors(a2.received)).toEqual([]);
  });
});

describe('free text at the table', () => {
  it('cleans seat names, and relays only quick-phrase ids and emote ids', () => {
    const hub = new LoopbackHub();
    makeHost(hub);
    const a = peer(hub, 'p0');
    const b = peer(hub, 'p1');
    const rlo = String.fromCodePoint(0x202e);
    const nul = String.fromCodePoint(0);
    const zwsp = String.fromCodePoint(0x200b);
    a.send({ t: 'join', name: `${rlo}Evil${nul}  Name that is far too long for a seat`, userId: 'alice-1' });
    b.send({ t: 'join', name: zwsp, userId: 'bobby-1' });
    const seats = welcome(b.received)!.seats;
    expect(seats[0].name).toBe('Evil Name that is far to');
    expect([...seats[0].name].length).toBeLessThanOrEqual(24);
    // A name that cleans to nothing falls back to the seat label.
    expect(seats[1].name).toBe('Player 2');

    // No free text: a chat frame that is not a quick-phrase id reaches nobody, however it is dressed up.
    b.received.length = 0;
    for (const text of ['Official support: verify your account at http://evil.example/login', `hi${nul}\nthere ${rlo}`, 'gg ', 'GG', `${zwsp}${nul}`, '', 'constructor', 7, null, ['gg'], { id: 'gg' }]) {
      a.send({ t: 'chat', text: text as string });
    }
    expect(b.received.filter((m) => m.t === 'chat')).toEqual([]);
    a.send({ t: 'chat', text: 'gg' });
    expect(b.received.filter((m) => m.t === 'chat')).toEqual([{ t: 'chat', seat: 0, name: 'Evil Name that is far to', text: 'gg' }]);

    // Emotes likewise: only a known id, free or from a pack.
    b.received.length = 0;
    for (const emote of [`wave${rlo}${nul}-and-a-very-long-tail`, 'http://evil.example', 'toString', 'zd.unicorn', '', 5, null]) {
      a.send({ t: 'emote', emote: emote as string });
    }
    expect(b.received.filter((m) => m.t === 'emote')).toEqual([]);
    a.send({ t: 'emote', emote: 'thumbs' });
    expect(b.received.filter((m) => m.t === 'emote')).toEqual([{ t: 'emote', seat: 0, emote: 'thumbs' }]);
  });
});
