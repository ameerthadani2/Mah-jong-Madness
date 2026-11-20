/**
 * Seat recovery by account. At a table the game server hosts, the user id in a join is the
 * account the server verified, so the account itself gets its seat back without the rejoin token
 * (a reinstalled app, another device). At a table a device hosts the id is only a claim, and the
 * rejoin token stays the one way back. In neither case does an account get another account's seat.
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { caveatKey, LoopbackHub, TableClient, TableHost, type HostMessage } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

/** A raw peer that records what the host sends it. */
function peer(hub: LoopbackHub, id: string) {
  const t = hub.create(id);
  const received: HostMessage[] = [];
  t.onMessage((_from, m) => received.push(m as HostMessage));
  return { t, received, send: (msg: unknown) => t.send('host', msg) };
}

const welcome = (received: HostMessage[]) => received.find((m): m is Extract<HostMessage, { t: 'welcome' }> => m.t === 'welcome');
const errors = (received: HostMessage[]) => received.filter((m): m is Extract<HostMessage, { t: 'error' }> => m.t === 'error').map((e) => e.code);
const has = (received: HostMessage[], t: HostMessage['t']) => received.some((m) => m.t === t);

/** A table with Alice and Bob seated and the match under way. */
function table(verifiedUserIds: boolean) {
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: 'SEAT', rules: withRules({ handsPerMatch: 1 }), matchId: 'seat', verifiedUserIds });
  const alice = peer(hub, 'a1');
  const bob = peer(hub, 'b1');
  alice.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
  bob.send({ t: 'join', name: 'Bob', userId: 'bobby-1' });
  host.start();
  expect(host.phase).not.toBe('lobby');
  return { hub, host, alice, bob, aliceToken: welcome(alice.received)!.token, bobToken: welcome(bob.received)!.token };
}

describe('at a table whose user ids are verified (hosted by the server)', () => {
  it('gives a disconnected seat back to its account without the rejoin token, with a new token', () => {
    const { hub, host, alice, aliceToken } = table(true);
    alice.t.close();
    expect(host.seatInfo()[0]).toMatchObject({ userId: 'alice-1', connected: false });
    // A reinstalled app: the same account, no token.
    const again = peer(hub, 'a2');
    again.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
    const w = welcome(again.received)!;
    expect(w.seat).toBe(0);
    expect(w.token).toMatch(/^[0-9a-f]{32}$/);
    expect(w.token).not.toBe(aliceToken);
    expect(errors(again.received)).toEqual([]);
    expect(host.seatInfo()[0]).toMatchObject({ userId: 'alice-1', connected: true, peerId: 'a2' });
    // The token that was lost no longer opens the seat for anyone else.
    const thief = peer(hub, 'x1');
    thief.send({ t: 'join', name: 'Mallory', userId: 'mallory-1', token: aliceToken });
    expect(welcome(thief.received)).toBeUndefined();
    expect(errors(thief.received)).toEqual(['full']);
    expect(host.seatInfo()[0]).toMatchObject({ userId: 'alice-1', peerId: 'a2' });
    // The new token works like any rejoin token.
    const third = peer(hub, 'a3');
    third.send({ t: 'join', name: 'Alice', userId: 'alice-1', token: w.token });
    expect(welcome(third.received)).toMatchObject({ seat: 0, token: w.token });
  });

  it('gives a connected seat to the newest connection of its account: the old one is told and dropped', () => {
    const { hub, host, alice } = table(true);
    const phone = peer(hub, 'a2');
    phone.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
    expect(welcome(phone.received)?.seat).toBe(0);
    expect(has(alice.received, 'disconnected')).toBe(true);
    expect(host.seatInfo()[0]).toMatchObject({ userId: 'alice-1', connected: true, peerId: 'a2' });
    // The table goes on for the new connection (it is sent where the hand stands), not for the old one.
    expect(phone.received.some((m) => m.t === 'state' || m.t === 'commit_request' || m.t === 'commits' || m.t === 'reveal_request')).toBe(true);
    const before = alice.received.length;
    alice.send({ t: 'ready' });
    expect(errors(alice.received.slice(before))).toEqual(['not_seated']);
  });

  it('takes a stale or foreign token as no token: the account still gets its own seat, never the token-less seat of another', () => {
    const { hub, host, alice, bob } = table(true);
    alice.t.close();
    const again = peer(hub, 'a2');
    again.send({ t: 'join', name: 'Alice', userId: 'alice-1', token: 'f'.repeat(32) });
    expect(welcome(again.received)?.seat).toBe(0);
    // Bob is connected; another account that names itself Bob gets nothing.
    const mallory = peer(hub, 'x1');
    mallory.send({ t: 'join', name: 'Bob', userId: 'mallory-1' });
    expect(welcome(mallory.received)).toBeUndefined();
    expect(errors(mallory.received)).toEqual(['full']);
    expect(has(bob.received, 'disconnected')).toBe(false);
    expect(host.seatInfo()[1]).toMatchObject({ userId: 'bobby-1', connected: true, peerId: 'b1' });
    // Nor does a join that carries no account at all.
    const nobody = peer(hub, 'x2');
    nobody.send({ t: 'join', name: 'Bob' });
    expect(errors(nobody.received)).toEqual(['full']);
  });

  it('gives back a seat its player left on purpose, and never one the account was taken off', () => {
    const { hub, host, alice, bob } = table(true);
    alice.send({ t: 'leave' });
    expect(host.seatInfo()[0]).toMatchObject({ userId: 'alice-1', connected: false, left: true });
    const back = peer(hub, 'a2');
    back.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
    expect(welcome(back.received)?.seat).toBe(0);
    expect(host.seatInfo()[0].left).toBeUndefined();
    // An evicted account's seat is no longer its own.
    host.evictUser('bobby-1');
    expect(has(bob.received, 'error')).toBe(true);
    const bobAgain = peer(hub, 'b2');
    bobAgain.send({ t: 'join', name: 'Bob', userId: 'bobby-1' });
    expect(welcome(bobAgain.received)).toBeUndefined();
    expect(errors(bobAgain.received)).toEqual(['full']);
  });

  it('never gives a bot seat to an account, whatever id it sends', () => {
    const { hub, host } = table(true);
    const botSeat = host.seatInfo().find((s) => s.isBot)!;
    const x = peer(hub, 'x1');
    x.send({ t: 'join', name: botSeat.name, userId: 'bot-seat-1' });
    expect(welcome(x.received)).toBeUndefined();
    expect(host.seatInfo()[botSeat.seat].isBot).toBe(true);
  });
});

describe('at a table a device hosts (user ids are only claims)', () => {
  it('never gives a seat back for a user id alone: the rejoin token is the only way', () => {
    const { hub, host, alice, bob, aliceToken } = table(false);
    alice.t.close();
    // Anyone can write Alice's public user id into a join.
    const claimant = peer(hub, 'x1');
    claimant.send({ t: 'join', name: 'Alice', userId: 'alice-1' });
    expect(welcome(claimant.received)).toBeUndefined();
    expect(errors(claimant.received)).toEqual(['full']);
    expect(host.seatInfo()[0]).toMatchObject({ userId: 'alice-1', connected: false });
    // Nor can it push a connected player off their seat.
    const second = peer(hub, 'x2');
    second.send({ t: 'join', name: 'Bob', userId: 'bobby-1' });
    expect(welcome(second.received)).toBeUndefined();
    expect(has(bob.received, 'disconnected')).toBe(false);
    expect(host.seatInfo()[1]).toMatchObject({ connected: true, peerId: 'b1' });
    // The token still works, and keeps its value.
    const back = peer(hub, 'a2');
    back.send({ t: 'join', name: 'Alice', userId: 'alice-1', token: aliceToken });
    expect(welcome(back.received)).toMatchObject({ seat: 0, token: aliceToken });
  });
});

/**
 * Normal, an honest server-hosted table of two hands, the phone's seat bound to an account. Hand 0 is played on one
 * device; once hand 1 is dealt and the seat owes nothing, that device's app closes and the account opens the table on
 * another: `fresh`, a client with neither the record nor the rejoin token (the account takes its seat back by itself, as
 * after a notification on another phone); `token`, a client with the rejoin token alone; `record`, the saved record and
 * token (Home's Resume on the same device).
 */
function takenBack(code: string, mode: 'fresh' | 'token' | 'record') {
  let moved = false;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
    botDelayMs: 700,
    intermissionSeconds: 5,
    onTick: (w) => {
      const g = w.host.game;
      if (moved || !g || g.handNumber !== 1 || w.host.phase !== 'playing' || w.owes() || w.c.state.view?.handNumber !== 1) return;
      moved = true;
      const token = w.c.state.token ?? undefined;
      const restore = TableClient.restore;
      TableClient.restore = (saved, link, name, avatar, _identity, opts) =>
        mode === 'fresh' ? new TableClient(link, name, avatar, { userId: 'acct-0' }, opts) : mode === 'token' ? new TableClient(link, name, avatar, { token, userId: 'acct-0' }, opts) : restore.call(TableClient, saved, link, name, avatar, { token, userId: 'acct-0' }, opts);
      try {
        w.restart();
      } finally {
        TableClient.restore = restore;
      }
    },
  });
  // The game server's table: a signed-in account takes its own seat back without a token.
  (w.host as unknown as { verifiedUserIds: boolean }).verifiedUserIds = true;
  (w.host as unknown as { seats: Array<{ userId?: string }> }).seats[0].userId = 'acct-0';
  w.finish();
  for (let k = 0; k < 600 && w.host.phase !== 'match_over'; k++) w.step();
  const hand1 = w.c.state.audits.find((a) => a.audit.handNumber === 1);
  return { w, moved, hand1 };
}

describe('a seat the account takes back with neither the record nor the token (another device, a notification)', () => {
  it('honest table: the first hand the new client is shown, hand 1, is amber (joined, its starting scores unchecked), never red; with the token alone the same; from the record, green', () =>
    scenario((i) => {
      const a = takenBack(`TBF${i}`, 'fresh');
      need(a.moved && !!a.hand1);
      expect(a.w.c.state.seat).toBe(0);
      expect(a.hand1!.status).toBe('partial');
      expect(a.hand1!.failures).toEqual([]);
      expect(a.hand1!.caveats.map(caveatKey)).toEqual(expect.arrayContaining(['joined', 'gap']));
      const b = takenBack(`TBF${i}`, 'token');
      need(b.moved && !!b.hand1);
      expect(b.hand1!.status).toBe('partial');
      expect(b.hand1!.caveats.map(caveatKey)).toEqual(expect.arrayContaining(['joined', 'gap']));
      const c = takenBack(`TBF${i}`, 'record');
      need(c.moved && !!c.hand1);
      expect(c.hand1!.status).toBe('ok');
    }));

  it('a client with neither a token nor a record that sits down in the lobby still holds the match’s first hand to a new match’s start', () => {
    const w = wire({ code: 'TBL', rules: withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 }), botDelayMs: 300 });
    w.finish();
    expect(w.c.state.audits[0]).toMatchObject({ status: 'ok', failures: [], caveats: [] });
    expect((w.c.serialize() as unknown as { chainGap?: boolean }).chainGap).toBe(false);
  });
});
