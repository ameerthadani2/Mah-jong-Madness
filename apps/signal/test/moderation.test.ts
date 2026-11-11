/**
 * Moderation: the name blocklist on display names and club names, player blocks (with account
 * merge and deletion), bans (sign-in, refresh, sockets) and the moderators' routes behind
 * ADMIN_TOKEN, and mutes.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { link, SessionService } from '../src/auth';
import { MuteList, nameAllowed } from '../src/moderation';
import { createMemoryRepos } from '../src/repos';
import { BANNED_CLOSE_CODE, type Socket } from '../src/rooms';
import { apiFixture, PEPPER } from './helpers';

const ADMIN = 'admin-token-for-tests-0123456789';
const adminAuth = { authorization: `Bearer ${ADMIN}` };

describe('the name check', () => {
  it('refuses profanity, slurs and names that pose as staff, in English and Chinese', () => {
    for (const name of [
      'Admin',
      'admin123',
      'The Admin',
      'TheAdmin',
      '4dm1n',
      'A D M I N',
      'Moderator Mei',
      'Official',
      'mahjongofficial',
      'Staff',
      'Support',
      'GM',
      'gm_bob',
      'fuck',
      'Fuuuuck you',
      'f.u.c.k',
      'shit',
      'bitch',
      'whore',
      '官方',
      '非官方小王',
      '管理員',
      '管理员',
      '客服小美',
      '幹你娘',
      '靠北',
      '王八蛋',
    ]) {
      expect(nameAllowed(name), name).toBe(false);
    }
  });

  it('passes near misses: words that only contain a blocked one, and ordinary Chinese', () => {
    for (const name of [
      'Badminton Bob',
      'Stafford',
      'Modesty',
      'Gmail Fan',
      'Scunthorpe',
      'Cassandra',
      'Dickens',
      'Shitake Lover',
      'Therapist',
      'Spicy Noodle',
      'Grape',
      'Supportive Sam',
      'Mei',
      '阿明',
      '操作員小王',
      '體操選手',
      '幹部',
      '台北小美',
      '麻將達人',
      'Player 4',
    ]) {
      expect(nameAllowed(name), name).toBe(true);
    }
  });

  it('answers 400 name_not_allowed for a renamed account and a club name, after cleaning', async () => {
    const f = apiFixture();
    const g = await f.guest('Mei');
    // Cleaning first: an invisible character between the letters does not get "Admin" through.
    const zw = String.fromCodePoint(0x200b);
    for (const displayName of [`Ad${zw}min`, '官方客服']) {
      const res = await f.call('PATCH', '/api/me', { displayName }, g.auth);
      expect(res.status, displayName).toBe(400);
      expect(res.json.error).toBe('name_not_allowed');
    }
    expect((await f.call('PATCH', '/api/me', { displayName: 'Badminton Bob' }, g.auth)).status).toBe(200);
    const club = await f.call('POST', '/api/clubs', { name: 'Official Mahjong' }, g.auth);
    expect(club.status).toBe(400);
    expect(club.json.error).toBe('name_not_allowed');
    const ok = await f.call('POST', '/api/clubs', { name: 'Tea House' }, g.auth);
    expect(ok.status).toBe(200);
    const rename = await f.call('PATCH', `/api/clubs/${ok.json.code as string}`, { name: 'Staff' }, g.auth);
    expect(rename.status).toBe(400);
    expect(rename.json.error).toBe('name_not_allowed');
  });
});

describe('blocks', () => {
  it('add, list, remove; never yourself or an unknown player; quick match is told', async () => {
    const changed: string[] = [];
    const f = apiFixture({ deps: { matchmaker: { blocksChanged: (id) => changed.push(id), removeUser: () => undefined } } });
    const me = await f.guest('Mei');
    const rude = await f.guest('Rude');
    const added = await f.call('POST', '/api/blocks', { userId: rude.userId }, me.auth);
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ userId: rude.userId, displayName: 'Rude' });
    expect((await f.call('POST', '/api/blocks', { userId: rude.userId }, me.auth)).status).toBe(200);
    expect((await f.call('POST', '/api/blocks', { userId: me.userId }, me.auth)).status).toBe(400);
    expect((await f.call('POST', '/api/blocks', { userId: randomUUID() }, me.auth)).status).toBe(404);
    expect((await f.call('POST', '/api/blocks', { userId: 'nope' }, me.auth)).status).toBe(400);
    expect((await f.call('GET', '/api/blocks', undefined, {})).status).toBe(401);
    const list = await f.call('GET', '/api/blocks', undefined, me.auth);
    expect((list.json.blocks as Array<{ userId: string }>).map((b) => b.userId)).toEqual([rude.userId]);
    expect(changed).toEqual([me.userId, me.userId]);
    expect((await f.call('DELETE', `/api/blocks/${rude.userId}`, undefined, me.auth)).status).toBe(204);
    expect((await f.call('GET', '/api/blocks', undefined, me.auth)).json.blocks).toEqual([]);
  });

  it('move to the account a guest merges into, and go with a deletion', async () => {
    const repos = createMemoryRepos();
    const sessions = new SessionService(repos, { pepper: PEPPER });
    const mk = (kind: 'guest' | 'account') => repos.users.create({ id: randomUUID(), kind, displayName: 'P', createdAt: 0 });
    const [guest, account, rude, fan] = [await mk('guest'), await mk('account'), await mk('guest'), await mk('guest')];
    await repos.identities.create({ provider: 'apple', subject: 'apple-1', userId: account.id, secretHash: null, email: null, createdAt: 0 });
    await repos.blocks.add(guest.id, rude.id, 1);
    await repos.blocks.add(fan.id, guest.id, 2);
    const result = await link(repos, guest.id, { provider: 'apple', subject: 'apple-1' }, { sessions });
    expect(result.merged).toBe(true);
    expect((await repos.blocks.list(account.id)).map((b) => b.blockedId)).toEqual([rude.id]);
    expect(await repos.blocks.blockersOf(account.id)).toEqual([fan.id]);

    const f = apiFixture();
    const a = await f.guest('A');
    const b = await f.guest('B');
    await f.call('POST', '/api/blocks', { userId: b.userId }, a.auth);
    await f.call('POST', '/api/blocks', { userId: a.userId }, b.auth);
    expect((await f.call('DELETE', '/api/me', undefined, a.auth)).status).toBe(204);
    expect(await f.repos.blocks.list(a.userId)).toEqual([]);
    expect(await f.repos.blocks.list(b.userId)).toEqual([]);
  });
});

/** A socket that records how it was closed. */
function closingSocket(): Socket & { closed: number[] } {
  const closed: number[] = [];
  return { closed, send: () => undefined, close: (code) => closed.push(code ?? 0) };
}

describe('bans', () => {
  it('admin routes answer 503 without ADMIN_TOKEN and 401 with a wrong one', async () => {
    const off = apiFixture({ deps: { adminToken: null } });
    const g = await off.guest('Mei');
    expect((await off.call('GET', '/api/admin/reports', undefined, adminAuth)).status).toBe(503);
    expect((await off.call('POST', `/api/admin/users/${g.userId}/ban`, {}, adminAuth)).status).toBe(503);
    expect((await off.call('POST', `/api/admin/users/${g.userId}/mute`, { days: 1 }, adminAuth)).status).toBe(503);
    const on = apiFixture({ deps: { adminToken: ADMIN } });
    expect((await on.call('GET', '/api/admin/reports', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await on.call('GET', '/api/admin/reports', undefined, g.auth)).status).toBe(401);
  });

  it('a banned account is refused sign-in and refresh (403 banned), its sessions end and its sockets close with 4403', async () => {
    const banned: string[] = [];
    const f = apiFixture({ deps: { adminToken: ADMIN, matchmaker: { blocksChanged: () => undefined, removeUser: (id) => banned.push(id) } } });
    const g = await f.guest('Cheat');
    const socket = closingSocket();
    f.rooms.hello(f.rooms.connect(socket), g.userId, 'sess', 'Cheat');
    const res = await f.call('POST', `/api/admin/users/${g.userId}/ban`, { reason: 'collusion' }, adminAuth);
    expect(res.status).toBe(200);
    expect(res.json.account).toMatchObject({ id: g.userId, banReason: 'collusion' });
    expect(socket.closed).toEqual([BANNED_CLOSE_CODE]);
    expect(banned).toEqual([g.userId]);
    const me = await f.call('GET', '/api/me', undefined, g.auth);
    expect(me.status).toBe(403);
    expect(me.json.error).toBe('banned');
    const refresh = await f.call('POST', '/api/auth/refresh', {}, g.auth);
    expect(refresh.status).toBe(403);
    expect(refresh.json.error).toBe('banned');
    const login = await f.call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret });
    expect(login.status).toBe(403);
    expect(login.json.error).toBe('banned');
    // Unbanned, the account signs in again (its old sessions stay ended).
    expect((await f.call('DELETE', `/api/admin/users/${g.userId}/ban`, undefined, adminAuth)).status).toBe(200);
    expect((await f.call('GET', '/api/me', undefined, g.auth)).status).toBe(401);
    expect((await f.call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret })).status).toBe(200);
    expect((await f.call('POST', `/api/admin/users/${randomUUID()}/ban`, {}, adminAuth)).status).toBe(404);
  });

  it('the report queue lists the open reports with both accounts, and resolving acts on the reported account', async () => {
    const mutes = new MuteList();
    const f = apiFixture({ deps: { adminToken: ADMIN, mutes } });
    const reporter = await f.guest('Mei');
    const rude = await f.guest('Rude');
    const cheat = await f.guest('Cheat');
    const file = async (who: string, reason: string, roomCode?: string) =>
      (await f.call('POST', '/api/reports', { reportedUserId: who, reason, roomCode, details: 'at the table' }, reporter.auth)).json.id as number;
    const r1 = await file(rude.userId, 'abusive_chat', 'ABC234');
    const r2 = await file(cheat.userId, 'cheating');
    const r3 = await file(rude.userId, 'offensive_name');
    const r4 = await file(rude.userId, 'stalling');

    const queue = await f.call('GET', '/api/admin/reports?status=open', undefined, adminAuth);
    expect(queue.status).toBe(200);
    const reports = queue.json.reports as Array<Record<string, unknown>>;
    expect(reports.map((r) => r.id)).toEqual([r1, r2, r3, r4]);
    expect(reports[0]).toMatchObject({ reason: 'abusive_chat', room: 'ABC234', details: 'at the table', reporter: { id: reporter.userId, displayName: 'Mei' }, reported: { id: rude.userId, displayName: 'Rude', bannedAt: null } });
    expect((await f.call('GET', '/api/admin/reports?status=sideways', undefined, adminAuth)).status).toBe(400);

    expect((await f.call('POST', `/api/admin/reports/${r1}/resolve`, { action: 'mute' }, adminAuth)).status).toBe(400);
    const muted = await f.call('POST', `/api/admin/reports/${r1}/resolve`, { action: 'mute', days: 3 }, adminAuth);
    expect(muted.json).toMatchObject({ ok: true, status: 'actioned', action: 'mute' });
    expect(mutes.isMuted(rude.userId)).toBe(true);
    expect((await f.call('POST', `/api/admin/reports/${r1}/resolve`, { action: 'dismiss' }, adminAuth)).status).toBe(409);
    expect((await f.call('POST', `/api/admin/reports/${r3}/resolve`, { action: 'warn' }, adminAuth)).json.status).toBe('actioned');
    expect((await f.call('POST', `/api/admin/reports/${r4}/resolve`, { action: 'dismiss' }, adminAuth)).json.status).toBe('dismissed');
    expect((await f.call('POST', `/api/admin/reports/${r2}/resolve`, { action: 'ban' }, adminAuth)).json.status).toBe('actioned');
    expect((await f.call('GET', '/api/me', undefined, cheat.auth)).json.error).toBe('banned');
    expect((await f.call('GET', '/api/admin/reports', undefined, adminAuth)).json.reports).toEqual([]);
    expect((await f.call('POST', '/api/admin/reports/999999/resolve', { action: 'warn' }, adminAuth)).status).toBe(404);
  });

  it('mute and unmute from the admin route; the list forgets a mute once it ends', async () => {
    const clock = { now: Date.UTC(2026, 10, 9) };
    const mutes = new MuteList(() => clock.now);
    const f = apiFixture({ now: () => clock.now, deps: { adminToken: ADMIN, mutes } });
    const g = await f.guest('Loud');
    expect((await f.call('POST', `/api/admin/users/${g.userId}/mute`, { days: 400 }, adminAuth)).status).toBe(400);
    const res = await f.call('POST', `/api/admin/users/${g.userId}/mute`, { days: 1 }, adminAuth);
    expect(res.json.account).toMatchObject({ mutedUntil: new Date(clock.now + 86_400_000).toISOString() });
    expect(mutes.isMuted(g.userId)).toBe(true);
    clock.now += 86_400_001;
    expect(mutes.isMuted(g.userId)).toBe(false);
    await f.call('POST', `/api/admin/users/${g.userId}/mute`, { days: 2 }, adminAuth);
    await f.call('POST', `/api/admin/users/${g.userId}/mute`, { days: 0 }, adminAuth);
    expect(mutes.isMuted(g.userId)).toBe(false);
    // A fresh list loads the running mutes from the repositories (at boot).
    await f.call('POST', `/api/admin/users/${g.userId}/mute`, { days: 2 }, adminAuth);
    const fresh = new MuteList(() => clock.now);
    await fresh.load(f.repos);
    expect(fresh.isMuted(g.userId)).toBe(true);
  });
});
