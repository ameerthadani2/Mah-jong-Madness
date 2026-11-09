/**
 * A player who holds a seat always gets back into the room, however many idle sockets other
 * people keep in it, and onlookers who hold no seat get only a few places (probe H: a griefer's
 * eight idle sockets took the place of a player who had dropped, and a bot played her hand).
 */
import { describe, expect, it } from 'vitest';
import { ROOM_UNAVAILABLE, ROOM_UNAVAILABLE_CODE, RoomRegistry, type Socket } from '../src/rooms';

type Out = { t: string; code?: string; message?: string; room?: string; data?: { ch?: string; msg?: { t?: string; seat?: number } } };

function setup() {
  const clock = { now: 0 };
  const reg = new RoomRegistry({ allowHosted: true, botDelayMs: 0, now: () => clock.now });
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
