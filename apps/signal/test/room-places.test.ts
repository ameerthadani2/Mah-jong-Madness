/**
 * A player who holds a seat always gets back into the room, however many idle sockets other
 * people keep in it, and onlookers who hold no seat get only a few places (probe H: a griefer's
 * eight idle sockets took the place of a player who had dropped, and a bot played her hand).
 */
import { describe, expect, it } from 'vitest';
import { CLUB_MEMBERS_ONLY, ROOM_UNAVAILABLE, ROOM_UNAVAILABLE_CODE, RoomRegistry, WATCHER_DROPPED, type ClubGate, type Socket } from '../src/rooms';

type Out = { t: string; code?: string; message?: string; room?: string; data?: { ch?: string; msg?: { t?: string; seat?: number } } };

function setup(clubs?: ClubGate) {
  const clock = { now: 0 };
  const reg = new RoomRegistry({ allowHosted: true, botDelayMs: 0, now: () => clock.now, clubs });
  let n = 0;
  const socket = (userId: string) => {
    const out: Out[] = [];
    const s: Socket = { send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined };
    // A different address for each socket, so the per-address join allowance stays out of the way.
    // Account ids are UUIDs in production; the table accepts any 6 to 64 word characters.
    const id = reg.hello(reg.connect(s, `198.51.100.${++n}`), `user-${userId}`);
    return { id, out, last: () => out[out.length - 1] };
  };
  const toTable = (peer: string, code: string, msg: Record<string, unknown>) => reg.handle(peer, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg } });
  return { reg, clock, socket, toTable };
}

describe('places in a room', () => {
  it('lets a seated player back in when idle onlookers have filled the room', () => {
    const { reg, socket, toTable } = setup();
    const owner = socket('owner');
    reg.handle(owner.id, { t: 'create', hosted: true });
    const code = owner.last()!.room!;
    const players = [owner];
    toTable(owner.id, code, { t: 'join', name: 'Owner' });
    for (const name of ['ah-mei', 'bo', 'chen']) {
      const p = socket(name);
      reg.handle(p.id, { t: 'join', room: code });
      toTable(p.id, code, { t: 'join', name });
      players.push(p);
    }
    toTable(owner.id, code, { t: 'start' });
    expect(reg.hostedTable(code)!.phase).not.toBe('lobby');
    expect(reg.hostedTable(code)!.seatInfo().filter((s) => s.userId).length).toBe(4);

    // Onlookers get four places; the fifth is turned away like a missing room.
    const watchers = Array.from({ length: 8 }, (_, i) => socket(`griefer-${i}`));
    const admitted = watchers.filter((w) => {
      reg.handle(w.id, { t: 'join', room: code });
      return w.last()!.t === 'room';
    });
    expect(admitted.length).toBe(4);
    expect(watchers[7].last()).toEqual({ t: 'error', code: ROOM_UNAVAILABLE_CODE, message: ROOM_UNAVAILABLE });

    // Ah-Mei's link drops; a new onlooker cannot take her place, and she always gets back in.
    reg.disconnect(players[1].id);
    const another = socket('griefer-late');
    reg.handle(another.id, { t: 'join', room: code });
    expect(another.last()!.t).toBe('error');
    const back = socket('ah-mei');
    reg.handle(back.id, { t: 'join', room: code });
    expect(back.last()!.t).toBe('room');
    expect(reg.roomPeers(code)).toContain(back.id);
  });

  it('lets a seated player in even when the room is at its overall limit', () => {
    const { reg, socket, toTable } = setup();
    const owner = socket('owner');
    reg.handle(owner.id, { t: 'create', hosted: true });
    const code = owner.last()!.room!;
    toTable(owner.id, code, { t: 'join', name: 'Owner' });
    const seated = [owner];
    for (const name of ['a', 'b', 'c']) {
      const p = socket(name);
      reg.handle(p.id, { t: 'join', room: code });
      toTable(p.id, code, { t: 'join', name });
      seated.push(p);
    }
    toTable(owner.id, code, { t: 'start' });
    // Each seated player reconnects twice without the old socket being noticed: twelve peers in all.
    for (const name of ['a', 'b', 'c', 'owner']) {
      for (let i = 0; i < 2; i++) {
        const again = socket(name);
        reg.handle(again.id, { t: 'join', room: code });
        expect(again.last()!.t).toBe('room');
      }
    }
    expect(reg.roomPeers(code).length).toBe(12);
    const stranger = socket('stranger');
    reg.handle(stranger.id, { t: 'join', room: code });
    expect(stranger.last()!.t).toBe('error');
    const fresh = socket('b');
    reg.handle(fresh.id, { t: 'join', room: code });
    expect(fresh.last()!.t).toBe('room');
  });
});

describe('watcher places', () => {
  /** A table in its lobby with only its opener seated. */
  function lobby(clubs?: ClubGate) {
    const f = setup(clubs);
    const owner = f.socket('owner');
    f.reg.handle(owner.id, { t: 'create', hosted: true });
    const code = owner.last()!.room!;
    f.toTable(owner.id, code, { t: 'join', name: 'Owner' });
    const enter = (who: ReturnType<typeof f.socket>) => {
      f.reg.handle(who.id, { t: 'join', room: code });
      return who.last()!;
    };
    return { ...f, owner, code, enter };
  }

  it("gives one account one place, so its idle sockets cannot keep invited players out of a table's lobby", () => {
    const { reg, socket, toTable, code, enter } = lobby();
    // One account, four sockets, never sits down: the first takes the account's place, the others are turned away.
    const lurkers = Array.from({ length: 4 }, () => socket('lurker'));
    expect(lurkers.map((l) => enter(l).t)).toEqual(['room', 'error', 'error', 'error']);
    expect(lurkers[1].last()).toEqual({ t: 'error', code: ROOM_UNAVAILABLE_CODE, message: ROOM_UNAVAILABLE });
    // Every invited friend comes in and sits down.
    for (const name of ['friend-1', 'friend-2', 'friend-3']) {
      const friend = socket(name);
      expect(enter(friend).t).toBe('room');
      toTable(friend.id, code, { t: 'join', name });
      expect(friend.last()!.data?.msg?.t).toBe('lobby');
    }
    expect(reg.hostedTable(code)!.seatInfo().filter((s) => s.userId).length).toBe(4);
    // The lurker's one socket is still there as a watcher, and the same socket asking again is not a second place.
    expect(reg.roomPeers(code)).toContain(lurkers[0].id);
    expect(enter(lurkers[0]).t).toBe('room');
  });

  it('always admits a would-be player while a seat is open in the lobby, dropping the longest-idle watcher when the room is full', () => {
    const { reg, socket, toTable, owner, code, enter } = lobby();
    // Eleven idle accounts fill the room to its twelve peers: watchers are admitted freely while a seat is open.
    const idle = Array.from({ length: 11 }, (_, i) => socket(`idle-${i}`));
    expect(idle.map((w) => enter(w).t)).toEqual(Array<string>(11).fill('room'));
    expect(reg.roomPeers(code).length).toBe(12);
    // A friend still gets in: the watcher that came first makes way and is told why.
    const friend = socket('friend');
    expect(enter(friend).t).toBe('room');
    expect(reg.roomPeers(code).length).toBe(12);
    expect(reg.roomPeers(code)).not.toContain(idle[0].id);
    expect(idle[0].last()).toEqual({ t: 'error', code: 'closed', message: WATCHER_DROPPED });
    expect(reg.roomPeers(code)).toContain(owner.id);
    toTable(friend.id, code, { t: 'join', name: 'Friend' });
    expect(reg.hostedTable(code)!.seatInfo().filter((s) => s.userId).length).toBe(2);
    // The dropped socket may come back the same way; the seated players are never the ones dropped.
    expect(enter(idle[0]).t).toBe('room');
    expect(reg.roomPeers(code)).toContain(owner.id);
    expect(reg.roomPeers(code)).toContain(friend.id);
    expect(reg.roomPeers(code)).not.toContain(idle[1].id);
  });

  it('keeps the four watcher places, one per account, once no seat is open', () => {
    const { reg, socket, toTable, owner, code, enter } = lobby();
    toTable(owner.id, code, { t: 'start' });
    expect(reg.hostedTable(code)!.phase).not.toBe('lobby');
    const first = socket('watcher-0');
    expect(enter(first).t).toBe('room');
    // The same account again takes no second place.
    expect(enter(socket('watcher-0')).t).toBe('error');
    for (let i = 1; i < 4; i++) expect(enter(socket(`watcher-${i}`)).t).toBe('room');
    expect(enter(socket('watcher-4')).t).toBe('error');
    // Nobody is dropped for a watcher: the first four keep their places.
    expect(reg.roomPeers(code)).toContain(first.id);
    expect(reg.roomPeers(code).length).toBe(5);
  });

  it('drops no watcher for someone who is then refused at the door', () => {
    const members = new Set<string>();
    const gate: ClubGate = {
      openTable: () => ({ error: CLUB_MEMBERS_ONLY }),
      tableOpened: () => undefined,
      mayJoin: (_club, userId) => userId !== undefined && members.has(userId),
    };
    const { reg, socket } = setup(gate);
    const code = reg.createHostedRoom({ clubCode: 'CLUB01' });
    const inside = Array.from({ length: 12 }, (_, i) => socket(`member-${i}`));
    for (const m of inside) {
      members.add(`user-member-${inside.indexOf(m)}`);
      reg.handle(m.id, { t: 'join', room: code });
      expect(m.last()!.t).toBe('room');
    }
    const outsider = socket('outsider');
    reg.handle(outsider.id, { t: 'join', room: code });
    expect(outsider.last()).toEqual({ t: 'error', message: CLUB_MEMBERS_ONLY });
    expect(reg.roomPeers(code)).toEqual(inside.map((m) => m.id));
  });
});
