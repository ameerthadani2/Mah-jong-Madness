/**
 * The club repository's newer fields (migration 0005), against memory and (with DATABASE_URL_TEST)
 * Postgres: variant tables, the owner's plan lapse and the ban list, through a save and a load, an
 * account merge and an account deletion.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, randomHex } from '@mjm/engine';
import type { Club } from '../src/clubs';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, DELETED_PLAYER_NAME, type Repos } from '../src/repos';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);

function clubOf(code: string, ownerId: string, memberId: string, bannedId: string): Club {
  const member = (userId: string, role: 'owner' | 'member') => ({ userId, name: userId.slice(0, 4), role, joinedAt: T0, points: 0, seasonPoints: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });
  return {
    code,
    name: 'Repo club',
    description: '',
    ownerId,
    createdAt: T0,
    rules: { ...DEFAULT_RULES },
    settings: { membersCanOpenTables: true, joinRequiresApproval: false, botSkill: 'pro' },
    members: [member(ownerId, 'owner'), member(memberId, 'member')],
    pending: [],
    tables: [
      { code: `${code.slice(0, 4)}H1`, label: 'House', rules: { ...DEFAULT_RULES }, createdBy: ownerId, createdAt: T0, status: 'open', players: [], handNumber: 0, scores: [0, 0, 0, 0], variant: false },
      { code: `${code.slice(0, 4)}V1`, label: 'Variant', rules: { ...DEFAULT_RULES, basePoints: 500 }, createdBy: ownerId, createdAt: T0 + 1, status: 'open', players: [], handNumber: 0, scores: [0, 0, 0, 0], variant: true },
    ],
    season: 1,
    seasonStartedAt: T0,
    seasons: [],
    bans: [{ userId: bannedId, name: 'Griefer', bannedAt: T0 + 5_000, by: ownerId }],
    ownerLapsedAt: T0 + 60_000,
  };
}

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    const user = async () => (await repos().users.create({ id: randomUUID(), kind: 'guest', createdAt: T0 })).id;
    const code = () => randomHex(3).toUpperCase().padEnd(6, 'Q');

    it('keeps variant tables, the owner lapse, the bot skill and the ban list through a save and a load', async () => {
      const r = repos();
      const [owner, member, banned] = [await user(), await user(), await user()];
      const c = clubOf(code(), owner, member, banned);
      await r.clubs.save(c);
      const back = (await r.clubs.get(c.code))!;
      expect(back.tables.map((t) => [t.label, t.variant])).toEqual([
        ['House', false],
        ['Variant', true],
      ]);
      expect(back.ownerLapsedAt).toBe(T0 + 60_000);
      expect(back.settings.botSkill).toBe('pro');
      expect(back.bans).toEqual([{ userId: banned, name: 'Griefer', bannedAt: T0 + 5_000, by: owner }]);
      // Unbanning and clearing the lapse are saved too.
      await r.clubs.save({ ...back, bans: [], ownerLapsedAt: null });
      const again = (await r.clubs.get(c.code))!;
      expect(again.bans ?? []).toEqual([]);
      expect(again.ownerLapsedAt ?? null).toBeNull();
    });

    it('moves a ban with a merged account and lets it beat a membership there; anonymises it on deletion', async () => {
      const r = repos();
      const [owner, member, banned] = [await user(), await user(), await user()];
      const c = clubOf(code(), owner, member, banned);
      await r.clubs.save(c);
      // The banned account is merged into the member's account: the ban follows, the membership goes.
      expect(await r.clubs.moveMemberships(banned, { userId: member, name: 'Merged' })).toContain(c.code);
      const merged = (await r.clubs.get(c.code))!;
      expect(merged.bans!.map((b) => b.userId)).toEqual([member]);
      expect(merged.members.map((m) => m.userId)).toEqual([owner]);
      expect(await r.clubs.anonymiseUser(member)).toContain(c.code);
      expect((await r.clubs.get(c.code))!.bans![0].name).toBe(DELETED_PLAYER_NAME);
      // Deleting the club takes its bans with it.
      expect(await r.clubs.delete(c.code)).toBe(true);
      expect(await r.clubs.get(c.code)).toBeNull();
    });

    it("keeps the owner-lapse file through a save and a load, and moves an account's lapse with a merge", async () => {
      const r = repos();
      const [owner, member, other, target] = [await user(), await user(), await user(), await user()];
      const c = clubOf(code(), owner, member, other);
      c.ownerLapses = [
        { userId: owner, lapsedAt: T0 + 60_000, until: null },
        { userId: member, lapsedAt: T0 - 5_000, until: T0 + 1_000 },
      ];
      await r.clubs.save(c);
      expect((await r.clubs.get(c.code))!.ownerLapses).toEqual(c.ownerLapses);
      // The former owner's account is merged into another: only its lapse names it in this club.
      await r.clubs.save({ ...c, members: c.members.filter((m) => m.userId !== member) });
      expect(await r.clubs.moveMemberships(member, { userId: target, name: 'Target' })).toEqual([c.code]);
      expect((await r.clubs.get(c.code))!.ownerLapses).toEqual([
        { userId: owner, lapsedAt: T0 + 60_000, until: null },
        { userId: target, lapsedAt: T0 - 5_000, until: T0 + 1_000 },
      ]);
      // A club with nothing on file reads back without the field.
      await r.clubs.save({ ...c, ownerLapses: [] });
      expect((await r.clubs.get(c.code))!.ownerLapses ?? []).toEqual([]);
    });

    it('keeps standings on file and the list of who started a match through a save and a load; a merge and a purge follow the account', async () => {
      const r = repos();
      const [owner, member, gone, target] = [await user(), await user(), await user(), await user()];
      const c: Club = { ...clubOf(code(), owner, member, gone), bans: [] };
      c.former = [{ userId: gone, leftAt: T0 + 9_000, season: 1, points: -320, seasonPoints: -120, matchesPlayed: 2, matchesWon: 0, handsWon: 1 }];
      c.tables[0].startedWith = [
        { seat: 0, userId: owner },
        { seat: 2, userId: gone },
      ];
      await r.clubs.save(c);
      const back = (await r.clubs.get(c.code))!;
      expect(back.former).toEqual(c.former);
      expect(back.tables.map((t) => t.startedWith)).toEqual([c.tables[0].startedWith, undefined]);
      expect(await r.clubs.clubsForUser(gone)).toEqual([]);
      expect(await r.clubs.isMember(c.code, gone)).toBe(false);

      // The departed account is merged into another that is not in the club: the file follows it.
      expect(await r.clubs.moveMemberships(gone, { userId: target, name: 'Target' })).toEqual([c.code]);
      const merged = (await r.clubs.get(c.code))!;
      expect(merged.former).toEqual([{ ...c.former[0], userId: target }]);
      expect(merged.tables[0].startedWith).toEqual([
        { seat: 0, userId: owner },
        { seat: 2, userId: target },
      ]);
      // Merged into a member instead, the results are added to the member's row.
      expect(await r.clubs.moveMemberships(target, { userId: member, name: 'Member' })).toEqual([c.code]);
      const folded = (await r.clubs.get(c.code))!;
      expect(folded.former ?? []).toEqual([]);
      expect(folded.members.find((m) => m.userId === member)).toMatchObject({ points: -320, seasonPoints: -120, matchesPlayed: 2, handsWon: 1 });

      // A file for an account that is deleted and purged goes with it, and a stale copy still saves.
      const stale: Club = { ...folded, former: [{ ...c.former[0], userId: gone }] };
      await r.clubs.save(stale);
      await r.users.update(gone, { deletedAt: T0 });
      expect(await r.users.purgeDeletedIds(T0 + 1)).toContain(gone);
      expect((await r.clubs.get(c.code))!.former ?? []).toEqual([]);
      await r.clubs.save(stale);
      if (r.kind === 'pg') expect((await r.clubs.get(c.code))!.former ?? []).toEqual([]);
    });

    it("passes a deleted owner's club to the first admin or member who owns fewer than 3 clubs and has not deleted their account", async () => {
      const r = repos();
      const [gone, busyAdmin, deleted, heir, late] = [await user(), await user(), await user(), await user(), await user()];
      // The senior admin already owns three clubs.
      for (let i = 0; i < 3; i++) await r.clubs.save({ ...clubOf(code(), busyAdmin, late, gone), bans: [] });
      const row = (userId: string, role: 'owner' | 'admin' | 'member', joinedAt: number, name = userId.slice(0, 4)) => ({ userId, name, role, joinedAt, points: 0, seasonPoints: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });
      const c: Club = {
        ...clubOf(code(), gone, heir, late),
        bans: [],
        members: [row(gone, 'owner', T0), row(busyAdmin, 'admin', T0 + 1), row(deleted, 'member', T0 + 2, DELETED_PLAYER_NAME), row(heir, 'member', T0 + 3), row(late, 'member', T0 + 4)],
      };
      // A second club where the only other member is at the cap: they take it all the same.
      const onlyBusy: Club = { ...clubOf(code(), gone, busyAdmin, late), bans: [] };
      // And one where only a deleted player is left: nobody can run it, so it is dissolved.
      const onlyDeleted: Club = { ...clubOf(code(), gone, deleted, late), bans: [], members: [row(gone, 'owner', T0), row(deleted, 'member', T0 + 1, DELETED_PLAYER_NAME)] };
      for (const club of [c, onlyBusy, onlyDeleted]) await r.clubs.save(club);

      expect([...(await r.clubs.anonymiseUser(gone))].sort()).toEqual([c.code, onlyBusy.code, onlyDeleted.code].sort());
      const after = (await r.clubs.get(c.code))!;
      expect(after.ownerId).toBe(heir);
      expect(after.members.map((m) => [m.userId, m.role]).sort()).toEqual(
        [
          [gone, 'member'],
          [busyAdmin, 'admin'],
          [deleted, 'member'],
          [heir, 'owner'],
          [late, 'member'],
        ].sort(),
      );
      expect((await r.clubs.get(onlyBusy.code))!.ownerId).toBe(busyAdmin);
      expect(await r.clubs.get(onlyDeleted.code)).toBeNull();
    });
  });
}

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('club repository (memory)', () => memory);

describe.skipIf(!PG_URL)('club repository (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_clubs_' + randomHex(6);

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
