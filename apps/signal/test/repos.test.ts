/**
 * One contract for both repository implementations. The memory repositories always run; the
 * Postgres ones run only when DATABASE_URL_TEST points at a database this test may write to
 * (each run works in a fresh, randomly named schema and drops it afterwards). CI will provide a
 * Postgres service container for this in a later step; locally, for example:
 *
 *   DATABASE_URL_TEST=postgres://user:pass@localhost:5432/mjm_test npm test -w @mjm/signal
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, randomHex } from '@mjm/engine';
import type { Club, ClubMember } from '../src/clubs';
import { createPool, ping, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, createRepos, DELETED_PLAYER_NAME, type Repos, type UserKind, type UserRecord } from '../src/repos';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);

const code = (prefix: string) => prefix + randomHex(4).toUpperCase();

function member(u: UserRecord, role: ClubMember['role'], joinedAt: number, points = 0): ClubMember {
  return { userId: u.id, name: u.displayName, role, joinedAt, points, seasonPoints: points, matchesPlayed: points ? 1 : 0, matchesWon: points > 0 ? 1 : 0, handsWon: 0 };
}

function clubFixture(owner: UserRecord, extra: Partial<Club> = {}): Club {
  return {
    code: code('C'),
    name: 'Tea House',
    description: 'Friday nights',
    ownerId: owner.id,
    createdAt: T0,
    rules: { ...DEFAULT_RULES },
    settings: { membersCanOpenTables: true, joinRequiresApproval: false },
    members: [member(owner, 'owner', T0)],
    pending: [],
    tables: [],
    season: 1,
    seasonStartedAt: T0,
    seasons: [],
    ...extra,
  };
}

/** Clubs compared without regard to row order, which the database does not promise. */
function normalise(c: Club | null) {
  if (!c) return c;
  return {
    ...c,
    members: [...c.members].sort((a, b) => a.userId.localeCompare(b.userId)),
    pending: [...c.pending].sort((a, b) => a.userId.localeCompare(b.userId)),
    tables: [...c.tables].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

function contract(name: string, setup: () => Promise<Repos>, teardown: () => Promise<void> = async () => {}) {
  describe(name, () => {
    let repos: Repos;
    beforeAll(async () => {
      repos = await setup();
    });
    afterAll(teardown);

    const user = (kind: UserKind = 'guest', displayName = 'Player') => repos.users.create({ id: randomUUID(), kind, displayName, createdAt: T0 });

    it('users: create, get, partial update (null on purpose), unknown and malformed ids', async () => {
      const u = await repos.users.create({ id: randomUUID(), kind: 'guest', displayName: 'Mei', locale: 'zh-TW', createdAt: T0 });
      expect(u).toMatchObject({ kind: 'guest', displayName: 'Mei', locale: 'zh-TW', avatar: null, email: null, createdAt: T0, lastSeenAt: T0, deletedAt: null });
      const updated = await repos.users.update(u.id, { kind: 'account', email: 'mei@example.com', avatar: 'panda', lastSeenAt: T0 + 5 });
      expect(updated).toMatchObject({ kind: 'account', email: 'mei@example.com', avatar: 'panda', displayName: 'Mei', locale: 'zh-TW', lastSeenAt: T0 + 5 });
      await repos.users.update(u.id, { avatar: null });
      expect((await repos.users.get(u.id))?.avatar).toBeNull();
      expect((await repos.users.get(u.id))?.email).toBe('mei@example.com');
      expect(await repos.users.get(randomUUID())).toBeNull();
      expect(await repos.users.get('not-a-uuid')).toBeNull();
      expect(await repos.users.update(randomUUID(), { displayName: 'x' })).toBeNull();
    });

    it('identities: insert once, list, rehash, delete', async () => {
      const u = await user();
      const guest = { provider: 'guest' as const, subject: u.id, userId: u.id, secretHash: 'a'.repeat(64), email: null, createdAt: T0 };
      expect(await repos.identities.create(guest)).toBe(true);
      expect(await repos.identities.create({ ...guest, secretHash: 'b'.repeat(64) })).toBe(false);
      const apple = { provider: 'apple' as const, subject: 'apple-' + u.id, userId: u.id, secretHash: null, email: 'x@privaterelay.appleid.com', createdAt: T0 + 1 };
      expect(await repos.identities.create(apple)).toBe(true);
      expect((await repos.identities.listForUser(u.id)).map((i) => i.provider).sort()).toEqual(['apple', 'guest']);
      await repos.identities.updateSecretHash('guest', u.id, 'c'.repeat(64));
      expect((await repos.identities.get('guest', u.id))?.secretHash).toBe('c'.repeat(64));
      expect(await repos.identities.get('apple', apple.subject)).toEqual(apple);
      expect(await repos.identities.delete('apple', apple.subject)).toBe(true);
      expect(await repos.identities.delete('apple', apple.subject)).toBe(false);
      expect(await repos.identities.deleteForUser(u.id)).toBe(1);
      expect(await repos.identities.listForUser(u.id)).toEqual([]);
    });

    it('devices and sessions: lookups, one-shot revoke, revoke all but one, delete', async () => {
      const u = await user();
      const device = { id: randomUUID(), userId: u.id, platform: 'ios', appBuild: '42', pushToken: null, locale: 'en', createdAt: T0, lastSeenAt: T0 };
      await repos.devices.create(device);
      await repos.devices.update(device.id, { pushToken: 'ExponentPushToken[x]', lastSeenAt: T0 + 9 });
      expect(await repos.devices.get(device.id)).toEqual({ ...device, pushToken: 'ExponentPushToken[x]', lastSeenAt: T0 + 9 });

      const mk = (n: number) => ({ id: randomUUID(), userId: u.id, deviceId: n === 1 ? device.id : null, tokenHash: randomHex(32), createdAt: T0, expiresAt: T0 + 1000, rotatedFrom: null, revokedAt: null });
      const [s1, s2, s3] = [mk(1), mk(2), mk(3)];
      for (const s of [s1, s2, s3]) await repos.sessions.create(s);
      expect(await repos.sessions.findByHash(s1.tokenHash)).toEqual(s1);
      expect(await repos.sessions.findByHash('f'.repeat(64))).toBeNull();
      await repos.sessions.update(s1.id, { expiresAt: T0 + 5000 });
      expect((await repos.sessions.get(s1.id))?.expiresAt).toBe(T0 + 5000);
      expect(await repos.sessions.revokeIfActive(s2.id, T0 + 600)).toBe(true);
      expect(await repos.sessions.revokeIfActive(s2.id, T0 + 700)).toBe(false);
      expect((await repos.sessions.get(s2.id))?.revokedAt).toBe(T0 + 600);
      // s2's grace (revoked at +600, in the future) is cut short too; s1 is spared.
      expect(await repos.sessions.revokeAllForUser(u.id, T0 + 100, s1.id)).toBe(2);
      expect((await repos.sessions.get(s1.id))?.revokedAt).toBeNull();
      expect((await repos.sessions.get(s2.id))?.revokedAt).toBe(T0 + 100);
      expect((await repos.sessions.get(s3.id))?.revokedAt).toBe(T0 + 100);
      expect(await repos.sessions.deleteForUser(u.id)).toBe(3);
      expect(await repos.sessions.get(s1.id)).toBeNull();

      const v = await user();
      expect(await repos.devices.moveToUser(u.id, v.id)).toBe(1);
      expect((await repos.devices.listForUser(v.id)).map((d) => d.id)).toEqual([device.id]);
      expect(await repos.devices.deleteForUser(v.id)).toBe(1);
      expect(await repos.devices.get(device.id)).toBeNull();
    });

    it('wallet: balances never go negative, purchases are idempotent, merge sums and unions', async () => {
      const u = await user();
      const v = await user();
      expect(await repos.wallet.get(u.id)).toMatchObject({ diamonds: 0, bonusDiamonds: 0 });
      const credit = await repos.wallet.apply({ userId: u.id, delta: 100, bonus: 20, reason: 'purchase', ref: 'tx-1', createdAt: T0 });
      expect(credit?.wallet).toMatchObject({ diamonds: 100, bonusDiamonds: 20 });
      expect(credit?.entry).toMatchObject({ delta: 100, bonus: 20, reason: 'purchase', ref: 'tx-1' });
      expect(await repos.wallet.apply({ userId: u.id, delta: -150, reason: 'spend', createdAt: T0 + 1 })).toBeNull();
      expect((await repos.wallet.get(u.id)).diamonds).toBe(100);
      await repos.wallet.apply({ userId: u.id, delta: -30, reason: 'spend', ref: 'table-look', createdAt: T0 + 2 });
      expect((await repos.wallet.listLedger(u.id)).map((l) => l.delta)).toEqual([100, -30]);

      const txId = 'gpa.' + randomHex(6);
      const p = { userId: u.id, store: 'play', transactionId: txId, productId: 'diamonds_100', price: 30, currency: 'TWD', eventId: 'evt-' + txId, raw: { a: [1, 2] }, createdAt: T0 };
      const first = await repos.wallet.recordPurchase(p);
      expect(first.inserted).toBe(true);
      expect(first.purchase).toMatchObject({ transactionId: txId, price: 30, currency: 'TWD', raw: { a: [1, 2] } });
      expect((await repos.wallet.recordPurchase(p)).inserted).toBe(false);
      const sameEvent = await repos.wallet.recordPurchase({ ...p, transactionId: txId + '-retry' });
      expect(sameEvent).toMatchObject({ inserted: false, purchase: { id: first.purchase.id } });

      await repos.wallet.apply({ userId: v.id, delta: 5, reason: 'gift', createdAt: T0 });
      await repos.wallet.setEntitlement({ userId: u.id, entitlement: 'coach_gold', expiresAt: T0 + 10_000, source: 'u', updatedAt: T0 });
      await repos.wallet.setEntitlement({ userId: v.id, entitlement: 'coach_gold', expiresAt: T0 + 5_000, source: 'v', updatedAt: T0 });
      await repos.wallet.setEntitlement({ userId: u.id, entitlement: 'platinum', expiresAt: T0 + 1_000, source: 'u', updatedAt: T0 });
      await repos.wallet.setEntitlement({ userId: v.id, entitlement: 'platinum', expiresAt: null, source: 'v', updatedAt: T0 });
      await repos.wallet.setEntitlement({ userId: u.id, entitlement: 'table_jade', expiresAt: null, source: 'u', updatedAt: T0 });

      await repos.wallet.mergeInto(u.id, v.id, T0 + 99);
      expect(await repos.wallet.get(v.id)).toMatchObject({ diamonds: 75, bonusDiamonds: 20 });
      expect(await repos.wallet.get(u.id)).toMatchObject({ diamonds: 0, bonusDiamonds: 0 });
      expect((await repos.wallet.listLedger(v.id)).map((l) => l.delta).sort((a, b) => a - b)).toEqual([-30, 5, 100]);
      expect(await repos.wallet.listLedger(u.id)).toEqual([]);
      expect((await repos.wallet.listPurchases(v.id)).map((x) => x.transactionId)).toEqual([txId]);
      const ents = Object.fromEntries((await repos.wallet.getEntitlements(v.id)).map((e) => [e.entitlement, e]));
      expect(ents.coach_gold).toMatchObject({ expiresAt: T0 + 10_000, source: 'u' });
      expect(ents.platinum).toMatchObject({ expiresAt: null, source: 'v' });
      expect(ents.table_jade).toMatchObject({ expiresAt: null, source: 'u' });
      expect(await repos.wallet.getEntitlements(u.id)).toEqual([]);
    });

    it('clubs: round trip, rows removed on save, membership queries, delete', async () => {
      const owner = await user('account', 'Ah-Hua');
      const m = await user('guest', 'Bao');
      const p = await user('guest', 'Chen');
      const club = clubFixture(owner, {
        members: [member(owner, 'owner', T0), { ...member(m, 'admin', T0 + 10, 300), avatar: 'tiger' }],
        pending: [{ userId: p.id, name: 'Chen', avatar: 'cat' }],
        tables: [
          {
            code: code('R'),
            label: 'Table 1',
            rules: { ...DEFAULT_RULES, taiPoints: 50 },
            createdBy: owner.id,
            createdAt: T0 + 20,
            status: 'playing',
            players: [{ seat: 0, name: 'Ah-Hua', userId: owner.id, isBot: false, connected: true }, { seat: 1, name: 'Bot', isBot: true, connected: true }],
            handNumber: 3,
            scores: [100, -100, 0, 0],
          },
        ],
      });
      await repos.clubs.save(club);
      expect(normalise(await repos.clubs.get(club.code))).toEqual(normalise(club));
      expect(await repos.clubs.isMember(club.code, m.id)).toBe(true);
      expect(await repos.clubs.isMember(club.code, p.id)).toBe(false);
      expect(await repos.clubs.isMember(club.code, 'nobody')).toBe(false);
      expect(await repos.clubs.clubsForUser(p.id)).toEqual([{ clubCode: club.code, role: 'member', status: 'pending' }]);
      expect(await repos.clubs.clubsForUser(m.id)).toEqual([{ clubCode: club.code, role: 'admin', status: 'member' }]);

      // Approve Chen, remove Bao, finish the table.
      const next: Club = {
        ...club,
        name: 'Tea House 2',
        members: [club.members[0], member(p, 'member', T0 + 30)],
        pending: [],
        tables: [{ ...club.tables[0], status: 'finished', scores: [300, -300, 0, 0] }],
      };
      next.members[1].avatar = 'cat';
      await repos.clubs.save(next);
      expect(normalise(await repos.clubs.get(club.code))).toEqual(normalise(next));
      expect(await repos.clubs.isMember(club.code, m.id)).toBe(false);
      expect((await repos.clubs.loadAll()).some((c) => c.code === club.code)).toBe(true);
      expect(await repos.clubs.delete(club.code)).toBe(true);
      expect(await repos.clubs.get(club.code)).toBeNull();
      expect(await repos.clubs.delete(club.code)).toBe(false);
    });

    it('clubs: memberships move on merge (stronger row stays, ownership transfers) and anonymise on deletion', async () => {
      const u = await user('guest', 'Guest U');
      const v = await user('account', 'Vera');
      const x = await user('account', 'Xu');
      const onlyU = clubFixture(x, { members: [member(x, 'owner', T0), member(u, 'member', T0 + 1, 400)] });
      const both = clubFixture(x, { members: [member(x, 'owner', T0), member(u, 'member', T0 + 1, 100), member(v, 'admin', T0 + 2, 900)] });
      const ownedByU = clubFixture(u, { tables: [{ code: code('R'), label: '', rules: DEFAULT_RULES, createdBy: u.id, createdAt: T0, status: 'open', players: [], handNumber: 0, scores: [] }] });
      const vPending = clubFixture(x, { members: [member(x, 'owner', T0), member(u, 'member', T0 + 1, 50)], pending: [{ userId: v.id, name: 'Vera' }] });
      const uPending = clubFixture(x, { members: [member(x, 'owner', T0), member(v, 'member', T0 + 1)], pending: [{ userId: u.id, name: 'Guest U' }] });
      const untouched = clubFixture(x);
      for (const c of [onlyU, both, ownedByU, vPending, uPending, untouched]) await repos.clubs.save(c);

      const changed = await repos.clubs.moveMemberships(u.id, { userId: v.id, name: 'Vera', avatar: 'crane' });
      expect([...changed].sort()).toEqual([onlyU.code, both.code, ownedByU.code, vPending.code, uPending.code].sort());

      const a = (await repos.clubs.get(onlyU.code))!;
      expect(a.members.find((mm) => mm.userId === v.id)).toMatchObject({ name: 'Vera', avatar: 'crane', points: 400, role: 'member' });
      expect(a.members.some((mm) => mm.userId === u.id)).toBe(false);
      const b = (await repos.clubs.get(both.code))!;
      expect(b.members.filter((mm) => mm.userId === v.id || mm.userId === u.id)).toEqual([expect.objectContaining({ userId: v.id, points: 900, role: 'admin' })]);
      const c = (await repos.clubs.get(ownedByU.code))!;
      expect(c.ownerId).toBe(v.id);
      expect(c.members).toEqual([expect.objectContaining({ userId: v.id, role: 'owner' })]);
      expect(c.tables[0].createdBy).toBe(v.id);
      const d = (await repos.clubs.get(vPending.code))!;
      expect(d.pending).toEqual([]);
      expect(d.members.find((mm) => mm.userId === v.id)).toMatchObject({ points: 50 });
      const e = (await repos.clubs.get(uPending.code))!;
      expect(e.pending).toEqual([]);
      expect(e.members.map((mm) => mm.userId).sort()).toEqual([x.id, v.id].sort());
      expect(normalise(await repos.clubs.get(untouched.code))).toEqual(normalise(untouched));
      expect(await repos.clubs.clubsForUser(u.id)).toEqual([]);

      const leaver = await user('guest', 'Leaver');
      const z = clubFixture(x, { members: [member(x, 'owner', T0), { ...member(leaver, 'member', T0 + 1, 10), avatar: 'fox' }] });
      const zPending = clubFixture(x, { pending: [{ userId: leaver.id, name: 'Leaver' }] });
      await repos.clubs.save(z);
      await repos.clubs.save(zPending);
      expect([...(await repos.clubs.anonymiseUser(leaver.id))].sort()).toEqual([z.code, zPending.code].sort());
      const row = (await repos.clubs.get(z.code))!.members.find((mm) => mm.userId === leaver.id)!;
      expect(row.name).toBe(DELETED_PLAYER_NAME);
      expect(row.avatar).toBeUndefined();
      expect(row.points).toBe(10);
      expect((await repos.clubs.get(zPending.code))!.pending).toEqual([]);
    });

    it('clubs: a deleted owner passes the club to its senior admin, else its earliest member; an empty club is dissolved', async () => {
      const gone = await user('account', 'Gone');
      const early = await user('guest', 'Early');
      const admin = await user('guest', 'Admin');
      const withAdmin = clubFixture(gone, { members: [member(gone, 'owner', T0), member(early, 'member', T0 + 1), member(admin, 'admin', T0 + 2)] });
      const noAdmin = clubFixture(gone, { members: [member(gone, 'owner', T0), member(admin, 'member', T0 + 5), member(early, 'member', T0 + 1)] });
      const alone = clubFixture(gone, { pending: [{ userId: early.id, name: 'Early' }] });
      for (const c of [withAdmin, noAdmin, alone]) await repos.clubs.save(c);
      expect([...(await repos.clubs.anonymiseUser(gone.id))].sort()).toEqual([withAdmin.code, noAdmin.code, alone.code].sort());
      const a = (await repos.clubs.get(withAdmin.code))!;
      expect(a.ownerId).toBe(admin.id);
      expect(a.members.find((mm) => mm.userId === admin.id)!.role).toBe('owner');
      expect(a.members.find((mm) => mm.userId === gone.id)).toMatchObject({ name: DELETED_PLAYER_NAME, role: 'member' });
      const b = (await repos.clubs.get(noAdmin.code))!;
      expect(b.ownerId).toBe(early.id);
      expect(b.members.find((mm) => mm.userId === early.id)!.role).toBe('owner');
      expect(await repos.clubs.get(alone.code)).toBeNull();
      expect(await repos.clubs.clubsForUser(early.id)).toEqual(expect.arrayContaining([expect.objectContaining({ clubCode: noAdmin.code, role: 'owner' })]));
    });

    it('reports: move to the account a guest merged into (a report between the two is dropped)', async () => {
      const guest = await user();
      const account = await user('account');
      const other = await user();
      await repos.reports.create({ reporterId: other.id, reportedUserId: guest.id, roomCode: null, reason: 'cheating', details: null, createdAt: T0 });
      await repos.reports.create({ reporterId: guest.id, reportedUserId: other.id, roomCode: null, reason: 'other', details: null, createdAt: T0 + 1 });
      await repos.reports.create({ reporterId: guest.id, reportedUserId: account.id, roomCode: null, reason: 'stalling', details: null, createdAt: T0 + 2 });
      expect(await repos.reports.moveToUser(guest.id, account.id)).toBe(3);
      expect((await repos.reports.listAbout(account.id)).map((r) => r.reporterId)).toEqual([other.id]);
      expect(await repos.reports.listAbout(guest.id)).toEqual([]);
      expect(await repos.reports.countByReporterSince(account.id, T0)).toBe(1);
      expect(await repos.reports.countByReporterSince(guest.id, T0)).toBe(0);
    });

    it('users: purge removes accounts deleted long enough ago, with their rows, but keeps club owners and financial records; sessions: prune ended', async () => {
      const old = await user('account', 'Old');
      const recent = await user('guest', 'Recent');
      const owner = await user('account', 'Owner');
      const live = await user();
      await repos.users.update(old.id, { deletedAt: T0 - 31 * 86_400_000 });
      await repos.users.update(recent.id, { deletedAt: T0 - 86_400_000, mergedInto: live.id });
      await repos.users.update(owner.id, { deletedAt: T0 - 40 * 86_400_000 });
      await repos.clubs.save(clubFixture(owner));
      await repos.identities.create({ provider: 'guest', subject: old.id, userId: old.id, secretHash: 'a'.repeat(64), email: null, createdAt: T0 });
      await repos.devices.create({ id: randomUUID(), userId: old.id, platform: 'ios', appBuild: null, pushToken: null, locale: null, createdAt: T0, lastSeenAt: T0 });
      await repos.wallet.apply({ userId: old.id, delta: 10, reason: 'purchase', ref: 'tx-old', createdAt: T0 });
      await repos.wallet.recordPurchase({ userId: old.id, store: 'app_store', transactionId: 'tx-old-' + old.id, productId: 'diamonds.60', price: 1, currency: 'USD', eventId: null, raw: {}, createdAt: T0 });
      await repos.puzzleResults.record({ userId: old.id, kind: 'discard', puzzleKey: 'p1', correct: true, seconds: 3, ratingAfter: null, createdAt: T0 });
      await repos.reports.create({ reporterId: live.id, reportedUserId: old.id, roomCode: null, reason: 'other', details: null, createdAt: T0 });
      const mk = (userId: string, expiresAt: number, revokedAt: number | null) => ({ id: randomUUID(), userId, deviceId: null, tokenHash: randomHex(32), createdAt: T0, expiresAt, rotatedFrom: null, revokedAt });
      const [expired, revoked, graced, fine] = [mk(live.id, T0 - 1, null), mk(live.id, T0 + 9000, T0 - 5), mk(live.id, T0 + 9000, T0 + 60_000), mk(live.id, T0 + 9000, null)];
      for (const s of [expired, revoked, graced, fine]) await repos.sessions.create(s);

      expect(await repos.users.purgeDeleted(T0 - 30 * 86_400_000)).toBe(1);
      expect(await repos.users.get(old.id)).toBeNull();
      expect(await repos.identities.listForUser(old.id)).toEqual([]);
      expect(await repos.devices.listForUser(old.id)).toEqual([]);
      expect(await repos.puzzleResults.listForUser(old.id)).toEqual([]);
      expect((await repos.wallet.listLedger(old.id)).length).toBe(1);
      expect((await repos.wallet.listPurchases(old.id)).length).toBe(1);
      expect((await repos.reports.listAbout(old.id)).length).toBe(1);
      expect(await repos.users.get(recent.id)).not.toBeNull();
      expect(await repos.users.get(owner.id)).not.toBeNull();
      expect(await repos.users.purgeDeleted(T0)).toBe(1);
      expect(await repos.users.get(recent.id)).toBeNull();

      expect(await repos.sessions.pruneEnded(T0)).toBe(2);
      expect(await repos.sessions.get(expired.id)).toBeNull();
      expect(await repos.sessions.get(revoked.id)).toBeNull();
      expect(await repos.sessions.get(graced.id)).not.toBeNull();
      expect(await repos.sessions.get(fine.id)).not.toBeNull();
    });

    it('devices: a push token lives on one device; push targets list the users\' tokens', async () => {
      const u = await user();
      const v = await user();
      const dev = (userId: string, n: number, pushToken: string | null) => ({ id: randomUUID(), userId, platform: n % 2 ? 'ios' : 'android', appBuild: null, pushToken, locale: n === 2 ? 'zh-TW' : null, createdAt: T0 + n, lastSeenAt: T0 + n });
      const token = 'ExponentPushToken[' + randomHex(8) + ']';
      const a = dev(u.id, 1, token);
      const b = dev(v.id, 2, token);
      const c = dev(v.id, 3, 'ExponentPushToken[other' + randomHex(4) + ']');
      for (const d of [a, b, c]) await repos.devices.create(d);
      expect(await repos.devices.clearPushToken(token, b.id)).toBe(1);
      expect((await repos.devices.get(a.id))?.pushToken).toBeNull();
      expect((await repos.devices.get(b.id))?.pushToken).toBe(token);
      expect(await repos.devices.pushTargets([u.id, v.id, 'not-a-uuid'])).toEqual([
        { userId: v.id, deviceId: b.id, token, platform: 'android', locale: 'zh-TW' },
        { userId: v.id, deviceId: c.id, token: c.pushToken, platform: 'ios', locale: null },
      ]);
      expect(await repos.devices.clearPushToken(token)).toBe(1);
      expect(await repos.devices.pushTargets([u.id])).toEqual([]);
      expect(await repos.devices.pushTargets([])).toEqual([]);
    });

    it('wallet: an entitlement can be removed', async () => {
      const u = await user();
      await repos.wallet.setEntitlement({ userId: u.id, entitlement: 'coach.gold', expiresAt: T0 + 5, source: 'store', updatedAt: T0 });
      expect(await repos.wallet.deleteEntitlement(u.id, 'coach.gold')).toBe(true);
      expect(await repos.wallet.deleteEntitlement(u.id, 'coach.gold')).toBe(false);
      expect(await repos.wallet.getEntitlements(u.id)).toEqual([]);
    });

    it('store events: recorded once by event id, with an outcome, and forgettable', async () => {
      const u = await user();
      const e = { eventId: 'evt-' + randomHex(6), vendor: 'revenuecat', type: 'RENEWAL', userId: null, productId: 'coach.gold.month', environment: 'SANDBOX', outcome: 'received', raw: { event: { id: 'x', n: [1] } }, receivedAt: T0 };
      expect(await repos.storeEvents.record(e)).toBe(true);
      expect(await repos.storeEvents.record({ ...e, type: 'EXPIRATION' })).toBe(false);
      await repos.storeEvents.setOutcome(e.eventId, 'entitled', u.id);
      expect(await repos.storeEvents.get(e.eventId)).toEqual({ ...e, outcome: 'entitled', userId: u.id });
      expect(await repos.storeEvents.get('missing-' + e.eventId)).toBeNull();
      expect(await repos.storeEvents.delete(e.eventId)).toBe(true);
      expect(await repos.storeEvents.get(e.eventId)).toBeNull();
    });

    it('reports: create, count a reporter\'s recent reports, list reports about a player', async () => {
      const u = await user();
      const v = await user();
      const r1 = await repos.reports.create({ reporterId: u.id, reportedUserId: v.id, roomCode: 'AB12CD', reason: 'abusive_chat', details: 'Rude in chat', createdAt: T0 });
      expect(r1).toMatchObject({ reporterId: u.id, reportedUserId: v.id, roomCode: 'AB12CD', reason: 'abusive_chat', details: 'Rude in chat', status: 'open', createdAt: T0 });
      expect(typeof r1.id).toBe('number');
      await repos.reports.create({ reporterId: u.id, reportedUserId: v.id, roomCode: null, reason: 'stalling', details: null, createdAt: T0 + 1000 });
      expect(await repos.reports.countByReporterSince(u.id, T0)).toBe(2);
      expect(await repos.reports.countByReporterSince(u.id, T0 + 1)).toBe(1);
      expect(await repos.reports.countByReporterSince(v.id, T0)).toBe(0);
      expect((await repos.reports.listAbout(v.id)).map((r) => r.reason)).toEqual(['stalling', 'abusive_chat']);
    });

    it('clubs: the season, its start and the archived seasons round trip, with season points apart from lifetime', async () => {
      const owner = await user('account', 'Ah-Hua');
      const m = await user('guest', 'Bao');
      const club = clubFixture(owner, {
        members: [member(owner, 'owner', T0, 500), { ...member(m, 'member', T0 + 1, 200), seasonPoints: -40 }],
        season: 3,
        seasonStartedAt: T0 + 7_000,
        seasons: [
          { season: 1, startedAt: T0, endedAt: T0 + 3_000, standings: [{ userId: owner.id, name: 'Ah-Hua', points: 300 }] },
          { season: 2, startedAt: T0 + 3_000, endedAt: T0 + 7_000, standings: [{ userId: m.id, name: 'Bao', points: 240 }, { userId: owner.id, name: 'Ah-Hua', points: 0 }] },
        ],
      });
      await repos.clubs.save(club);
      expect(normalise(await repos.clubs.get(club.code))).toEqual(normalise(club));
    });

    it('table snapshots: upsert, active list, prune finished, delete', async () => {
      const open = { roomCode: code('S'), clubCode: null, status: 'playing' as const, snapshot: { version: 1, seats: [1, 2] }, updatedAt: T0 };
      const done = { roomCode: code('S'), clubCode: 'CLUB01', status: 'finished' as const, snapshot: { version: 1 }, updatedAt: T0 };
      await repos.tableSnapshots.save(open);
      await repos.tableSnapshots.save(done);
      await repos.tableSnapshots.save({ ...open, snapshot: { version: 1, seats: [3] }, updatedAt: T0 + 1 });
      expect(await repos.tableSnapshots.get(open.roomCode)).toEqual({ ...open, snapshot: { version: 1, seats: [3] }, updatedAt: T0 + 1 });
      const active = (await repos.tableSnapshots.listActive()).map((s) => s.roomCode);
      expect(active).toContain(open.roomCode);
      expect(active).not.toContain(done.roomCode);
      expect(await repos.tableSnapshots.pruneFinished(T0 - 1)).toBe(0);
      expect(await repos.tableSnapshots.pruneFinished(T0 + 1)).toBeGreaterThanOrEqual(1);
      expect(await repos.tableSnapshots.get(done.roomCode)).toBeNull();
      expect(await repos.tableSnapshots.delete(open.roomCode)).toBe(true);
      expect(await repos.tableSnapshots.get(open.roomCode)).toBeNull();
    });

    it('match and puzzle results', async () => {
      const club = code('M');
      const room = code('R');
      const players = [{ seat: 0, name: 'A', userId: randomUUID(), isBot: false }, { seat: 1, name: 'Bot', userId: null, isBot: true }];
      const older = await repos.matchResults.record({ roomCode: room, clubCode: club, handCount: 16, scores: [500, -500], players, handsWon: [9, 7], finishedAt: T0 });
      const newer = await repos.matchResults.record({ roomCode: code('R'), clubCode: club, handCount: 8, scores: [0, 0], players, handsWon: [4, 4], finishedAt: T0 + 60_000 });
      expect(older).toMatchObject({ roomCode: room, scores: [500, -500], players, handsWon: [9, 7] });
      expect((await repos.matchResults.listForClub(club)).map((r) => r.id)).toEqual([newer.id, older.id]);
      expect((await repos.matchResults.listForClub(club, 1)).map((r) => r.id)).toEqual([newer.id]);
      expect(await repos.matchResults.listForRoom(room)).toEqual([older]);

      const u = await user();
      const v = await user();
      await repos.puzzleResults.record({ userId: u.id, kind: 'daily', puzzleKey: '2026-01-01', correct: true, seconds: 41, ratingAfter: 1216, createdAt: T0 });
      await repos.puzzleResults.record({ userId: u.id, kind: 'rush', puzzleKey: 'r-7', correct: false, seconds: 5, ratingAfter: null, createdAt: T0 + 1 });
      expect((await repos.puzzleResults.listForUser(u.id)).map((r) => r.puzzleKey)).toEqual(['2026-01-01', 'r-7']);
      expect(await repos.puzzleResults.moveToUser(u.id, v.id)).toBe(2);
      expect(await repos.puzzleResults.listForUser(u.id)).toEqual([]);
      expect((await repos.puzzleResults.listForUser(v.id, 1))[0]).toMatchObject({ kind: 'daily', correct: true, seconds: 41, ratingAfter: 1216 });
    });

    it('transactions commit together and roll back together', async () => {
      const id = randomUUID();
      await repos.transaction(async (tx) => {
        await tx.users.create({ id, kind: 'guest', createdAt: T0 });
        await tx.transaction(async (inner) => inner.users.update(id, { displayName: 'Nested' }));
      });
      expect((await repos.users.get(id))?.displayName).toBe('Nested');
      const lost = randomUUID();
      const kept = await user();
      await expect(
        repos.transaction(async (tx) => {
          await tx.users.create({ id: lost, kind: 'guest', createdAt: T0 });
          await tx.wallet.apply({ userId: kept.id, delta: 500, reason: 'purchase', ref: 'tx-lost', createdAt: T0 });
          await tx.clubs.save(clubFixture(kept));
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await repos.users.get(lost)).toBeNull();
      expect(await repos.wallet.get(kept.id)).toMatchObject({ diamonds: 0 });
      expect(await repos.clubs.clubsForUser(kept.id)).toEqual([]);
      // Two transactions started together do not see each other's half-done work.
      const a = await user();
      const b = await user();
      const first = repos.transaction(async (tx) => {
        await tx.wallet.apply({ userId: a.id, delta: 5, reason: 'test', createdAt: T0 });
        await tx.wallet.apply({ userId: a.id, delta: 5, reason: 'test', createdAt: T0 });
        return (await tx.wallet.get(b.id)).diamonds;
      });
      const second = repos.transaction(async (tx) => {
        await tx.wallet.apply({ userId: b.id, delta: 7, reason: 'test', createdAt: T0 });
        throw new Error('undo');
      });
      expect(await first).toBe(0);
      await expect(second).rejects.toThrow('undo');
      expect((await repos.wallet.get(a.id)).diamonds).toBe(10);
      expect((await repos.wallet.get(b.id)).diamonds).toBe(0);
    });
  });
}

contract('memory repositories', async () => createMemoryRepos());

describe.skipIf(!PG_URL)('postgres', () => {
  let admin: Pool;
  let pool: Pool;
  const schema = 'mjm_test_' + randomHex(6);

  contract(
    'postgres repositories',
    async () => {
      admin = createPool(PG_URL!, { max: 1 });
      await admin.query('CREATE SCHEMA ' + schema);
      pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
      expect(await ping(pool)).toBe(true);
      expect(await migrate(pool)).toEqual(['0001_init', '0002_store_reports_seasons']);
      expect(await migrate(pool)).toEqual([]);
      return createPgRepos(pool);
    },
    async () => {
      await pool?.end();
      await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await admin?.end();
    },
  );
});

describe('createRepos and the pg source', () => {
  it('falls back to memory without a database URL', async () => {
    const handle = createRepos({ databaseUrl: '  ' });
    expect(handle.kind).toBe('memory');
    expect(handle.pool).toBeNull();
    expect(await handle.healthy()).toBe(true);
    await handle.close();
  });

  it('selects Postgres when a URL is given (no connection is made until a query)', async () => {
    const handle = createRepos({ databaseUrl: 'postgres://user:pass@db.example.invalid:5432/app' });
    expect(handle.kind).toBe('pg');
    expect(handle.repos.kind).toBe('pg');
    await handle.close();
  });

  it('pg.ts never interpolates values into SQL', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/repos/pg.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('${');
  });
});
