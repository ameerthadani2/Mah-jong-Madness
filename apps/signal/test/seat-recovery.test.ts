/**
 * Seat recovery by account, over real sockets. The quick-match queue sends an account that still
 * holds a seat back to its table (`queue_error` `seated`), but the table used to give the seat
 * back only to the rejoin token: a player who had lost it (a reinstall, another device) was locked
 * out until the match ended. A table the server hosts now gives an account its own seat back, and
 * only its own.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';

type Msg = { t: string; [k: string]: unknown };
type TableMsg = { t: string; seat?: number; token?: string; code?: string; seats?: Array<{ seat: number; userId?: string; connected: boolean; isBot: boolean }> };

const servers: SignalServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start() {
  const repos = createRepos();
  const server = await createSignalServer({
    port: 0,
    host: '127.0.0.1',
    repos,
    sessions: new SessionService(repos.repos, { pepper: 'seat-pepper-0123456789abcdef' }),
    providers: {},
    config: loadConfig({}),
    botDelayMs: 0,
    persistDebounceMs: 20,
    log: () => undefined,
    quickMatchFillMs: 50,
    quickStartMs: 5_000,
  });
  servers.push(server);
  const port = server.address().port;
  const post = (path: string, method: string, body: unknown, token?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  /** A guest old enough for quick match. */
  const guest = async (name: string) => {
    const json = (await (await post('/api/auth/guest', 'POST', { device: { id: randomUUID(), platform: 'ios' }, displayName: name })).json()) as { userId: string; guestSecret: string; session: { token: string } };
    await post('/api/me', 'PATCH', { birthYear: 1990 }, json.session.token);
    return json;
  };
  /** A second device of the same account: its own session. */
  const signInAgain = async (g: { userId: string; guestSecret: string }) =>
    ((await (await post('/api/auth/guest/login', 'POST', { userId: g.userId, guestSecret: g.guestSecret, device: { id: randomUUID(), platform: 'android' } })).json()) as { session: { token: string } }).session.token;
  /** A raw socket after its hello: every frame it gets, the table's frames, and its close code. */
  const open = async (token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.on('error', () => undefined);
    const got: Msg[] = [];
    ws.on('message', (raw) => got.push(JSON.parse(String(raw)) as Msg));
    await new Promise<void>((r) => ws.on('open', () => r()));
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    const next = async (ok: (m: Msg) => boolean, from = 0) => {
      const end = Date.now() + 5_000;
      for (;;) {
        const hit = got.slice(from).find(ok);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`no such frame; got ${JSON.stringify(got.slice(from)).slice(0, 600)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    send({ t: 'hello', auth: token });
    await next((m) => m.t === 'hello');
    const table = (from = 0): TableMsg[] => got.slice(from).filter((m) => m.t === 'from').map((m) => (m.data as { msg: TableMsg }).msg);
    /** Enter the room, then ask the table for a seat (with a rejoin token, or with none). */
    const sit = async (room: string, rejoinToken?: string, alreadyIn = false) => {
      const from = got.length;
      if (!alreadyIn) send({ t: 'join', room });
      const entered = alreadyIn ? { t: 'room' } : await next((m) => m.t === 'room' || m.t === 'error', from);
      if (entered.t !== 'room') return { entered, answer: undefined };
      send({ t: 'to', to: `server-${room}`, data: { ch: 'game', msg: { t: 'join', name: 'x', ...(rejoinToken ? { token: rejoinToken } : {}) } } });
      await next((m) => m.t === 'from' && ['welcome', 'error'].includes((m.data as { msg: TableMsg }).msg.t), from);
      return { entered, answer: table(from).find((m) => m.t === 'welcome' || m.t === 'error')! };
    };
    const queue = async () => {
      const from = got.length;
      send({ t: 'queue' });
      return next((m) => m.t === 'matched' || m.t === 'queue_error', from);
    };
    return { ws, got, send, next, table, sit, queue };
  };
  const until = async (what: string, ok: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { server, guest, signInAgain, open, until };
}

describe('an account comes back to its seat at a server-hosted table without the rejoin token', () => {
  it('quick match: the queue sends the account to its table, and the table gives it its seat back on a new device', async () => {
    const { server, guest, signInAgain, open, until } = await start();
    const mei = await guest('Mei');
    const phone = await open(mei.session.token);
    const matched = await phone.queue();
    expect(matched).toMatchObject({ t: 'matched' });
    const room = matched.room as string;
    const first = (await phone.sit(room)).answer!;
    expect(first.t).toBe('welcome');
    const seat = first.seat!;
    await until('the table to start', () => server.rooms.hostedTable(room)!.phase !== 'lobby');

    // The phone is gone, and with it the rejoin token. The same account signs in on another device.
    phone.ws.terminate();
    await until('the seat to be seen as disconnected', () => server.rooms.hostedTable(room)!.seatInfo()[seat].connected === false);
    const tablet = await open(await signInAgain(mei));
    expect(await tablet.queue()).toMatchObject({ t: 'queue_error', code: 'seated', room });
    const back = (await tablet.sit(room)).answer!;
    expect(back).toMatchObject({ t: 'welcome', seat });
    expect(back.token).toMatch(/^[0-9a-f]{32}$/);
    expect(back.token).not.toBe(first.token);
    expect(server.rooms.hostedTable(room)!.seatInfo()[seat]).toMatchObject({ userId: mei.userId, connected: true, isBot: false });
    // The table goes on for the returning player: it is sent where the hand stands.
    await tablet.next((m) => m.t === 'from' && ['state', 'commit_request', 'commits', 'reveal_request', 'hand_over'].includes((m.data as { msg: TableMsg }).msg.t));
    // The lost token opens nothing for another account: a quick-match table is closed to it altogether.
    const stranger = await open((await guest('Stranger')).session.token);
    expect((await stranger.sit(room, first.token)).entered).toMatchObject({ t: 'error', code: 'room_unavailable' });
  });

  it('a table opened for friends: the newest device of a seated account takes the seat, and no other account can', async () => {
    const { server, guest, signInAgain, open, until } = await start();
    const mei = await guest('Mei');
    const lin = await guest('Lin');
    const a = await open(mei.session.token);
    a.send({ t: 'create', hosted: true });
    const room = (await a.next((m) => m.t === 'room')).room as string;
    const meiSeat = (await a.sit(room, undefined, true)).answer!;
    const b = await open(lin.session.token);
    const linSeat = (await b.sit(room)).answer!;
    expect([meiSeat.t, linSeat.t]).toEqual(['welcome', 'welcome']);
    a.send({ t: 'to', to: `server-${room}`, data: { ch: 'game', msg: { t: 'start' } } });
    await until('the table to start', () => server.rooms.hostedTable(room)!.phase !== 'lobby');

    // Mid-match, an account that holds no seat gets none, whatever name or id it writes into its join.
    const eve = await open((await guest('Eve')).session.token);
    const from = eve.got.length;
    eve.send({ t: 'join', room });
    await eve.next((m) => m.t === 'room', from);
    eve.send({ t: 'to', to: `server-${room}`, data: { ch: 'game', msg: { t: 'join', name: 'Lin', userId: lin.userId } } });
    await eve.next((m) => m.t === 'from' && (m.data as { msg: TableMsg }).msg.t === 'error', from);
    expect(eve.table(from).find((m) => m.t === 'error')).toMatchObject({ code: 'full' });
    expect(server.rooms.hostedTable(room)!.seatInfo()[linSeat.seat!]).toMatchObject({ userId: lin.userId, connected: true });

    // Lin opens the table on a second device while the first is still connected: the newest one plays on.
    const second = await open(await signInAgain(lin));
    const mark = b.got.length;
    const again = (await second.sit(room)).answer!;
    expect(again).toMatchObject({ t: 'welcome', seat: linSeat.seat });
    expect(again.token).not.toBe(linSeat.token);
    await b.next((m) => m.t === 'from' && (m.data as { msg: TableMsg }).msg.t === 'disconnected', mark);
    expect(server.rooms.hostedTable(room)!.seatInfo().filter((s) => s.userId === lin.userId)).toHaveLength(1);
    expect(server.rooms.hostedTable(room)!.seatInfo()[meiSeat.seat!]).toMatchObject({ userId: mei.userId, connected: true });
  });
});
