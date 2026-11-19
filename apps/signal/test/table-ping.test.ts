/**
 * The table's own ping goes through the relay unchanged (a `ping` inside a `to` frame for the hosted
 * table), and the table's answer comes back unchanged: `at` exactly as the phone sent it, `now` the
 * table's clock. The phone measures the table's clock by these answers, once a second. The socket's
 * own heartbeat (`{t:'ping'}` outside a `to` frame) is a different frame, which the relay answers itself.
 */
import { describe, expect, it } from 'vitest';
import { RoomRegistry, type Socket } from '../src/rooms';

type Out = { t: string; from?: string; data?: { ch?: string; msg?: { t?: string; at?: unknown; now?: unknown } } };

describe('the table’s ping through the relay', () => {
  it('reaches the hosted table and its pong comes back with `at` unchanged and the table’s clock, before and after the peer sits down', () => {
    const clock = { now: 4_000_000 };
    const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0, now: () => clock.now });
    const code = rooms.createHostedRoom();
    const out: Out[] = [];
    const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined };
    const id = rooms.handle(rooms.connect(socket), { t: 'hello' });
    rooms.handle(id, { t: 'join', room: code });
    const table = `server-${code}`;
    const say = (msg: Record<string, unknown>) => rooms.handle(id, { t: 'to', to: table, data: { ch: 'game', msg } });
    const pongs = () => out.filter((m) => m.t === 'from' && m.from === table && m.data?.msg?.t === 'pong').map((m) => m.data!.msg!);
    // Not seated yet.
    say({ t: 'ping', at: 1234.5678 });
    expect(pongs()).toEqual([{ t: 'pong', at: 1234.5678, now: expect.any(Number) }]);
    const first = pongs()[0].now as number;
    // Seated.
    say({ t: 'join', name: 'Pinger' });
    clock.now += 1_500;
    say({ t: 'ping', at: 0.000123 });
    expect(pongs()).toHaveLength(2);
    expect(pongs()[1].at).toBe(0.000123);
    expect(pongs()[1].now).toBeGreaterThanOrEqual(first);
    // The socket's heartbeat is answered by the relay itself, not by the table.
    out.length = 0;
    rooms.handle(id, { t: 'ping' });
    expect(out).toEqual([{ t: 'pong' }]);
  });
});
