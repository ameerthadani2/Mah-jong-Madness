/**
 * Accounts and the moderators' tools, on the memory repositories and (with DATABASE_URL_TEST) on
 * Postgres: a refused name never blocks sign-in, the birth year is write-once, a ban covers the
 * banned account's devices, guest sign-ups that carry one device id at the same moment all
 * succeed, and two moderators deciding one report apply one action.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createApiHandler } from '../src/api';
import { SessionService } from '../src/auth';
import { ClubRegistry } from '../src/clubs';
import { createPool, type Pool } from '../src/db';
import { quickMatchCheck } from '../src/matchmaking';
import { migrate } from '../src/migrate';
import { MuteList } from '../src/moderation';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { RoomRegistry } from '../src/rooms';
import { PEPPER, request } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const ADMIN = 'admin-token-for-tests-0123456789';
const adminAuth = { authorization: `Bearer ${ADMIN}` };

interface Guest {
  status: number;
  userId: string;
  guestSecret: string;
  auth: Record<string, string>;
  json: Record<string, unknown>;
}

/** The real API over the given repositories; every request comes from its own address. */
function api(repos: Repos, opts: { adminToken?: string | null; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const sessions = new SessionService(repos, { pepper: PEPPER, now });
  const mutes = new MuteList(now);
  const closed: string[] = [];
  const handler = createApiHandler({
    clubs: new ClubRegistry({ store: repos.clubs, now }),
    rooms: new RoomRegistry({ allowHosted: true, now }),
    repos,
    sessions,
    now,
    mutes,
    adminToken: opts.adminToken === undefined ? ADMIN : opts.adminToken,
    matchmaker: { blocksChanged: () => undefined, removeUser: (id) => closed.push(id) },
  });
  let n = 0;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => request(handler, method, url, body, headers, `10.9.${Math.floor(++n / 250)}.${n % 250}`);
  const signUp = async (body: Record<string, unknown>): Promise<Guest> => {
    const res = await call('POST', '/api/auth/guest', body);
    const token = (res.json.session as { token: string } | undefined)?.token ?? '';
    return { status: res.status, userId: res.json.userId as string, guestSecret: res.json.guestSecret as string, auth: { authorization: `Bearer ${token}` }, json: res.json };
  };
  const guest = (displayName?: string, deviceId: string = randomUUID()) => signUp({ device: { id: deviceId, platform: 'ios' }, displayName });
  return { handler, call, guest, signUp, mutes, removedFromQueue: closed, repos };
}

function suite(name: string, open: () => Repos) {
  describe(name, () => {
    describe('a name the check refuses', () => {
      it('never blocks guest sign-in: the guest is created without the name and the reply says so', async () => {
        const f = api(open());
        for (const displayName of ['Admin', 'Official Support', '官方客服', 'f*ck']) {
          const g = await f.guest(displayName);
          expect(g.status, displayName).toBe(201);
          expect(g.json.nameRefused, displayName).toBe(true);
          expect((g.json.user as { displayName: string }).displayName).toBe('');
          expect((await f.repos.users.get(g.userId))!.displayName).toBe('');
          // The session works like any other.
          expect((await f.call('GET', '/api/me', undefined, g.auth)).status).toBe(200);
        }
        const ok = await f.guest('Brad Min');
        expect(ok.status).toBe(201);
        expect('nameRefused' in ok.json).toBe(false);
        expect((ok.json.user as { displayName: string }).displayName).toBe('Brad Min');
        const none = await f.guest(undefined);
        expect('nameRefused' in none.json).toBe(false);
      });

      it('is still answered 400 name_not_allowed when an account renames itself', async () => {
        const f = api(open());
        const g = await f.guest('Mei');
        const res = await f.call('PATCH', '/api/me', { displayName: 'Admin' }, g.auth);
        expect(res.status).toBe(400);
        expect(res.json.error).toBe('name_not_allowed');
        expect((await f.repos.users.get(g.userId))!.displayName).toBe('Mei');
      });
    });

    describe('the birth year', () => {
      it('is set once: the same year again is fine, any other year or clearing it answers 409 birth_year_locked', async () => {
        const f = api(open());
        const g = await f.guest('Kid');
        const first = await f.call('PATCH', '/api/me', { birthYear: 2014 }, g.auth);
        expect(first.status).toBe(200);
        expect((first.json.user as { birthYear: number }).birthYear).toBe(2014);
        expect((await f.call('PATCH', '/api/me', { birthYear: 2014, avatar: 'gent' }, g.auth)).status).toBe(200);
        for (const birthYear of [1990, 2008, 2015, null]) {
          const res = await f.call('PATCH', '/api/me', { birthYear, displayName: 'Changed' }, g.auth);
          expect(res.status, String(birthYear)).toBe(409);
          expect(res.json.error).toBe('birth_year_locked');
        }
        // A refused change changes nothing else either.
        expect(await f.repos.users.get(g.userId)).toMatchObject({ birthYear: 2014, displayName: 'Kid', avatar: 'gent' });
        // Other fields still change with the year left out.
        expect((await f.call('PATCH', '/api/me', { displayName: 'Kiddo' }, g.auth)).status).toBe(200);
        expect((await f.repos.users.get(g.userId))!.birthYear).toBe(2014);
      });

      it('an account that declared itself under 18 stays out of quick match whatever it sends afterwards', async () => {
        const repos = open();
        const f = api(repos);
        const g = await f.guest('Kid');
        const at = Date.UTC(2026, 10, 10);
        expect(await quickMatchCheck(repos, g.userId, at)).toBe('age_missing');
        await f.call('PATCH', '/api/me', { birthYear: 2014 }, g.auth);
        expect(await quickMatchCheck(repos, g.userId, at)).toBe('age_under');
        expect((await f.call('PATCH', '/api/me', { birthYear: 1990 }, g.auth)).status).toBe(409);
        expect(await quickMatchCheck(repos, g.userId, at)).toBe('age_under');
      });

      it('is corrected by a moderator only: POST /api/admin/users/:id/birth-year', async () => {
        const f = api(open());
        const g = await f.guest('Typo');
        await f.call('PATCH', '/api/me', { birthYear: 2019 }, g.auth);
        const url = `/api/admin/users/${g.userId}/birth-year`;
        expect((await f.call('POST', url, { birthYear: 1991 }, g.auth)).status).toBe(401);
        expect((await f.call('POST', url, { birthYear: 1991 }, { authorization: 'Bearer wrong' })).status).toBe(401);
        for (const bad of [{ birthYear: 1850 }, { birthYear: '1991' }, {}, { birthYear: 1991.5 }]) expect((await f.call('POST', url, bad, adminAuth)).status).toBe(400);
        const fixed = await f.call('POST', url, { birthYear: 1991 }, adminAuth);
        expect(fixed.status).toBe(200);
        expect(fixed.json.account).toMatchObject({ id: g.userId, birthYear: 1991 });
        expect((await f.repos.users.get(g.userId))!.birthYear).toBe(1991);
        // Cleared by the moderator, the account may give its year once more.
        expect((await f.call('POST', url, { birthYear: null }, adminAuth)).json.account).toMatchObject({ birthYear: null });
        expect((await f.call('PATCH', '/api/me', { birthYear: 1992 }, g.auth)).status).toBe(200);
        expect((await f.call('PATCH', '/api/me', { birthYear: 1993 }, g.auth)).status).toBe(409);
        expect((await f.call('POST', `/api/admin/users/${randomUUID()}/birth-year`, { birthYear: 1991 }, adminAuth)).status).toBe(404);
        const off = api(open(), { adminToken: null });
        expect((await off.call('POST', url, { birthYear: 1991 }, adminAuth)).status).toBe(503);
      });
    });

    describe('guest sign-ups that carry one device id', () => {
      it('all succeed when they arrive at the same moment, each with its own account and device', async () => {
        const f = api(open());
        const deviceId = randomUUID();
        const results = await Promise.all([0, 1, 2, 3].map((i) => f.guest(`Tap ${i}`, deviceId)));
        expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
        expect(new Set(results.map((r) => r.userId)).size).toBe(4);
        const devices = (await Promise.all(results.map((r) => f.repos.devices.listForUser(r.userId)))).flat();
        expect(devices).toHaveLength(4);
        expect(new Set(devices.map((d) => d.id)).size).toBe(4);
        // One of them got the id the app sent; the others remember it as their install.
        expect(devices.filter((d) => d.id === deviceId)).toHaveLength(1);
        expect(devices.filter((d) => d.id !== deviceId).every((d) => d.installId === deviceId)).toBe(true);
        for (const r of results) expect((await f.call('GET', '/api/me', undefined, r.auth)).status).toBe(200);
      });

      it('the repository says whether a device id was free instead of failing on a taken one', async () => {
        const repos = open();
        const user = await repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: 0 });
        const device = { id: randomUUID(), userId: user.id, platform: 'ios', appBuild: null, pushToken: null, locale: null, createdAt: 1, lastSeenAt: 1 };
        expect(await repos.devices.create(device)).toBe(true);
        expect(await repos.devices.create({ ...device, platform: 'android' })).toBe(false);
        expect((await repos.devices.get(device.id))!.platform).toBe('ios');
        // Inside a transaction a taken id does not spoil the rest of the work.
        const other = randomUUID();
        await repos.transaction(async (tx) => {
          expect(await tx.devices.create(device)).toBe(false);
          expect(await tx.devices.create({ ...device, id: other, installId: device.id })).toBe(true);
        });
        expect(await repos.devices.get(other)).toMatchObject({ id: other, installId: device.id });
      });
    });

    describe('a ban covers the devices of the banned account', () => {
      it('refuses a new guest from the banned device with 403 banned until the ban is lifted', async () => {
        const f = api(open());
        const deviceId = randomUUID();
        const griefer = await f.guest('Griefer', deviceId);
        expect(griefer.status).toBe(201);
        expect((await f.call('POST', `/api/admin/users/${griefer.userId}/ban`, { reason: 'abuse' }, adminAuth)).status).toBe(200);
        // "Start fresh" on the same phone, in any letter case of the id.
        for (const id of [deviceId, deviceId.toUpperCase()]) {
          const fresh = await f.guest('Fresh', id);
          expect(fresh.status).toBe(403);
          expect(fresh.json.error).toBe('banned');
        }
        // Another phone is not affected.
        expect((await f.guest('Other')).status).toBe(201);
        expect((await f.call('DELETE', `/api/admin/users/${griefer.userId}/ban`, undefined, adminAuth)).status).toBe(200);
        expect((await f.guest('Fresh', deviceId)).status).toBe(201);
      });

      it('finds the phone whichever of its accounts was banned, and keeps it banned while any of them is', async () => {
        const f = api(open());
        const deviceId = randomUUID();
        // Two accounts made on one install: the second one's device has an id of its own.
        const first = await f.guest('First', deviceId);
        const second = await f.guest('Second', deviceId);
        expect((await f.repos.devices.listForUser(second.userId))[0]).toMatchObject({ installId: deviceId });
        await f.call('POST', `/api/admin/users/${second.userId}/ban`, {}, adminAuth);
        expect((await f.guest('Third', deviceId)).json.error).toBe('banned');
        // The account that was not banned still signs in on that phone.
        expect((await f.call('POST', '/api/auth/guest/login', { userId: first.userId, guestSecret: first.guestSecret, device: { id: deviceId } })).status).toBe(200);
        await f.call('POST', `/api/admin/users/${first.userId}/ban`, {}, adminAuth);
        await f.call('DELETE', `/api/admin/users/${second.userId}/ban`, undefined, adminAuth);
        expect((await f.guest('Third', deviceId)).json.error).toBe('banned');
        await f.call('DELETE', `/api/admin/users/${first.userId}/ban`, undefined, adminAuth);
        expect((await f.guest('Third', deviceId)).status).toBe(201);
      });

      it('a ban through a report covers the devices too', async () => {
        const f = api(open());
        const deviceId = randomUUID();
        const reporter = await f.guest('Mei');
        const rude = await f.guest('Rude', deviceId);
        const report = (await f.call('POST', '/api/reports', { reportedUserId: rude.userId, reason: 'abusive_chat' }, reporter.auth)).json.id as number;
        expect((await f.call('POST', `/api/admin/reports/${report}/resolve`, { action: 'ban' }, adminAuth)).status).toBe(200);
        expect(await f.repos.moderation.deviceBanned(deviceId)).toBe(true);
        expect((await f.guest('Again', deviceId)).status).toBe(403);
        expect(f.removedFromQueue).toEqual([rude.userId]);
      });
    });

    describe('two moderators, one report', () => {
      it('one decision is applied and recorded; the other is told the report is closed and changes nothing', async () => {
        const f = api(open());
        const reporter = await f.guest('Mei');
        const rude = await f.guest('Rude');
        const report = (await f.call('POST', '/api/reports', { reportedUserId: rude.userId, reason: 'abusive_chat' }, reporter.auth)).json.id as number;
        const url = `/api/admin/reports/${report}/resolve`;
        const [mute, ban] = await Promise.all([f.call('POST', url, { action: 'mute', days: 3 }, adminAuth), f.call('POST', url, { action: 'ban' }, adminAuth)]);
        expect([mute.status, ban.status].sort()).toEqual([200, 409]);
        const won = mute.status === 200 ? 'mute' : 'ban';
        const lost = won === 'mute' ? ban : mute;
        expect(lost.json.error).toBe('resolved');
        const row = (await f.repos.reports.get(report))!;
        expect(row).toMatchObject({ status: 'actioned', resolution: won });
        expect(typeof row.resolvedAt).toBe('number');
        // Only the decision that won was applied to the account.
        const status = (await f.repos.moderation.status(rude.userId))!;
        expect(status.bannedAt !== null).toBe(won === 'ban');
        expect(status.mutedUntil !== null).toBe(won === 'mute');
        expect(f.mutes.isMuted(rude.userId)).toBe(won === 'mute');
        expect((await f.call('GET', '/api/me', undefined, rude.auth)).status).toBe(won === 'ban' ? 403 : 200);
        expect(f.removedFromQueue).toEqual(won === 'ban' ? [rude.userId] : []);
      });

      it('many at once: exactly one of twelve decisions wins', async () => {
        const f = api(open());
        const reporter = await f.guest('Mei');
        const rude = await f.guest('Rude');
        const report = (await f.call('POST', '/api/reports', { reportedUserId: rude.userId, reason: 'stalling' }, reporter.auth)).json.id as number;
        const actions = ['dismiss', 'warn', 'ban', 'mute'] as const;
        const answers = await Promise.all(
          Array.from({ length: 12 }, (_, i) => f.call('POST', `/api/admin/reports/${report}/resolve`, { action: actions[i % 4], days: 2 }, adminAuth).then((r) => ({ action: actions[i % 4], status: r.status }))),
        );
        const winners = answers.filter((a) => a.status === 200);
        expect(winners).toHaveLength(1);
        expect(answers.filter((a) => a.status === 409)).toHaveLength(11);
        const won = winners[0].action;
        expect(await f.repos.reports.get(report)).toMatchObject({ status: won === 'dismiss' ? 'dismissed' : 'actioned', resolution: won });
        const status = (await f.repos.moderation.status(rude.userId))!;
        expect(status.bannedAt !== null).toBe(won === 'ban');
        expect(status.mutedUntil !== null).toBe(won === 'mute');
      });

      it('claiming a report is a single write that only one caller wins', async () => {
        const repos = open();
        const [a, b] = await Promise.all([repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: 0 }), repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: 0 })]);
        const report = await repos.reports.create({ reporterId: a.id, reportedUserId: b.id, roomCode: null, reason: 'other', details: null, createdAt: 5 });
        expect(report.resolution).toBeUndefined();
        const claims = await Promise.all([repos.reports.claim(report.id, 'warn', 10), repos.reports.claim(report.id, 'ban', 11), repos.reports.claim(report.id, 'dismiss', 12)]);
        const got = claims.filter((c) => c !== null);
        expect(got).toHaveLength(1);
        expect(await repos.reports.get(report.id)).toEqual(got[0]);
        expect(got[0]).toMatchObject({ id: report.id, resolvedAt: expect.any(Number) });
        expect(await repos.reports.claim(report.id, 'warn', 20)).toBeNull();
        expect(await repos.reports.resolve(report.id, 'warn', 20)).toBe(false);
        expect(await repos.reports.claim(987_654, 'warn', 20)).toBeNull();
      });
    });
  });
}

suite('accounts and moderation (memory)', () => createMemoryRepos());

describe.skipIf(!PG_URL)('accounts and moderation (Postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let repos: Repos;
  const schema = 'mjm_modacc_' + randomHex(6);

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => undefined });
    repos = createPgRepos(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  suite('on Postgres', () => repos);

  it('banned devices go with a purge of the banned account', async () => {
    const user = await repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: 0 });
    const deviceId = randomUUID();
    await repos.devices.create({ id: deviceId, userId: user.id, platform: 'ios', appBuild: null, pushToken: null, locale: null, createdAt: 1, lastSeenAt: 1 });
    await repos.moderation.ban(user.id, 10, null);
    expect(await repos.moderation.deviceBanned(deviceId)).toBe(true);
    await repos.users.update(user.id, { deletedAt: 20 });
    expect(await repos.users.purgeDeleted(30)).toBeGreaterThanOrEqual(1);
    expect(await repos.moderation.deviceBanned(deviceId)).toBe(false);
  });
});
