import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, RULE_LIMITS } from '@mjm/engine';
import { CODE_ALPHABET, codeFromHex } from '../src/codes';
import {
  CREATE_COOLDOWN,
  HOSTED_DISABLED,
  HOSTED_ONLY,
  JOIN_THROTTLED,
  ROOM_CLOSED,
  ROOM_UNAVAILABLE,
  RoomLimitError,
  RoomRegistry,
  SERVER_FULL,
  type RoomRegistryOptions,
  type Socket,
} from '../src/rooms';

type Out = { t: string; code?: string; message?: string; room?: string; host?: string; peers?: string[]; event?: string };

function fakeSocket(): Socket & { out: Out[] } {
  const out: Out[] = [];
  return { out, send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined };
}

const last = (s: { out: Out[] }): Out | undefined => s.out[s.out.length - 1];

/** A registry with a controllable clock, plus a helper that connects and says hello. */
function setup(opts: RoomRegistryOptions = {}) {
  const clock = { now: 0 };
  const reg = new RoomRegistry({ now: () => clock.now, ...opts });
  const peer = () => {
    const socket = fakeSocket();
    const id = reg.handle(reg.connect(socket), { t: 'hello' });
    return { id, socket };
  };
  return { reg, clock, peer };
}

describe('RoomRegistry', () => {
  it('creates relay-only rooms when allowed, joins, relays and leaves', () => {
    const { reg, peer } = setup({ allowP2P: true });
    const a = peer();
    const b = peer();
    expect(a.id).toMatch(/^p-[0-9a-f]{16}$/);
    // hello is idempotent: once assigned, the id never changes
    expect(reg.handle(a.id, { t: 'hello' })).toBe(a.id);
    reg.handle(a.id, { t: 'create' });
    const roomMsg = a.socket.out.find((m) => m.t === 'room')!;
    expect(roomMsg.room).toMatch(/^[A-Z2-9]{6}$/);
    expect(roomMsg.host).toBe(a.id);
    reg.handle(b.id, { t: 'join', room: roomMsg.room!.toLowerCase() });
    expect(a.socket.out.some((m) => m.t === 'peer' && m.event === 'join')).toBe(true);
    reg.handle(b.id, { t: 'to', to: a.id, data: { hi: 1 } });
    expect(last(a.socket)).toEqual({ t: 'from', from: b.id, data: { hi: 1 } });
    // Garbage never throws
    expect(() => reg.handle(b.id, { t: 'to', to: 5 as unknown as string, data: null })).not.toThrow();
    expect(() => reg.handle(b.id, { t: 'join', room: {} as unknown as string })).not.toThrow();
    expect(() => reg.handle(b.id, { t: 'create', room: 7 as unknown as string })).not.toThrow();
    reg.handle(b.id, { t: 'join', room: 'NOPE' });
    expect(last(b.socket)).toEqual({ t: 'error', message: ROOM_UNAVAILABLE });
    reg.disconnect(a.id);
    expect(reg.stats().peers).toBe(1);
  });

  it('closes a relay-only room when its host leaves instead of handing the host role to a guest (probe signal/rooms.ts)', () => {
    for (const how of ['leave', 'disconnect'] as const) {
      const { reg, clock, peer } = setup({ allowP2P: true });
      const a = peer();
      const b = peer();
      const c = peer();
      reg.handle(a.id, { t: 'create' });
      const code = a.socket.out.find((m) => m.t === 'room')!.room!;
      reg.handle(b.id, { t: 'join', room: code });
      reg.handle(c.id, { t: 'join', room: code });
      const before = b.socket.out.length;
      if (how === 'leave') reg.handle(a.id, { t: 'leave' });
      else reg.disconnect(a.id);
      const after = b.socket.out.slice(before);
      expect(after).toEqual([
        { t: 'peer', peerId: a.id, event: 'leave' },
        { t: 'error', code: 'closed', message: ROOM_CLOSED },
      ]);
      expect(last(c.socket)).toEqual({ t: 'error', code: 'closed', message: ROOM_CLOSED });
      expect(reg.hasRoom(code)).toBe(false);
      expect(reg.roomPeers(code)).toEqual([]);
      // The guests are free: relaying to the old host goes nowhere, and they can open a room of their own.
      const quiet = b.socket.out.length;
      reg.handle(b.id, { t: 'to', to: c.id, data: { hi: 1 } });
      expect(c.socket.out.some((m) => m.t === 'from')).toBe(false);
      expect(b.socket.out.length).toBe(quiet);
      clock.now += 10_000;
      reg.handle(b.id, { t: 'create' });
      expect(last(b.socket)!.t).toBe('room');
    }
  });

  it('keeps a relay-only room open when a guest leaves', () => {
    const { reg, peer } = setup({ allowP2P: true });
    const a = peer();
    const b = peer();
    reg.handle(a.id, { t: 'create' });
    const code = a.socket.out.find((m) => m.t === 'room')!.room!;
    reg.handle(b.id, { t: 'join', room: code });
    reg.handle(b.id, { t: 'leave' });
    expect(reg.roomPeers(code)).toEqual([a.id]);
    expect(last(a.socket)).toEqual({ t: 'peer', peerId: b.id, event: 'leave' });
  });

  it('hosts a table on the server when asked', () => {
    const { reg, peer } = setup({ allowHosted: true });
    const a = peer();
    reg.handle(a.id, { t: 'create', hosted: true, rules: { handsPerMatch: 1 } });
    const roomMsg = a.socket.out.find((m) => m.t === 'room')!;
    expect(roomMsg.host).toMatch(/^server-/);
    expect(roomMsg.peers).toContain(roomMsg.host);
    expect(reg.hostedTable(roomMsg.room!)!.rules.handsPerMatch).toBe(1);
    // Join the hosted table through the relay channel
    reg.handle(a.id, { t: 'to', to: roomMsg.host!, data: { ch: 'game', msg: { t: 'join', name: 'Alice' } } });
    const welcome = a.socket.out.find((m) => m.t === 'from' && (m as unknown as { data: { msg: { t: string } } }).data.msg.t === 'welcome');
    expect(welcome).toBeDefined();
    // Malformed game frames sent to the hosted table are ignored
    expect(() => reg.handle(a.id, { t: 'to', to: roomMsg.host!, data: { ch: 'game', msg: null } })).not.toThrow();
    expect(() => reg.handle(a.id, { t: 'to', to: roomMsg.host!, data: 'junk' })).not.toThrow();
    expect(reg.stats().hostedTables).toBe(1);
    reg.disconnect(a.id);
    expect(reg.stats().hostedTables).toBe(0);
  });

  it('rejects rooms without a server table unless relay-only rooms are enabled', () => {
    for (const opts of [{ allowHosted: true }, {}]) {
      const { reg, peer } = setup(opts);
      const a = peer();
      reg.handle(a.id, { t: 'create' });
      expect(a.socket.out.slice(1)).toEqual([{ t: 'error', message: HOSTED_ONLY }]);
      expect(reg.stats().rooms).toBe(0);
    }
    // With hosting disabled, a hosted request is not quietly downgraded to a relay-only room,
    // even when relay-only rooms are allowed (HOST_TABLES=0, P2P_ROOMS=1; probe signal/rooms.ts).
    for (const opts of [{ allowHosted: false }, { allowHosted: false, allowP2P: true }]) {
      const { reg, peer } = setup(opts);
      const a = peer();
      reg.handle(a.id, { t: 'create', hosted: true });
      expect(last(a.socket)).toEqual({ t: 'error', message: HOSTED_DISABLED });
      expect(reg.stats().rooms).toBe(0);
      expect(() => reg.createHostedRoom()).toThrow(HOSTED_DISABLED);
    }
  });

  it('sanitises the rules and bot skill of a hosted create (the probe payload)', () => {
    const { reg, peer } = setup({ allowHosted: true });
    const a = peer();
    const evil = { basePoints: 'x', deadWallSize: -9999, turnSeconds: 1e9, handsPerMatch: 1e9, timeBankSeconds: -5, allowChi: 'false', evil: 'y'.repeat(1000) };
    reg.handle(a.id, { t: 'create', hosted: true, rules: evil as never, botSkill: 'grandmaster' });
    const code = a.socket.out.find((m) => m.t === 'room')!.room!;
    const host = reg.hostedTable(code)!;
    expect(host.rules.basePoints).toBe(DEFAULT_RULES.basePoints);
    expect(host.rules.deadWallSize).toBe(RULE_LIMITS.deadWallSize[0]);
    expect(host.rules.turnSeconds).toBe(RULE_LIMITS.turnSeconds[1]);
    expect(host.rules.handsPerMatch).toBe(RULE_LIMITS.handsPerMatch[1]);
    expect(host.rules.timeBankSeconds).toBe(0);
    expect(host.rules.allowChi).toBe(DEFAULT_RULES.allowChi);
    expect('evil' in host.rules).toBe(false);
    expect(Object.keys(host.rules).sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
  });

  it('lets each peer create one room per 10 seconds', () => {
    const { reg, clock, peer } = setup({ allowHosted: true });
    const a = peer();
    reg.handle(a.id, { t: 'create', hosted: true });
    expect(last(a.socket)!.t).toBe('room');
    clock.now += 9_999;
    reg.handle(a.id, { t: 'create', hosted: true });
    expect(last(a.socket)).toEqual({ t: 'error', message: CREATE_COOLDOWN });
    // 300 rapid creates from one socket still leave a single room (the old probe made 300).
    for (let i = 0; i < 300; i++) reg.handle(a.id, { t: 'create', hosted: true });
    expect(reg.stats().hostedTables).toBe(1);
    clock.now += 1;
    reg.handle(a.id, { t: 'create', hosted: true });
    expect(last(a.socket)!.t).toBe('room');
    // The cooldown applies to each peer separately.
    const b = peer();
    reg.handle(b.id, { t: 'create', hosted: true });
    expect(last(b.socket)!.t).toBe('room');
  });

  it('caps hosted tables across the server, over the socket and the API', () => {
    const { reg, clock, peer } = setup({ allowHosted: true, maxHostedTables: 2 });
    const a = peer();
    const b = peer();
    const c = peer();
    reg.handle(a.id, { t: 'create', hosted: true });
    reg.createHostedRoom();
    reg.handle(b.id, { t: 'create', hosted: true });
    expect(last(b.socket)).toEqual({ t: 'error', message: SERVER_FULL });
    expect(() => reg.createHostedRoom()).toThrow(RoomLimitError);
    expect(reg.stats().hostedTables).toBe(2);
    // A create refused for capacity does not start the peer's cooldown.
    reg.disconnect(a.id);
    reg.handle(b.id, { t: 'create', hosted: true });
    expect(last(b.socket)!.t).toBe('room');
    // ...and capacity frees up again whenever a table closes.
    reg.disconnect(b.id);
    clock.now += 10_000;
    reg.handle(c.id, { t: 'create', hosted: true });
    expect(last(c.socket)!.t).toBe('room');
    expect(reg.stats().hostedTables).toBe(2);
  });

  it('throttles join attempts to 5 per 10 seconds', () => {
    const { reg, clock, peer } = setup({ allowHosted: true });
    const owner = peer();
    reg.handle(owner.id, { t: 'create', hosted: true });
    const code = owner.socket.out.find((m) => m.t === 'room')!.room!;
    const guesser = peer();
    for (let i = 0; i < 5; i++) {
      reg.handle(guesser.id, { t: 'join', room: `GUESS${i}` });
      expect(last(guesser.socket)).toEqual({ t: 'error', message: ROOM_UNAVAILABLE });
    }
    // The sixth attempt is refused even with the right code.
    reg.handle(guesser.id, { t: 'join', room: code });
    expect(last(guesser.socket)).toEqual({ t: 'error', message: JOIN_THROTTLED });
    expect(reg.roomPeers(code)).not.toContain(guesser.id);
    // The bucket refills at 5 per 10 s (one attempt every 2 s).
    clock.now += 2_000;
    reg.handle(guesser.id, { t: 'join', room: code });
    expect(last(guesser.socket)!.t).toBe('room');
    expect(reg.roomPeers(code)).toContain(guesser.id);
  });

  it('answers the same way for a missing room and a full one', () => {
    const { reg, peer } = setup({ allowHosted: true });
    const owner = peer();
    reg.handle(owner.id, { t: 'create', hosted: true });
    const code = owner.socket.out.find((m) => m.t === 'room')!.room!;
    for (let i = 0; i < 11; i++) reg.handle(peer().id, { t: 'join', room: code });
    expect(reg.roomPeers(code)).toHaveLength(12);
    const late = peer();
    reg.handle(late.id, { t: 'join', room: code });
    const full = last(late.socket);
    reg.handle(late.id, { t: 'join', room: 'ZZZZZZ' });
    const missing = last(late.socket);
    reg.handle(late.id, { t: 'join', room: 'X'.repeat(5000) });
    const huge = last(late.socket);
    expect(full).toEqual({ t: 'error', message: ROOM_UNAVAILABLE });
    expect(missing).toEqual(full);
    expect(huge).toEqual(full);
  });

  it('draws codes and peer ids from the injected secure source', () => {
    const calls: number[] = [];
    const hex = (bytes: number) => {
      calls.push(bytes);
      return 'ff'.repeat(bytes);
    };
    const { reg, peer } = setup({ allowHosted: true, randomHex: hex });
    const a = peer();
    expect(a.id).toBe(`p-${'ff'.repeat(8)}`);
    reg.handle(a.id, { t: 'create', hosted: true });
    // 0xff & 31 = 31 → the last alphabet character
    expect(a.socket.out.find((m) => m.t === 'room')!.room).toBe('999999');
    expect(calls).toContain(6);
  });
});

describe('room codes', () => {
  it('map every byte value onto the alphabet exactly evenly (no modulo bias)', () => {
    const counts = new Map<string, number>();
    for (let b = 0; b < 256; b++) {
      const ch = codeFromHex(b.toString(16).padStart(2, '0'), 1);
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(CODE_ALPHABET).toHaveLength(32);
    expect([...counts.keys()].sort().join('')).toBe([...CODE_ALPHABET].sort().join(''));
    expect(new Set(counts.values())).toEqual(new Set([8]));
  });

  it('are alphabet members from the real random source and fail closed on short input', () => {
    const reg = new RoomRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = reg.newCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(495);
    expect(() => codeFromHex('ab', 2)).toThrow(/random bytes/);
  });
});
