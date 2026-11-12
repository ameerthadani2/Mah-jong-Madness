/**
 * Rotating AUTH_PEPPER, on the memory repositories and (with DATABASE_URL_TEST) on Postgres.
 * A guest account's only credential is its secret, stored as a peppered hash, and the server
 * never holds the secret itself: it can store the hash again under a new pepper only when the app
 * presents the secret. So the earlier peppers stay configured (AUTH_PEPPER_PREVIOUS, one or
 * several): a session or a guest secret that verifies only under one of them is accepted and
 * stored again under the current pepper, and an account that was away keeps working for as long
 * as its pepper is still listed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { AuthError, createGuest, hashToken, loginGuest, SessionService } from '../src/auth';
import { pepperFromEnv } from '../src/config';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const A = 'pepper-a-' + '1'.repeat(40);
const B = 'pepper-b-' + '2'.repeat(40);
const C = 'pepper-c-' + '3'.repeat(40);
const NOW = Date.UTC(2026, 10, 12);

/** The server's view of the peppers for an environment, as main.ts builds it. */
function server(repos: Repos, env: { AUTH_PEPPER: string; AUTH_PEPPER_PREVIOUS?: string }) {
  const sessions = new SessionService(repos, { ...pepperFromEnv(env, () => undefined), now: () => NOW });
  const peppers = { current: sessions.pepper, previous: sessions.previousPeppers };
  return {
    sessions,
    guest: () => createGuest(repos, peppers, { platform: 'ios' }, { sessions, now: () => NOW }),
    login: (userId: string, secret: string) => loginGuest(repos, peppers, userId, secret, { sessions, now: () => NOW }),
  };
}

const refused = async (p: Promise<unknown>): Promise<string> => p.then(() => 'accepted', (e: unknown) => (e instanceof AuthError ? e.code : String(e)));

function suite(name: string, open: () => Repos) {
  describe(name, () => {
    it('accepts a session and a guest secret stored under the previous pepper, and stores both again under the current one', async () => {
      const repos = open();
      const g = await server(repos, { AUTH_PEPPER: A }).guest();
      const rotated = server(repos, { AUTH_PEPPER: B, AUTH_PEPPER_PREVIOUS: A });

      await expect(rotated.sessions.verify(g.token)).resolves.toMatchObject({ userId: g.userId });
      expect((await repos.sessions.get(g.sessionId))?.tokenHash).toBe(hashToken(g.token, B));
      // Using the session does not move the guest secret: the server has not seen it.
      expect((await repos.identities.get('guest', g.userId))?.secretHash).toBe(hashToken(g.guestSecret, A));
      await expect(rotated.login(g.userId, g.guestSecret)).resolves.toMatchObject({ userId: g.userId });
      expect((await repos.identities.get('guest', g.userId))?.secretHash).toBe(hashToken(g.guestSecret, B));

      // Both now stand on the current pepper alone.
      const alone = server(repos, { AUTH_PEPPER: B });
      await expect(alone.sessions.verify(g.token)).resolves.toMatchObject({ userId: g.userId });
      await expect(alone.login(g.userId, g.guestSecret)).resolves.toMatchObject({ userId: g.userId });
    });

    it('keeps a guest who stayed away through two rotations, as long as every earlier pepper is still listed', async () => {
      const repos = open();
      const away = await server(repos, { AUTH_PEPPER: A }).guest();
      const between = await server(repos, { AUTH_PEPPER: B, AUTH_PEPPER_PREVIOUS: A }).guest();
      const twice = server(repos, { AUTH_PEPPER: C, AUTH_PEPPER_PREVIOUS: `${B}, ${A}` });

      expect(twice.sessions.previousPeppers).toEqual([B, A]);
      await expect(twice.sessions.verify(away.token)).resolves.toMatchObject({ userId: away.userId });
      await expect(twice.login(away.userId, away.guestSecret)).resolves.toMatchObject({ userId: away.userId });
      await expect(twice.login(between.userId, between.guestSecret)).resolves.toMatchObject({ userId: between.userId });
      expect((await repos.identities.get('guest', away.userId))?.secretHash).toBe(hashToken(away.guestSecret, C));
      expect((await repos.identities.get('guest', between.userId))?.secretHash).toBe(hashToken(between.guestSecret, C));
      // A wrong secret is still refused, whatever is listed.
      expect(await refused(twice.login(away.userId, randomHex(32)))).toBe('invalid_credentials');
    });

    it('locks out a guest who did not sign in before their pepper was taken off the list, and lets them back in when it returns', async () => {
      const repos = open();
      const first = server(repos, { AUTH_PEPPER: A });
      const active = await first.guest();
      const away = await first.guest();
      // The rotation: the active guest signs in with the secret, the other does not open the app.
      await server(repos, { AUTH_PEPPER: B, AUTH_PEPPER_PREVIOUS: A }).login(active.userId, active.guestSecret);

      const removed = server(repos, { AUTH_PEPPER: B });
      await expect(removed.login(active.userId, active.guestSecret)).resolves.toMatchObject({ userId: active.userId });
      expect(await refused(removed.login(away.userId, away.guestSecret))).toBe('invalid_credentials');
      expect(await refused(removed.sessions.verify(away.token))).toBe('invalid_session');
      // Nothing was destroyed: the row still holds the hash under the old pepper.
      expect((await repos.identities.get('guest', away.userId))?.secretHash).toBe(hashToken(away.guestSecret, A));
      const restored = server(repos, { AUTH_PEPPER: B, AUTH_PEPPER_PREVIOUS: A });
      await expect(restored.login(away.userId, away.guestSecret)).resolves.toMatchObject({ userId: away.userId });
      await expect(restored.sessions.verify(away.token)).resolves.toMatchObject({ userId: away.userId });
    });
  });
}

describe('AUTH_PEPPER_PREVIOUS', () => {
  it('reads one earlier pepper or a comma-separated list, newest first, without blanks, repeats or the current pepper', () => {
    const read = (previous?: string) => pepperFromEnv({ AUTH_PEPPER: B, ...(previous === undefined ? {} : { AUTH_PEPPER_PREVIOUS: previous }) }, () => undefined).previousPepper;
    expect(read()).toBeUndefined();
    expect(read('  ')).toBeUndefined();
    expect(read(A)).toBe(A);
    expect(read(` ${C} ,, ${A},${C},${B} `)).toEqual([C, A]);
    expect(new SessionService(createMemoryRepos(), { pepper: B, previousPepper: [C, '', B, A, C] }).previousPeppers).toEqual([C, A]);
    expect(new SessionService(createMemoryRepos(), { pepper: B, previousPepper: A }).previousPepper).toBe(A);
    expect(new SessionService(createMemoryRepos(), { pepper: B }).previousPeppers).toEqual([]);
  });
});

suite('pepper rotation (memory)', () => createMemoryRepos());

describe.skipIf(!PG_URL)('pepper rotation (Postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let repos: Repos;
  const schema = 'mjm_pepper_' + randomHex(6);

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
