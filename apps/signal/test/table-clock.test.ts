/**
 * The signal server as src/main.ts builds it (no clock given) hosts each table on `steadyClock()`,
 * so a server clock set back a minute, or forward 2 s, moves none of the table's stamps. server.ts
 * once handed the room registry its own resolved `Date.now`, and every hosted table kept the wall
 * clock after all: a set-back stood its stamps still, which the players' audit takes for a turn
 * shown late (probe srvclock).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos } from '../src/repos';
import type { Socket } from '../src/rooms';
import { createSignalServer, type SignalServer } from '../src/server';

type Frame = { t: string; host?: string; data?: { msg?: { t?: string; now?: number } } };

let server: SignalServer | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

describe('the clock of a table hosted by the signal server', () => {
  it('is steady when the server is built without a clock, as main.ts builds it', async () => {
    // Only the wall clock and the monotonic clock are faked (from before the server is built, as the
    // process's clocks are); the server's sockets and timers run as they do.
    vi.useFakeTimers({ toFake: ['Date', 'performance'], now: 1_800_000_000_000 });
    const repos = createRepos();
    server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions: new SessionService(repos.repos, { pepper: 'p'.repeat(32) }), providers: {}, config: loadConfig({}), log: () => undefined });
    const out: Frame[] = [];
    const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Frame), close: () => undefined };
    const rooms = server.rooms;
    const a = rooms.handle(rooms.connect(socket), { t: 'hello' });
    rooms.handle(a, { t: 'create', hosted: true });
    const host = out.find((m) => m.t === 'room')?.host;
    expect(host).toBeDefined();
    /** The table's stamp on its answer to a ping. */
    const stamp = (): number => {
      rooms.handle(a, { t: 'to', to: host as string, data: { ch: 'game', msg: { t: 'ping', at: 1 } } });
      const pong = [...out].reverse().find((m) => m.t === 'from' && m.data?.msg?.t === 'pong');
      return pong?.data?.msg?.now as number;
    };
    const t0 = stamp();
    expect(Math.abs(t0 - Date.now())).toBeLessThan(1_000);
    vi.setSystemTime(Date.now() - 60_000);
    vi.advanceTimersByTime(1_000);
    expect(stamp()).toBe(t0 + 1_000);
    vi.setSystemTime(Date.now() + 2_000);
    vi.advanceTimersByTime(1_000);
    expect(stamp()).toBe(t0 + 2_000);
    rooms.disconnect(a);
  });
});
