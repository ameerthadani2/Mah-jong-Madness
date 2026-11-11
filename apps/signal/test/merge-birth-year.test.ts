/**
 * The birth year across an account merge, on the memory repositories and (with DATABASE_URL_TEST)
 * on Postgres. The server's birth year is write-once and decides who may use quick match; a guest
 * that declared an under-17 year used to shed it by linking to an account that had none, because
 * the merge dropped the guest's year. The guest's year now goes to the surviving account when
 * that account has none, and the account's own year always stays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createGuest, link, SessionService } from '../src/auth';
import { createPool, type Pool } from '../src/db';
import { quickMatchCheck } from '../src/matchmaking';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { PEPPER } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const NOW = Date.UTC(2026, 10, 11);

function suite(name: string, open: () => Repos) {
  describe(name, () => {
    /** An account V with a linked sign-in, and a guest U about to sign in with the same identity (which merges U into V). */
    async function pair(years: { account: number | null; guest: number | null }) {
      const repos = open();
      const sessions = new SessionService(repos, { pepper: PEPPER, now: () => NOW });
      const identity = { provider: 'google' as const, subject: 'g-' + randomHex(8) };
      const guest = () => createGuest(repos, PEPPER, { platform: 'ios' }, { sessions, now: () => NOW });
      const v = await guest();
      await link(repos, v.userId, identity, { sessions, now: () => NOW, currentSessionId: v.sessionId, deviceId: v.deviceId });
      if (years.account !== null) await repos.users.update(v.userId, { birthYear: years.account });
      const u = await guest();
      if (years.guest !== null) await repos.users.update(u.userId, { birthYear: years.guest });
      const merge = () => link(repos, u.userId, identity, { sessions, now: () => NOW, currentSessionId: u.sessionId, deviceId: u.deviceId });
      return { repos, v, u, merge };
    }

    it("carries the guest's birth year to an account that has none, so an under-17 declaration survives linking", async () => {
      const { repos, v, u, merge } = await pair({ account: null, guest: 2012 });
      expect(await quickMatchCheck(repos, u.userId, NOW)).toBe('age_under');
      expect(await quickMatchCheck(repos, v.userId, NOW)).toBe('age_missing');
      expect(await merge()).toMatchObject({ userId: v.userId, merged: true, mergedFrom: u.userId });
      expect((await repos.users.get(v.userId))!.birthYear).toBe(2012);
      expect(await quickMatchCheck(repos, v.userId, NOW)).toBe('age_under');
      // The merged-away guest row is scrubbed as before.
      expect(await repos.users.get(u.userId)).toMatchObject({ mergedInto: v.userId, birthYear: null });
    });

    it("carries an adult guest's year too: the account need not be asked again", async () => {
      const { repos, v, merge } = await pair({ account: null, guest: 1990 });
      await merge();
      expect((await repos.users.get(v.userId))!.birthYear).toBe(1990);
      expect(await quickMatchCheck(repos, v.userId, NOW)).toBeNull();
    });

    it("keeps the surviving account's own year when both have one", async () => {
      const older = await pair({ account: 1990, guest: 2012 });
      await older.merge();
      expect((await older.repos.users.get(older.v.userId))!.birthYear).toBe(1990);
      const younger = await pair({ account: 2012, guest: 1990 });
      await younger.merge();
      expect((await younger.repos.users.get(younger.v.userId))!.birthYear).toBe(2012);
      expect(await quickMatchCheck(younger.repos, younger.v.userId, NOW)).toBe('age_under');
    });

    it('leaves the account without a year when neither has one', async () => {
      const { repos, v, merge } = await pair({ account: null, guest: null });
      await merge();
      expect((await repos.users.get(v.userId))!.birthYear).toBeNull();
      expect(await quickMatchCheck(repos, v.userId, NOW)).toBe('age_missing');
    });
  });
}

suite('the birth year across a merge (memory)', () => createMemoryRepos());

describe.skipIf(!PG_URL)('the birth year across a merge (Postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let repos: Repos;
  const schema = 'mjm_mergeby_' + randomHex(6);

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
});
