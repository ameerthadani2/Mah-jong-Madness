import { describe, expect, it } from 'vitest';
import { RoomRegistry, type Socket } from '../src/rooms';

function fakeSocket(): Socket & { out: unknown[] } {
  const out: unknown[] = [];
  return { out, send: (j) => out.push(JSON.parse(j)), close: () => undefined };
}

describe('RoomRegistry', () => {
  it('creates rooms with readable codes, joins, relays and leaves', () => {
    const reg = new RoomRegistry({ random: () => 0.5 });
    const a = fakeSocket();
    const b = fakeSocket();
    let ia = reg.connect(a);
    let ib = reg.connect(b);
    ia = reg.handle(ia, { t: 'hello' });
    ib = reg.handle(ib, { t: 'hello' });
    expect(ia).toMatch(/^p-/);
    // hello is idempotent: the id never changes once assigned
    expect(reg.handle(ia, { t: 'hello' })).toBe(ia);
    reg.handle(ia, { t: 'create' });
    const roomMsg = a.out.find((m) => (m as { t: string }).t === 'room') as { room: string; host: string };
    expect(roomMsg.room).toMatch(/^[A-Z2-9]{6}$/);
    expect(roomMsg.host).toBe(ia);
    reg.handle(ib, { t: 'join', room: roomMsg.room.toLowerCase() });
    expect(a.out.some((m) => (m as { t: string; event?: string }).t === 'peer' && (m as { event: string }).event === 'join')).toBe(true);
    reg.handle(ib, { t: 'to', to: ia, data: { hi: 1 } });
    expect(a.out.at(-1)).toEqual({ t: 'from', from: ib, data: { hi: 1 } });
    // Garbage never throws
    expect(() => reg.handle(ib, { t: 'to', to: 5 as unknown as string, data: null })).not.toThrow();
    expect(() => reg.handle(ib, { t: 'join', room: {} as unknown as string })).not.toThrow();
    reg.handle(ib, { t: 'join', room: 'NOPE' });
    expect(b.out.at(-1)).toEqual({ t: 'error', message: 'Room not found' });
    reg.disconnect(ia);
    expect(reg.stats().peers).toBe(1);
  });

  it('hosts a table on the server when asked', () => {
    const reg = new RoomRegistry({ allowHosted: true });
    const a = fakeSocket();
    const ia = reg.handle(reg.connect(a), { t: 'hello' });
    reg.handle(ia, { t: 'create', hosted: true, rules: { handsPerMatch: 1 } });
    const roomMsg = a.out.find((m) => (m as { t: string }).t === 'room') as { room: string; host: string; peers: string[] };
    expect(roomMsg.host).toMatch(/^server-/);
    expect(roomMsg.peers).toContain(roomMsg.host);
    // Join the hosted table through the relay channel
    reg.handle(ia, { t: 'to', to: roomMsg.host, data: { ch: 'game', msg: { t: 'join', name: 'Alice' } } });
    const welcome = a.out.find((m) => (m as { t: string; data?: { msg?: { t: string } } }).t === 'from' && (m as { data: { msg: { t: string } } }).data.msg.t === 'welcome');
    expect(welcome).toBeDefined();
    // Malformed game frames to the hosted table are ignored
    expect(() => reg.handle(ia, { t: 'to', to: roomMsg.host, data: { ch: 'game', msg: null } })).not.toThrow();
    expect(() => reg.handle(ia, { t: 'to', to: roomMsg.host, data: 'junk' })).not.toThrow();
    expect(reg.stats().hostedTables).toBe(1);
    reg.disconnect(ia);
    expect(reg.stats().hostedTables).toBe(0);
  });
});
