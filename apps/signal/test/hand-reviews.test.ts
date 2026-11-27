/**
 * The free hand-review meter on the server (src/reviews.ts, migration 0022): the repository on memory
 * and (with DATABASE_URL_TEST) Postgres, two opens at once, an account merge and the purge; and the
 * route a phone asks before it opens a review: one new hand a UTC day for a free account, a hand
 * reviewed before is free again, a phone whose storage was cleared (or a second phone) still finds
 * the day's review used, and The Four Winds Club reviews every hand.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { FREE_REVIEWS_PER_DAY, HAND_REVIEW_KEEP_MS, isHandKey } from '../src/reviews';
import { apiFixture } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
const TODAY = Date.UTC(2026, 10, 27);

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    const user = async () => (await repos().users.create({ id: randomUUID(), kind: 'guest', displayName: 'P', createdAt: T0 })).id;

    it('counts one new hand a day, lets a hand reviewed before be opened again, and starts again the next UTC day', async () => {
      const r = repos().handReviews;
      const u = await user();
      expect(await r.open(u, 'm1:0', T0, TODAY, 1)).toEqual({ outcome: 'counted', used: 1 });
      expect(await r.open(u, 'm1:0', T0 + 1000, TODAY, 1)).toEqual({ outcome: 'again', used: 1 });
      expect(await r.open(u, 'm1:1', T0 + 2000, TODAY, 1)).toEqual({ outcome: 'limited', used: 1 });
      expect(await r.countSince(u, TODAY)).toBe(1);
      // The next UTC day: a new hand counts again; the one from yesterday is still free.
      expect(await r.open(u, 'm1:1', T0 + DAY, TODAY + DAY, 1)).toEqual({ outcome: 'counted', used: 1 });
      expect(await r.open(u, 'm1:0', T0 + DAY + 1000, TODAY + DAY, 1)).toEqual({ outcome: 'again', used: 1 });
      // No limit (a plan that reviews every hand): every hand counts, none is refused.
      expect(await r.open(u, 'm2:0', T0 + DAY + 2000, TODAY + DAY, null)).toEqual({ outcome: 'counted', used: 2 });
    });

    it('takes opens at once one at a time: only one of eight new hands gets the last free review', async () => {
      const r = repos().handReviews;
      const u = await user();
      const all = await Promise.all(Array.from({ length: 8 }, (_, i) => r.open(u, `race:${i}`, T0, TODAY, 1)));
      expect(all.filter((x) => x.outcome === 'counted')).toHaveLength(1);
      expect(all.filter((x) => x.outcome === 'limited')).toHaveLength(7);
      expect(await r.countSince(u, TODAY)).toBe(1);
    });

    it('makes a second open wait while a first is not yet committed (the account is locked), so it sees the first one counted', async () => {
      const all = repos();
      const u = await user();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const first = all.transaction(async (tx) => {
        const opened = await tx.handReviews.open(u, 'lock:0', T0, TODAY, 1);
        await gate;
        return opened;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = all.handReviews.open(u, 'lock:1', T0, TODAY, 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      expect((await first).outcome).toBe('counted');
      expect(await second).toEqual({ outcome: 'limited', used: 1 });
    });

    it("moves a guest's reviewed hands to the account it merges into, and prunes old rows", async () => {
      const r = repos().handReviews;
      const [guest, account] = [await user(), await user()];
      await r.open(guest, 'g:0', T0, TODAY, 1);
      await r.open(account, 'a:0', T0 - 40 * DAY, TODAY - 40 * DAY, 1);
      expect(await r.moveToUser(guest, account)).toBe(1);
      expect(await r.countSince(guest, 0)).toBe(0);
      expect(await r.open(account, 'g:0', T0 + 1000, TODAY, 1)).toEqual({ outcome: 'again', used: 1 });
      expect(await r.open(account, 'a:1', T0 + 2000, TODAY, 1)).toEqual({ outcome: 'limited', used: 1 });
      expect(await r.prune(T0 - HAND_REVIEW_KEEP_MS)).toBe(1);
      expect(await r.countSince(account, 0)).toBe(1);
    });

    it('goes with the account at the purge', async () => {
      const all = repos();
      const u = await user();
      await all.handReviews.open(u, 'p:0', T0, TODAY, 1);
      await all.users.update(u, { deletedAt: T0 });
      expect(await all.users.purgeDeletedIds(T0 + 1)).toContain(u);
      expect(await all.handReviews.countSince(u, 0)).toBe(0);
    });
  });
}

const memory = createMemoryRepos();
contract('hand reviews (memory)', () => memory);

describe.skipIf(!PG_URL)('hand reviews (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_reviews_' + randomHex(6);
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

describe('POST /api/reviews', () => {
  it('names a hand as the app does', () => {
    expect(['m1a2b3c4:0', 'abc:12', 'x'.repeat(64)].every(isHandKey)).toBe(true);
    expect(['', 'x'.repeat(65), 'a b', 'a/b', 42, null].some(isHandKey)).toBe(false);
  });

  it('gives a free account one new hand a UTC day, counted by the account and not the phone; a hand reviewed before is free', async () => {
    let now = T0;
    const f = apiFixture({ now: () => now });
    const g = await f.guest('Mei');
    const open = (hand: unknown, auth = g.auth) => f.call('POST', '/api/reviews', { hand }, auth);
    expect((await open('bad hand')).status).toBe(400);
    expect((await f.call('POST', '/api/reviews', { hand: 'm:0' })).status).toBe(401);
    const first = await open('m:0');
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ counted: true, unlimited: false, used: 1, limit: FREE_REVIEWS_PER_DAY, resetsAt: new Date(TODAY + DAY).toISOString() });
    expect((await open('m:0')).json).toMatchObject({ counted: false, used: 1 });
    // A second hand the same day is refused, whatever the phone remembers: its storage was cleared, or it is another phone.
    const again = await f.call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret, device: { id: randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' } });
    const other = { authorization: `Bearer ${(again.json.session as { token: string }).token}` };
    const refused = await open('m:1', other);
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: 'review_daily_limit', message: expect.any(String), used: 1, limit: 1, resetsAt: new Date(TODAY + DAY).toISOString() });
    // The next UTC day (08:00 in Taiwan) there is a new one.
    now = TODAY + DAY + 1000;
    expect((await open('m:1')).json).toMatchObject({ counted: true, used: 1, resetsAt: new Date(TODAY + 2 * DAY).toISOString() });
  });

  it('reviews every hand for The Four Winds Club, without counting them', async () => {
    const f = apiFixture({ now: () => T0 });
    const g = await f.guest('Lin');
    await f.repos.wallet.setEntitlement({ userId: g.userId, entitlement: 'fourwinds.month', expiresAt: T0 + 30 * DAY, source: 'store', updatedAt: T0 });
    for (const hand of ['w:0', 'w:1', 'w:2']) expect((await f.call('POST', '/api/reviews', { hand }, g.auth)).json).toEqual({ counted: false, unlimited: true, used: 0, limit: null, resetsAt: null });
    expect(await f.repos.handReviews.countSince(g.userId, 0)).toBe(0);
  });
});
