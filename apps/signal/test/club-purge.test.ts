/**
 * A club outlives the hard delete of a member's account. Thirty days after an account is deleted
 * the hourly purge removes the user row (and, in Postgres, the club rows that reference it); the
 * club registry still holds the "Deleted player" row in memory and must go on saving the club.
 * Run against memory and (with DATABASE_URL_TEST) Postgres, where the foreign keys are real.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, randomHex } from '@mjm/engine';
import { createApiHandler } from '../src/api';
import { SessionService, purgeDeletedUsers } from '../src/auth';
import { ClubRegistry, type Club } from '../src/clubs';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { RoomRegistry } from '../src/rooms';
import { PEPPER, request } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);

/** The real API and club registry over the given repositories, with a clock the test moves. */
function fixture(repos: Repos) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const sessions = new SessionService(repos, { pepper: PEPPER, now });
  const clubs = new ClubRegistry({ store: repos.clubs, now, retryDelayMs: 5 });
  const rooms = new RoomRegistry({ allowHosted: true, now });
  const handler = createApiHandler({ clubs, rooms, repos, sessions, now });
  let n = 0;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => request(handler, method, url, body, headers, `10.9.${Math.floor(++n / 250)}.${n % 250}`);
  const guest = async (displayName: string) => {
    const res = await call('POST', '/api/auth/guest', { device: { id: randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' }, displayName });
    expect(res.status).toBe(201);
    return { userId: res.json.userId as string, guestSecret: res.json.guestSecret as string, auth: { authorization: `Bearer ${(res.json.session as { token: string }).token}` } };
  };
  /** A session ends after 30 days: sign the guest in again on the same device. */
  const signIn = async (g: { userId: string; guestSecret: string; auth: Record<string, string> }) => {
    const res = await call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret });
    expect(res.status).toBe(200);
    g.auth = { authorization: `Bearer ${(res.json.session as { token: string }).token}` };
  };
  /** What a restarted server would read back. */
  const restarted = async () => {
    const fresh = new ClubRegistry({ store: repos.clubs, now });
    await fresh.load();
    return fresh;
  };
  return { clock, now, clubs, repos, call, guest, signIn, restarted };
}

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    it('keeps saving a club after a deleted member is purged, and drops the departed rows', async () => {
      const f = fixture(repos());
      const [owner, alice, dee, asker] = [await f.guest('Owner'), await f.guest('Alice'), await f.guest('Dee'), await f.guest('Asker')];
      const club = (await f.call('POST', '/api/clubs', { name: 'Purge club' }, owner.auth)).json as unknown as Club;
      for (const g of [alice, dee]) expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth)).json.status).toBe('joined');
      // Dee bans a griefer as an admin before she goes: the ban she made stays.
      const griefer = await f.guest('Griefer');
      await f.call('POST', `/api/clubs/${club.code}/join`, {}, griefer.auth);
      expect((await f.call('POST', `/api/clubs/${club.code}/members/${dee.userId}/role`, { role: 'admin' }, owner.auth)).status).toBe(200);
      expect((await f.call('POST', `/api/clubs/${club.code}/bans`, { userId: griefer.userId }, dee.auth)).status).toBe(200);

      expect((await f.call('DELETE', '/api/me', undefined, dee.auth)).status).toBe(204);
      await f.clubs.flush();
      expect(f.clubs.club(club.code).members.map((m) => m.name)).toEqual(['Owner', 'Alice', 'Deleted player']);

      // 31 days on, the hourly pruner hard-deletes the account and tells the registry (server.ts).
      f.clock.now += 31 * DAY;
      const purged = await purgeDeletedUsers(f.repos, { now: f.now });
      expect(purged.userIds).toEqual([dee.userId]);
      expect(f.clubs.dropPurged(purged.userIds)).toEqual([club.code]);
      expect(f.clubs.club(club.code).members.map((m) => m.name)).toEqual(['Owner', 'Alice']);

      // The club still changes and saves: a new member, a join request, a new description.
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const eve = await f.guest('Eve');
        await f.signIn(owner);
        await f.signIn(asker);
        expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, eve.auth)).json.status).toBe('joined');
        expect((await f.call('PATCH', `/api/clubs/${club.code}`, { description: 'Thursday league', settings: { joinRequiresApproval: true } }, owner.auth)).status).toBe(200);
        expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, asker.auth)).json.status).toBe('pending');
        await f.clubs.flush();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
      expect(f.clubs.unsaved).toEqual([]);

      const after = (await f.restarted()).club(club.code);
      expect(after.members.map((m) => m.name).sort()).toEqual(['Alice', 'Eve', 'Owner']);
      expect(after.pending.map((p) => p.name)).toEqual(['Asker']);
      expect(after.description).toBe('Thursday league');
      expect(after.bans!.map((b) => [b.name, b.by])).toEqual([['Griefer', dee.userId]]);
    });

    it('saves a club whose copy in memory still names purged accounts', async () => {
      // The registry was never told about the purge (a crash between the two steps): the save
      // itself must skip the rows whose user has gone, not fail the whole club.
      const f = fixture(repos());
      const [owner, alice, dee, asker, opener] = [await f.guest('Owner'), await f.guest('Alice'), await f.guest('Dee'), await f.guest('Asker'), await f.guest('Opener')];
      const club = (await f.call('POST', '/api/clubs', { name: 'Stale copy', settings: { joinRequiresApproval: true } }, owner.auth)).json as unknown as Club;
      for (const g of [alice, dee, asker, opener]) {
        expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth)).json.status).toBe('pending');
        if (g !== asker) expect((await f.call('POST', `/api/clubs/${club.code}/members/${g.userId}/approve`, {}, owner.auth)).status).toBe(200);
      }
      await f.clubs.flush();
      const stale = structuredClone(f.clubs.club(club.code));
      // A table the departed member opened, and a ban she made, are still listed.
      stale.tables.push({ code: `${club.code.slice(0, 4)}T1`, label: 'Old table', rules: { ...DEFAULT_RULES }, createdBy: opener.userId, createdAt: T0, status: 'finished', players: [], handNumber: 4, scores: [0, 0, 0, 0] });
      stale.bans = [{ userId: randomUUID(), name: 'Gone griefer', bannedAt: T0, by: dee.userId }];

      for (const g of [dee, asker, opener]) expect((await f.call('DELETE', '/api/me', undefined, g.auth)).status).toBe(204);
      await f.clubs.flush();
      f.clock.now += 31 * DAY;
      expect((await purgeDeletedUsers(f.repos, { now: f.now })).users).toBe(3);

      stale.description = 'Saved after the purge';
      await f.repos.clubs.save(stale);
      const back = (await f.repos.clubs.get(club.code))!;
      expect(back.description).toBe('Saved after the purge');
      expect(back.ownerId).toBe(owner.userId);
      expect(back.tables.map((t) => [t.label, t.createdBy])).toEqual([['Old table', opener.userId]]);
      expect(back.bans!.map((b) => [b.name, b.by])).toEqual([['Gone griefer', dee.userId]]);
      // Only Postgres drops the rows on its own (the foreign key); memory keeps what it was given.
      if (f.repos.kind === 'pg') {
        expect(back.members.map((m) => m.name).sort()).toEqual(['Alice', 'Owner']);
        expect(back.pending).toEqual([]);
      }
    });

    it('keeps the stored owner when the copy in memory names an owner that no longer exists', async () => {
      const f = fixture(repos());
      const owner = await f.guest('Owner');
      const club = (await f.call('POST', '/api/clubs', { name: 'Owner gone' }, owner.auth)).json as unknown as Club;
      await f.clubs.flush();
      const stale = structuredClone(f.clubs.club(club.code));
      stale.ownerId = randomUUID();
      stale.name = 'Renamed';
      await f.repos.clubs.save(stale);
      const back = (await f.repos.clubs.get(club.code))!;
      expect(back.name).toBe('Renamed');
      if (f.repos.kind === 'pg') expect(back.ownerId).toBe(owner.userId);
    });

    it('passes on a club that a purged account still owned in memory', async () => {
      const f = fixture(repos());
      const [owner, alice] = [await f.guest('Owner'), await f.guest('Alice')];
      const club = (await f.call('POST', '/api/clubs', { name: 'Fell behind' }, owner.auth)).json as unknown as Club;
      await f.call('POST', `/api/clubs/${club.code}/join`, {}, alice.auth);
      const solo = (await f.call('POST', '/api/clubs', { name: 'Nobody else' }, owner.auth)).json as unknown as Club;
      expect(f.clubs.dropPurged([owner.userId]).sort()).toEqual([club.code, solo.code].sort());
      expect(f.clubs.club(club.code).ownerId).toBe(alice.userId);
      expect(f.clubs.club(club.code).members.map((m) => [m.name, m.role])).toEqual([['Alice', 'owner']]);
      expect(() => f.clubs.club(solo.code)).toThrow(/not found/i);
      await f.clubs.flush();
      expect(f.clubs.unsaved).toEqual([]);
    });
  });
}

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('club and purged accounts (memory)', () => memory);

describe.skipIf(!PG_URL)('club and purged accounts (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_club_purge_' + randomHex(6);

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => {} });
    pg = createPgRepos(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  contract('contract', () => pg);
});
