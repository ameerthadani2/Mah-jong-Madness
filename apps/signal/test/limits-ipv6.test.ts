/**
 * Every per-address limit counts an IPv6 client by its /64 prefix and an IPv4 client by its whole
 * address. One IPv6 customer holds a /64, so a key per address used to hand out a fresh allowance
 * for each of its 2^64 addresses: 30 guest sign-ups in a burst from one /64 were all accepted where
 * one IPv4 address got five. Checked here on the HTTP limiter, the auth limiter, reports, club
 * joins, sockets per address, and the create and quick-match allowances of the room registry.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { CLUB_LIMITS, type Club } from '../src/clubs';
import { LIMITS } from '../src/config';
import { BucketTable } from '../src/limits';
import { CREATE_COOLDOWN, RoomRegistry } from '../src/rooms';
import { createSocketServer } from '../src/sockets';
import { apiFixture, type Guest } from './helpers';

/** Address number `i` of one home or server's IPv6 /64. */
const sameSlash64 = (i: number) => `2001:db8:1234:5678:${(i >> 8).toString(16)}:${(i & 0xff).toString(16)}::${(i + 1).toString(16)}`;
const device = () => ({ id: crypto.randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' });

describe('HTTP limits per address, for IPv6 and IPv4', () => {
  it('gives one IPv6 /64 the five guest sign-ups a minute one IPv4 address gets', async () => {
    const now = Date.UTC(2026, 10, 11);
    const { call } = apiFixture({ now: () => now });
    let accepted = 0;
    for (let i = 0; i < 30; i++) if ((await call('POST', '/api/auth/guest', { device: device() }, {}, sameSlash64(i))).status === 201) accepted++;
    expect(accepted).toBe(LIMITS.authPerMinute);
    const refused = await call('POST', '/api/auth/guest', { device: device() }, {}, sameSlash64(999));
    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe('rate_limited');
    // The /64 next door, and any IPv4 address, have their own allowance.
    expect((await call('POST', '/api/auth/guest', { device: device() }, {}, '2001:db8:1234:5679::1')).status).toBe(201);
    let v4 = 0;
    for (let i = 0; i < 6; i++) if ((await call('POST', '/api/auth/guest', { device: device() }, {}, '203.0.113.5')).status === 201) v4++;
    expect(v4).toBe(LIMITS.authPerMinute);
    expect((await call('POST', '/api/auth/guest', { device: device() }, {}, '203.0.113.6')).status).toBe(201);
    // An IPv4 address written as IPv6 is that IPv4 address: its allowance is already spent.
    expect((await call('POST', '/api/auth/guest', { device: device() }, {}, '::ffff:203.0.113.5')).status).toBe(429);
  });

  it('reads the /64 from x-forwarded-for behind a trusted proxy, and counts every request of the /64 in one bucket', async () => {
    const { call } = apiFixture({ api: { trustProxy: 1, limiter: new BucketTable<string>(3, 0, { now: () => 0 }) } });
    const from = (address: string) => call('GET', '/api/config', undefined, { 'x-forwarded-for': `198.51.100.1, ${address}` }, '10.0.0.1');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await from(sameSlash64(i))).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await from('2001:db8:1234:5679::1')).status).toBe(200);
    expect((await from('203.0.113.9')).status).toBe(200);
  });

  it('counts reports from one IPv6 /64 against one daily allowance, whatever the accounts', async () => {
    const f = apiFixture();
    const target = await f.guest('Target');
    let filed = 0;
    let refused: { status: number; message: unknown } | null = null;
    for (let i = 0; i < 4 && !refused; i++) {
      const reporter = await f.guest(`Reporter ${i}`);
      for (let j = 0; j < LIMITS.reportsPerDay && !refused; j++) {
        const res = await f.call('POST', '/api/reports', { reportedUserId: target.userId, reason: 'cheating' }, reporter.auth, sameSlash64(i * 16 + j));
        if (res.status === 201) filed++;
        else refused = { status: res.status, message: res.json.message };
      }
    }
    expect(filed).toBe(LIMITS.reportsPerDayPerIp);
    expect(refused).toEqual({ status: 429, message: 'Too many reports from this address today' });
    // A reporter at another address still files one.
    const other = await f.guest('Elsewhere');
    expect((await f.call('POST', '/api/reports', { reportedUserId: target.userId, reason: 'cheating' }, other.auth, '2001:db8:aaaa:1::1')).status).toBe(201);
  });

  it('counts club joins from one IPv6 /64 against one hourly allowance', async () => {
    const f = apiFixture();
    const clubs: Club[] = [];
    for (let i = 0; i < 4; i++) {
      const owner = await f.guest(`Owner ${i}`);
      for (let j = 0; j < 3; j++) clubs.push((await f.call('POST', '/api/clubs', { name: `Club ${i}.${j}` }, owner.auth)).json as unknown as Club);
    }
    const join = (code: string, who: Guest, ip: string) => f.call('POST', `/api/clubs/${code}/join`, {}, who.auth, ip);
    for (let i = 0; i < CLUB_LIMITS.joinsPerHourPerIp; i++) expect((await join(clubs[i].code, await f.guest(`Throwaway ${i}`), sameSlash64(i))).status).toBe(200);
    expect((await join(clubs[10].code, await f.guest('One more'), sameSlash64(500))).status).toBe(429);
    expect((await join(clubs[10].code, await f.guest('Elsewhere'), '2001:db8:1234:5679::1')).status).toBe(200);
  });
});

describe('socket limits per address, for IPv6 and IPv4', () => {
  let http: Server;
  let wss: WebSocketServer;
  let rooms: RoomRegistry;
  const clients: WebSocket[] = [];

  /** A socket server behind one trusted proxy; the session token is taken as the user id. */
  async function start(socketsPerIp: number): Promise<string> {
    rooms = new RoomRegistry({ allowHosted: true });
    http = createServer();
    wss = createSocketServer(http, rooms, { trustProxy: 1 }, { ...LIMITS, socketsPerIp }, { verify: async (token) => String(token) });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    return `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.terminate();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    vi.restoreAllMocks();
  });

  /** Open a socket as seen from `address`; resolves with its frames and close code once it says hello or is closed. */
  async function open(url: string, address: string, user: string) {
    const ws = new WebSocket(url, { headers: { 'x-forwarded-for': address } });
    clients.push(ws);
    ws.on('error', () => undefined);
    const frames: Array<{ t: string; message?: string; room?: string }> = [];
    let code: number | null = null;
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as { t: string }));
    ws.on('close', (c) => (code = c));
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', auth: user })));
    await vi.waitFor(() => expect(frames.length > 0 || code !== null).toBe(true));
    return { ws, frames, closeCode: () => code };
  }

  it('caps the open sockets of one IPv6 /64, and of an IPv4 address however it is written', async () => {
    const url = await start(3);
    const codes: Array<number | null> = [];
    for (let i = 0; i < 5; i++) codes.push((await open(url, sameSlash64(i), `user-${i}`)).closeCode());
    expect(codes).toEqual([null, null, null, 1008, 1008]);
    // Another /64 is another client.
    expect((await open(url, '2001:db8:1234:5679::1', 'user-n')).closeCode()).toBe(null);
    // IPv4: the plain and the IPv6-mapped spelling are one address; its neighbour is not.
    const v4: Array<number | null> = [];
    for (const a of ['203.0.113.7', '::ffff:203.0.113.7', '::ffff:cb00:7107', '203.0.113.7']) v4.push((await open(url, a, 'user-v4')).closeCode());
    expect(v4).toEqual([null, null, null, 1008]);
    expect((await open(url, '203.0.113.8', 'user-v4b')).closeCode()).toBe(null);
  });

  it('hands the registry the /64 for its create, join and quick-match allowances, so many accounts in one /64 share them', async () => {
    const url = await start(LIMITS.socketsPerIp);
    const connect = vi.spyOn(rooms, 'connect');
    const answers: string[] = [];
    const peers: string[] = [];
    for (let i = 0; i < LIMITS.createsPerIpPerMinute + 2; i++) {
      const s = await open(url, sameSlash64(i), `guest-${i}`);
      peers.push((s.frames[0] as unknown as { id: string }).id);
      s.ws.send(JSON.stringify({ t: 'create', hosted: true }));
      await vi.waitFor(() => expect(s.frames.length).toBe(2));
      answers.push(s.frames[1].t === 'room' ? 'room' : String(s.frames[1].message));
    }
    expect(connect.mock.calls.map((c) => c[1])).toEqual(peers.map(() => '2001:db8:1234:5678::/64'));
    expect(answers).toEqual([...Array<string>(LIMITS.createsPerIpPerMinute).fill('room'), CREATE_COOLDOWN, CREATE_COOLDOWN]);
    // The quick-match charge groups by the same key: with the /64's creates spent, a table for accounts that have not created is refused for all of them.
    const fresh = [await open(url, sameSlash64(100), 'fresh-1'), await open(url, sameSlash64(101), 'fresh-2')].map((s) => (s.frames[0] as unknown as { id: string }).id);
    expect(rooms.chargeQuickMatch(fresh)).toEqual(fresh);
    // A player in another /64 still gets a table.
    const other = await open(url, '2001:db8:1234:5679::1', 'guest-elsewhere');
    other.ws.send(JSON.stringify({ t: 'create', hosted: true }));
    await vi.waitFor(() => expect(other.frames.length).toBe(2));
    expect(other.frames[1].t).toBe('room');
  });
});
