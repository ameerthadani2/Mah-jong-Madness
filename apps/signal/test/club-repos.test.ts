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
