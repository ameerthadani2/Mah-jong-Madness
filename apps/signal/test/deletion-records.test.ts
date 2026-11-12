/**
 * What is left of an account after it is deleted, in the records that outlive it. The privacy
 * text promises that the name goes at once; a finished match, a finished club season and the
 * note of a report all used to keep it for good. They now keep the scores, the reason and the
 * note under "Deleted player", at deletion and again at the 30-day purge (which also clears the
 * account id from finished matches). An account merge is not a deletion: the guest's seats and
 * season rows follow the account it was merged into. Run against memory and (with
 * DATABASE_URL_TEST) Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createApiHandler } from '../src/api';
import { createGuest, deleteAccount, link, purgeDeletedUsers, SessionService } from '../src/auth';
import { ClubRegistry, type Club } from '../src/clubs';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, DELETED_PLAYER_NAME, withoutName, type MatchPlayer, type Repos } from '../src/repos';
import { RoomRegistry } from '../src/rooms';
import { PEPPER, request } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);

/** The real API and club registry over the given repositories, with a clock the test moves. */
function fixture(repos: Repos) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const sessions = new SessionService(repos, { pepper: PEPPER, now });
  const clubs = new ClubRegistry({ store: repos.clubs, now, retryDelayMs: 5 });
  const rooms = new RoomRegistry({ allowHosted: true, now });
  const handler = createApiHandler({ clubs, rooms, repos, sessions, now });
  let n = 0;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => request(handler, method, url, body, headers, `10.8.${Math.floor(++n / 250)}.${n % 250}`);
  const guest = async (displayName: string) => {
    const res = await call('POST', '/api/auth/guest', { device: { id: randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' }, displayName });
    expect(res.status).toBe(201);
    return { userId: res.json.userId as string, auth: { authorization: `Bearer ${(res.json.session as { token: string }).token}` } };
  };
  /** A club with these members whose first season has been closed, so its history names them. */
  const clubWithSeason = async (name: string, owner: { auth: Record<string, string> }, members: Array<{ auth: Record<string, string> }>) => {
    const club = (await call('POST', '/api/clubs', { name }, owner.auth)).json as unknown as Club;
    for (const m of members) expect((await call('POST', `/api/clubs/${club.code}/join`, {}, m.auth)).json.status).toBe('joined');
    expect((await call('POST', `/api/clubs/${club.code}/season`, {}, owner.auth)).status).toBe(200);
    return club.code;
  };
  const room = () => 'D' + randomHex(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 5);
  const seats = (first: { userId: string; name: string }, second: { userId: string; name: string }): MatchPlayer[] => [
    { seat: 0, name: first.name, userId: first.userId, isBot: false },
    { seat: 1, name: second.name, userId: second.userId, isBot: false },
    { seat: 2, name: 'East wind bot', userId: null, isBot: true },
    { seat: 3, name: 'West wind bot', userId: null, isBot: true },
  ];
  const match = (roomCode: string, players: MatchPlayer[]) => repos.matchResults.record({ roomCode, clubCode: null, handCount: 4, scores: [120, -40, -40, -40], handsWon: [2, 1, 1, 0], finishedAt: clock.now, players });
  /** What a restarted server would read back. */
  const stored = async (code: string) => (await repos.clubs.get(code))!;
  return { clock, now, clubs, repos, sessions, call, guest, clubWithSeason, room, seats, match, stored };
}

const seasonRow = (club: Club, userId: string) => club.seasons![0].standings.find((r) => r.userId === userId);

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    it('takes a deleted account out of finished matches, finished seasons and report notes by name, and keeps the scores', async () => {
      const f = fixture(repos());
      const [owner, alice, bob] = [await f.guest('Owner'), await f.guest('Alice Probe'), await f.guest('Bob')];
      const stays = await f.clubWithSeason('She stays', owner, [alice, bob]);
      const left = await f.clubWithSeason('She left', owner, [alice]);
      // She leaves the second club: only its finished season still names her.
      expect((await f.call('DELETE', `/api/clubs/${left}/members/${alice.userId}`, undefined, alice.auth)).status).toBeLessThan(300);
      const room = f.room();
      await f.match(room, f.seats({ userId: alice.userId, name: 'Alice Probe' }, { userId: bob.userId, name: 'Bob' }));
      const byHer = await f.call('POST', '/api/reports', { reportedUserId: bob.userId, reason: 'stalling', details: 'Alice Probe here: Bob let his clock run out every turn' }, alice.auth);
      const aboutHer = await f.call('POST', '/api/reports', { reportedUserId: alice.userId, reason: 'offensive_name', details: 'alice probe is not a name, ALICE PROBE is an advert' }, bob.auth);
      const unrelated = await f.call('POST', '/api/reports', { reportedUserId: owner.userId, reason: 'other', details: 'Owner and Alice Probe were chatting' }, bob.auth);
      expect([byHer.status, aboutHer.status, unrelated.status]).toEqual([201, 201, 201]);
      await f.clubs.flush();
      expect(seasonRow(await f.stored(left), alice.userId)).toMatchObject({ name: 'Alice Probe', points: 0 });

      expect((await f.call('DELETE', '/api/me', undefined, alice.auth)).status).toBe(204);
      await f.clubs.flush();

      // The match keeps every seat and score; her seat has lost the name.
      const [result] = await f.repos.matchResults.listForRoom(room);
      expect(result.players).toEqual(f.seats({ userId: alice.userId, name: DELETED_PLAYER_NAME }, { userId: bob.userId, name: 'Bob' }));
      expect(result.scores).toEqual([120, -40, -40, -40]);
      expect(result.handsWon).toEqual([2, 1, 1, 0]);
      // Both clubs' finished seasons keep her row and its points, in the registry and in the store.
      for (const code of [stays, left]) {
        for (const club of [f.clubs.club(code), await f.stored(code)]) {
          expect(seasonRow(club, alice.userId)).toEqual({ userId: alice.userId, name: DELETED_PLAYER_NAME, points: 0 });
          expect(seasonRow(club, owner.userId)!.name).toBe('Owner');
        }
      }
      expect(seasonRow(await f.stored(stays), bob.userId)!.name).toBe('Bob');
      // Reports stay as moderation records; the notes of the ones by or about her no longer name her.
      expect((await f.repos.reports.get(byHer.json.id as number))!).toMatchObject({ reporterId: alice.userId, reason: 'stalling', details: 'Deleted player here: Bob let his clock run out every turn' });
      expect((await f.repos.reports.get(aboutHer.json.id as number))!.details).toBe('Deleted player is not a name, Deleted player is an advert');
      expect((await f.repos.reports.get(unrelated.json.id as number))!.details).toBe('Owner and Alice Probe were chatting');

      // A table she had sat at finishes after the deletion and is recorded under the seat's name.
      const late = f.room();
      await f.match(late, f.seats({ userId: alice.userId, name: 'Alice Probe' }, { userId: bob.userId, name: 'Bob' }));
      f.clock.now += 31 * DAY;
      const purged = await purgeDeletedUsers(f.repos, { now: f.now });
      expect(purged.userIds).toContain(alice.userId);
      f.clubs.dropPurged(purged.userIds);
      await f.clubs.flush();
      // After the purge the matches hold neither her name nor her account id.
      for (const code of [room, late]) {
        const [after] = await f.repos.matchResults.listForRoom(code);
        expect(after.players).toEqual([{ seat: 0, name: DELETED_PLAYER_NAME, userId: null, isBot: false }, ...f.seats({ userId: '', name: '' }, { userId: bob.userId, name: 'Bob' }).slice(1)]);
        expect(after.scores).toEqual([120, -40, -40, -40]);
      }
      for (const code of [stays, left]) expect(seasonRow(await f.stored(code), alice.userId)).toEqual({ userId: alice.userId, name: DELETED_PLAYER_NAME, points: 0 });
      const everything = JSON.stringify([await f.repos.matchResults.listForRoom(room), await f.repos.matchResults.listForRoom(late), await f.stored(stays), await f.stored(left), await f.repos.reports.listAbout(alice.userId), await f.repos.reports.listAbout(bob.userId)]);
      expect(everything).not.toMatch(/alice probe/i);
    });

    it('the deletion itself renames the stored season rows, without waiting for the club registry', async () => {
      const f = fixture(repos());
      const [owner, cara] = [await f.guest('Owner'), await f.guest('Cara')];
      const code = await f.clubWithSeason('Stored copy', owner, [cara]);
      expect((await f.call('DELETE', `/api/clubs/${code}/members/${cara.userId}`, undefined, cara.auth)).status).toBeLessThan(300);
      await f.clubs.flush();
      await deleteAccount(f.repos, cara.userId, { now: f.now });
      expect(seasonRow(await f.stored(code), cara.userId)).toEqual({ userId: cara.userId, name: DELETED_PLAYER_NAME, points: 0 });
      expect(seasonRow(await f.stored(code), owner.userId)!.name).toBe('Owner');
    });

    it("moves a merged guest's seats and season rows to the account, so the purge of the guest row takes nothing from a living player", async () => {
      const f = fixture(repos());
      const identity = { provider: 'google' as const, subject: 'g-' + randomHex(8) };
      const account = await createGuest(f.repos, PEPPER, { platform: 'ios' }, { sessions: f.sessions, now: f.now, displayName: 'Mei' });
      await link(f.repos, account.userId, identity, { sessions: f.sessions, now: f.now, currentSessionId: account.sessionId, deviceId: account.deviceId });
      const [owner, guest] = [await f.guest('Owner'), await f.guest('Mei on her tablet')];
      const code = await f.clubWithSeason('Tablet club', owner, [guest]);
      await f.clubs.flush();
      const room = f.room();
      await f.match(room, f.seats({ userId: guest.userId, name: 'Mei on her tablet' }, { userId: owner.userId, name: 'Owner' }));

      const merged = await link(f.repos, guest.userId, identity, { sessions: f.sessions, now: f.now });
      expect(merged).toMatchObject({ userId: account.userId, merged: true });
      f.clubs.moveMemberships(guest.userId, { userId: account.userId, name: 'Mei' });
      await f.clubs.flush();
      expect(seasonRow(await f.stored(code), guest.userId)).toBeUndefined();
      expect(seasonRow(await f.stored(code), account.userId)).toEqual({ userId: account.userId, name: 'Mei', points: 0 });
      expect((await f.repos.matchResults.listForRoom(room))[0].players[0]).toEqual({ seat: 0, name: 'Mei on her tablet', userId: account.userId, isBot: false });

      f.clock.now += 31 * DAY;
      const purged = await purgeDeletedUsers(f.repos, { now: f.now });
      expect(purged.userIds).toContain(guest.userId);
      f.clubs.dropPurged(purged.userIds);
      await f.clubs.flush();
      expect(seasonRow(await f.stored(code), account.userId)!.name).toBe('Mei');
      expect((await f.repos.matchResults.listForRoom(room))[0].players[0]).toMatchObject({ name: 'Mei on her tablet', userId: account.userId });
    });
  });
}

describe('taking a name out of a report note', () => {
  it('replaces the name whatever its case and leaves longer words that contain it alone', () => {
    expect(withoutName('Al folded. AL stalled; also al.', 'Al')).toBe('Deleted player folded. Deleted player stalled; also Deleted player.');
    expect(withoutName('小明一直拖時間，小明還罵人', '小明')).toBe('Deleted player一直拖時間，Deleted player還罵人');
    expect(withoutName('Reported by (Dr. K+) again', '(Dr. K+)')).toBe('Reported by Deleted player again');
  });

  it('leaves a one-character name alone, and never grows a note past the limit', () => {
    expect(withoutName('A said a lot', 'A')).toBe('A said a lot');
    expect(withoutName('Bo '.repeat(333) + 'x', 'Bo')).toHaveLength(1000);
  });
});

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('records that outlive a deleted account (memory)', () => memory);

describe.skipIf(!PG_URL)('records that outlive a deleted account (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_deletion_' + randomHex(6);

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
