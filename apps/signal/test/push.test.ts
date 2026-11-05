/**
 * Push notifications with a fake Expo client: POST /api/push/token, the three triggers (club
 * table opened, join approved, "your table is waiting"), the once-a-minute limit per user and
 * kind, DeviceNotRegistered on a ticket or a receipt clearing the token, no-ops without a client,
 * and the server wiring (club events and the seat watcher on the server tick).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import { TableClient, type HostMessage, type Link } from '@mjm/net';
import { SessionService } from '../src/auth';
import type { Club } from '../src/clubs';
import { loadConfig } from '../src/config';
import { PushService, SeatWatcher, type PushClient } from '../src/push';
import { createRepos } from '../src/repos';
import { RoomRegistry, type Socket } from '../src/rooms';
import { createSignalServer } from '../src/server';
import { apiFixture, request, type Guest } from './helpers';

const token = (n: number | string) => `ExponentPushToken[device-${n}-abcdefgh]`;

class FakeExpo implements PushClient {
  sent: ExpoPushMessage[] = [];
  /** Tokens whose tickets come back as DeviceNotRegistered. */
  gone = new Set<string>();
  /** Receipt per ticket id, when asked. */
  receipts: Record<string, ExpoPushReceipt> = {};
  private n = 0;
  async sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    this.sent.push(...messages);
    return messages.map((m) =>
      this.gone.has(String(m.to))
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered', expoPushToken: String(m.to) } }
        : { status: 'ok', id: `ticket-${++this.n}` },
    );
  }
  async getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceipt>> {
    return Object.fromEntries(ids.filter((id) => this.receipts[id]).map((id) => [id, this.receipts[id]]));
  }
}

function fixture(opts: { client?: FakeExpo | null; now?: () => number } = {}) {
  const client = opts.client === undefined ? new FakeExpo() : opts.client;
  // The handler with push wired in, and club events feeding it, as server.ts does.
  const f = apiFixture({
    now: opts.now,
    deps: (repos, clubs) => {
      const push = new PushService({ devices: repos.devices, client, now: opts.now, log: () => {} });
      clubs.onEvent((ev) => void push.onClubEvent(ev));
      return { push };
    },
  });
  const push = f.deps.push!;
  const register = (who: Guest, t: string, platform = 'ios') => f.call('POST', '/api/push/token', { token: t, platform }, who.auth);
  return { ...f, push, client, register };
}

describe('POST /api/push/token', () => {
  it('stores the token on the session\'s device, clears it with null, and validates input', async () => {
    const f = fixture();
    const a = await f.guest();
    expect((await f.register(a, token(1))).status).toBe(204);
    expect((await f.repos.devices.pushTargets([a.userId])).map((t) => [t.token, t.platform])).toEqual([[token(1), 'ios']]);
    // Registering again (a refreshed token) replaces it on the same device.
    await f.register(a, token(2), 'ios');
    expect((await f.repos.devices.listForUser(a.userId)).map((d) => d.pushToken)).toEqual([token(2)]);
    expect((await f.call('POST', '/api/push/token', { token: null }, a.auth)).status).toBe(204);
    expect(await f.repos.devices.pushTargets([a.userId])).toEqual([]);

    expect((await f.call('POST', '/api/push/token', { token: 'not-a-token', platform: 'ios' }, a.auth)).status).toBe(400);
    expect((await f.call('POST', '/api/push/token', { token: token(3), platform: 'windows' }, a.auth)).status).toBe(400);
    expect((await f.call('POST', '/api/push/token', { token: token(3), platform: 'ios' })).status).toBe(401);
  });

  it('moves a token to the account that registers it last (an account switch on one phone)', async () => {
    const f = fixture();
    const a = await f.guest();
    const b = await f.guest();
    await f.register(a, token(7));
    await f.register(b, token(7), 'android');
    expect(await f.repos.devices.pushTargets([a.userId])).toEqual([]);
    expect((await f.repos.devices.pushTargets([b.userId])).map((t) => t.token)).toEqual([token(7)]);
  });

  it('reports pushEnabled in /api/config and /health only with a client', async () => {
    expect((await fixture().call('GET', '/api/config')).json.pushEnabled).toBe(true);
    const off = fixture({ client: null });
    expect((await off.call('GET', '/api/config')).json.pushEnabled).toBe(false);
    expect((await off.call('GET', '/health')).json.pushEnabled).toBe(false);
  });
});

describe('push triggers', () => {
  async function club(f: ReturnType<typeof fixture>, approval = false) {
    const owner = await f.guest('Ah-Hua');
    const members = [await f.guest('Bao'), await f.guest('Chen')];
    const c = (await f.call('POST', '/api/clubs', { name: 'Tea House', settings: { joinRequiresApproval: approval } }, owner.auth)).json as unknown as Club;
    if (!approval) for (const m of members) await f.call('POST', `/api/clubs/${c.code}/join`, {}, m.auth);
    return { owner, members, code: c.code };
  }

  it('club table opened: every member with a token except the opener, in their language', async () => {
    const f = fixture();
    const { owner, members, code } = await club(f);
    await f.register(owner, token('owner'));
    await f.register(members[0], token('bao'));
    // Chen has no token. Bao's device speaks Chinese.
    const bao = (await f.repos.devices.listForUser(members[0].userId))[0];
    await f.repos.devices.update(bao.id, { locale: 'zh-TW' });
    const res = await f.call('POST', `/api/clubs/${code}/tables`, { label: 'Friday' }, owner.auth);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(f.client!.sent).toHaveLength(1));
    const [msg] = f.client!.sent;
    expect(msg).toMatchObject({ to: token('bao'), title: 'Tea House', data: { kind: 'club_table_opened', club: code, room: res.json.code } });
    expect(msg.body).toBe('Ah-Hua 開了一桌，點一下入座。');
  });

  it('join approved: the player who asked', async () => {
    const f = fixture();
    const { owner, members, code } = await club(f, true);
    await f.call('POST', `/api/clubs/${code}/join`, {}, members[1].auth);
    await f.register(members[1], token('chen'));
    await f.call('POST', `/api/clubs/${code}/members/${members[1].userId}/approve`, {}, owner.auth);
    await vi.waitFor(() => expect(f.client!.sent).toHaveLength(1));
    expect(f.client!.sent[0]).toMatchObject({ to: token('chen'), title: 'Tea House', body: 'Your request to join has been approved. Welcome to the club!', data: { kind: 'join_approved', club: code } });
  });

  it('sends each kind at most once a minute per user', async () => {
    let t = 1_000_000;
    const client = new FakeExpo();
    const f = fixture({ client, now: () => t });
    const a = await f.guest();
    await f.register(a, token('a'));
    expect(await f.push.tableWaiting(a.userId, 'ROOM01')).toEqual({ sent: 1, limited: 0 });
    expect(await f.push.tableWaiting(a.userId, 'ROOM02')).toEqual({ sent: 0, limited: 1 });
    // Another kind is not limited by the first.
    expect((await f.push.notify([a.userId], 'join_approved', { club: 'X' })).sent).toBe(1);
    t += 60_000;
    expect((await f.push.tableWaiting(a.userId, 'ROOM03')).sent).toBe(1);
    expect(client.sent.map((m) => (m.data as { kind: string }).kind)).toEqual(['table_waiting', 'join_approved', 'table_waiting']);
  });

  it('DeviceNotRegistered on a ticket or on a receipt clears the token', async () => {
    const client = new FakeExpo();
    const f = fixture({ client });
    const a = await f.guest();
    const b = await f.guest();
    await f.register(a, token('a'));
    await f.register(b, token('b'));
    client.gone.add(token('a'));
    await f.push.notify([a.userId, b.userId], 'join_approved', { club: 'X' });
    expect(await f.repos.devices.pushTargets([a.userId])).toEqual([]);
    expect(f.push.pendingReceipts).toBe(1);
    // b's receipt arrives later as DeviceNotRegistered.
    client.receipts['ticket-1'] = { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } };
    expect(await f.push.checkReceipts()).toEqual({ checked: 1, cleared: 1 });
    expect(await f.repos.devices.pushTargets([b.userId])).toEqual([]);
    expect(f.push.pendingReceipts).toBe(0);
  });

  it('does nothing without a client or without tokens, and never throws', async () => {
    const off = fixture({ client: null });
    const a = await off.guest();
    await off.register(a, token('a'));
    expect(await off.push.tableWaiting(a.userId, 'ROOM01')).toEqual({ sent: 0, limited: 0 });
    const on = fixture();
    const b = await on.guest();
    expect(await on.push.tableWaiting(b.userId, 'ROOM01')).toEqual({ sent: 0, limited: 0 });
    on.client!.sendPushNotificationsAsync = async () => {
      throw new Error('Expo is down');
    };
    await on.register(b, token('b'));
    expect(await on.push.tableWaiting(b.userId, 'ROOM01')).toEqual({ sent: 0, limited: 0 });
  });
});

/** A TableClient seated at a hosted table through the registry, as the socket layer would do it. */
function seat(rooms: RoomRegistry, code: string, userId: string, token?: string) {
  const handlers = new Set<(m: HostMessage) => void>();
  const socket: Socket = {
    send: (j) => {
      const m = JSON.parse(j) as { t: string; data?: { ch?: string; msg?: unknown } };
      if (m.t === 'from' && m.data?.ch === 'game') for (const h of handlers) h(m.data.msg as HostMessage);
    },
    close: () => undefined,
  };
  const id = rooms.hello(rooms.connect(socket), userId);
  rooms.handle(id, { t: 'join', room: code });
  const link: Link = {
    send: (msg) => rooms.handle(id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg } }),
    onMessage: (cb) => (handlers.add(cb), () => handlers.delete(cb)),
    close: () => rooms.disconnect(id),
  };
  const client = new TableClient(link, 'Alice', undefined, { token });
  client.join();
  return { client, peerId: id };
}

describe('SeatWatcher ("your table is waiting")', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls once when a seated human has been gone 30 s mid-hand, and again only after they return and drop again', () => {
    let t = 0;
    // Bots wait ten minutes of fake time, so the hand stays in play while the test runs.
    const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 600_000, now: () => t });
    const code = rooms.createHostedRoom();
    const alice = seat(rooms, code, 'user-alice-1');
    const waiting: Array<[string, string]> = [];
    const watcher = new SeatWatcher(rooms, (userId, room) => waiting.push([userId, room]), { now: () => t });
    rooms.hostedTable(code)!.start();
    expect(rooms.hostedTable(code)!.phase).toBe('playing');
    watcher.tick();
    rooms.disconnect(alice.peerId);
    watcher.tick();
    t += 29_999;
    watcher.tick();
    expect(waiting).toEqual([]);
    t += 1;
    watcher.tick();
    watcher.tick();
    expect(waiting).toEqual([['user-alice-1', code]]);
    // Back, then gone again: a fresh 30 s.
    const again = seat(rooms, code, 'user-alice-1', alice.client.state.token!);
    expect(rooms.hostedTable(code)!.seatInfo()[0].connected).toBe(true);
    watcher.tick();
    rooms.disconnect(again.peerId);
    watcher.tick();
    t += 30_000;
    watcher.tick();
    expect(waiting).toHaveLength(2);
  });

  it('ignores the lobby (nobody is waiting before the hand starts)', () => {
    let t = 0;
    // Bots wait ten minutes of fake time, so the hand stays in play while the test runs.
    const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 600_000, now: () => t });
    const code = rooms.createHostedRoom();
    const alice = seat(rooms, code, 'user-alice-1');
    const waiting: string[] = [];
    const watcher = new SeatWatcher(rooms, (userId) => waiting.push(userId), { now: () => t });
    rooms.disconnect(alice.peerId);
    t += 60_000;
    watcher.tick();
    expect(waiting).toEqual([]);
  });
});

describe('server wiring', () => {
  it('createSignalServer sends club pushes through the injected service', async () => {
    const repos = createRepos();
    const sessions = new SessionService(repos.repos, { pepper: 'push-pepper-0123456789' });
    const client = new FakeExpo();
    const push = new PushService({ devices: repos.repos.devices, client, log: () => {} });
    const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions, providers: {}, config: loadConfig({}), log: () => undefined, push });
    try {
      const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => request(server.api, method, url, body, headers, `10.9.0.${Math.floor(Math.random() * 250)}`);
      const guest = async (displayName: string) => {
        const res = await call('POST', '/api/auth/guest', { device: { id: crypto.randomUUID(), platform: 'ios' }, displayName });
        return { authorization: `Bearer ${(res.json.session as { token: string }).token}` };
      };
      const owner = await guest('Ah-Hua');
      const bao = await guest('Bao');
      const c = (await call('POST', '/api/clubs', { name: 'Tea House' }, owner)).json as unknown as Club;
      await call('POST', `/api/clubs/${c.code}/join`, {}, bao);
      await call('POST', '/api/push/token', { token: token('bao'), platform: 'android' }, bao);
      expect((await call('POST', `/api/clubs/${c.code}/tables`, {}, owner)).status).toBe(200);
      await vi.waitFor(() => expect(client.sent.map((m) => m.to)).toEqual([token('bao')]));
      expect((await call('GET', '/api/config')).json.pushEnabled).toBe(true);
    } finally {
      await server.close();
    }
  });
});
