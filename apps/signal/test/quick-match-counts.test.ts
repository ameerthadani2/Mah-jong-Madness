/**
 * The anti-collusion counts across a restart (migrations 0017 and 0020): how often each pair of
 * accounts sat together at quick-match tables (with `sharedAddress`), each club's daily join
 * allowance per address and per device, and the hourly join allowances per address and per club.
 * The repositories on memory and (with DATABASE_URL_TEST) Postgres; the club registry and the
 * matchmaker writing through them; and on Postgres a whole server restarted on the same database,
 * whose admin views still read the counts and whose limits still hold.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { SessionService } from '../src/auth';
import { ClubError, ClubRegistry, CLUB_LIMITS } from '../src/clubs';
import { loadConfig } from '../src/config';
import { createPool, type Pool } from '../src/db';
import { Matchmaker, type QueuePeer } from '../src/matchmaking';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, createRepos, type Repos } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    const user = async () => (await repos().users.create({ id: randomUUID(), kind: 'guest', displayName: 'P', createdAt: T0 })).id;
    const sorted = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

    it('counts the tables each pair shared and how many from one address, keeps the most recent pairs, and the purge takes them', async () => {
      const r = repos();
      const [a, b] = sorted(await user(), await user());
      const [c, d] = sorted(await user(), await user());
      await r.quickMatchPairs.record([{ a, b, shared: true }], T0, 20_000);
      await r.quickMatchPairs.record([{ a: c, b: d, shared: false }], T0 + 500, 20_000);
      await r.quickMatchPairs.record([{ a, b, shared: false }], T0 + 1000, 20_000);
      const mine = (await r.quickMatchPairs.frequent(1, 1000)).filter((p) => [a, c].includes(p.a));
      expect(mine).toEqual([
        { a, b, tables: 2, sharedAddress: 1, lastAt: T0 + 1000 },
        { a: c, b: d, tables: 1, sharedAddress: 0, lastAt: T0 + 500 },
      ]);
      expect((await r.quickMatchPairs.frequent(2, 1000)).some((p) => p.a === c)).toBe(false);
      // Past the most pairs kept, the one seen together least recently goes.
      const [e, f] = sorted(await user(), await user());
      await r.quickMatchPairs.record([{ a: e, b: f, shared: false }], T0 + 2000, 2);
      const kept = await r.quickMatchPairs.frequent(1, 1000);
      expect(kept.map((p) => p.a).sort()).toEqual([a, e].sort());
      await r.users.update(a, { deletedAt: T0 });
      expect(await r.users.purgeDeletedIds(T0 + 1)).toContain(a);
      expect((await r.quickMatchPairs.frequent(1, 1000)).some((p) => p.a === a || p.b === a)).toBe(false);
    });

    it('keeps a pair apart for good once it shared an IPv4 address at three tables in one UTC day, and never forgets it for room', async () => {
      const r = repos();
      const [a, b] = sorted(await user(), await user());
      const [c, d] = sorted(await user(), await user());
      const day2 = Date.UTC(2026, 10, 18, 0, 0, 0);
      // a and b: two shared tables one day and one the next, with an unshared one between: not yet.
      await r.quickMatchPairs.record([{ a, b, shared: true }], day2 - 2000, 20_000);
      await r.quickMatchPairs.record([{ a, b, shared: true }], day2 - 1000, 20_000);
      await r.quickMatchPairs.record([{ a, b, shared: false }], day2 + 500, 20_000);
      await r.quickMatchPairs.record([{ a, b, shared: true }], day2 + 1000, 20_000);
      expect(await r.quickMatchPairs.keptApart(a)).toEqual([]);
      // Two more that day make three: kept apart from then on, from either side.
      await r.quickMatchPairs.record([{ a, b, shared: true }, { a: c, b: d, shared: true }], day2 + 2000, 20_000);
      expect(await r.quickMatchPairs.keptApart(a)).toEqual([]);
      await r.quickMatchPairs.record([{ a, b, shared: true }], day2 + 3000, 20_000);
      expect(await r.quickMatchPairs.keptApart(a)).toEqual([b]);
      expect(await r.quickMatchPairs.keptApart(b)).toEqual([a]);
      expect(await r.quickMatchPairs.keptApart(c)).toEqual([]);
      // Past the most pairs kept (counting those not kept apart), the kept-apart pair stays although c and d were seen more recently.
      const [e, f] = sorted(await user(), await user());
      await r.quickMatchPairs.record([{ a: e, b: f, shared: false }], day2 + 9000, 1);
      expect(await r.quickMatchPairs.keptApart(a)).toEqual([b]);
      expect((await r.quickMatchPairs.frequent(1, 1000)).filter((p) => [a, c, e].includes(p.a)).map((p) => p.a).sort()).toEqual([a, e].sort());
    });

    it('a matchmaker on the store keeps apart a pair that shared an address at three tables in a day, after a restart too', async () => {
      const r = repos();
      const [x, y, z] = [await user(), await user(), await user()];
      let clock = T0 + 10_000;
      const tables: string[][] = [];
      const make = () =>
        new Matchmaker({
          fillMs: 1000,
          check: async () => null,
          avoid: async () => [],
          openTable: (ids) => {
            tables.push(ids);
            return 'ROOM';
          },
          pairStore: r.quickMatchPairs,
          now: () => clock,
        });
      const peer = (userId: string, address: string): QueuePeer => ({ peerId: randomUUID(), userId, address, send: () => undefined });
      let mm = make();
      for (let i = 0; i < 3; i++) {
        await mm.enqueue(peer(x, '198.51.100.30'));
        await mm.enqueue(peer(y, '198.51.100.30'));
        clock += 1000;
        mm.tick();
      }
      await mm.pairsSaved();
      expect(tables).toEqual([[x, y], [x, y], [x, y]]);
      // The process restarts; the pair now sits apart even when the alternative is bots.
      mm = make();
      await mm.enqueue(peer(x, '198.51.100.30'));
      await mm.enqueue(peer(y, '203.0.113.31'));
      await mm.enqueue(peer(z, '203.0.113.32'));
      clock += 1000;
      mm.tick();
      expect(tables.slice(3)).toEqual([[x, z], [y]]);
    });

    it('keeps the join allowance buckets by club, with one salt, and prunes the ones a day old', async () => {
      const r = repos();
      const salt = await r.joinAllowances.salt();
      expect(salt).toMatch(/^[0-9a-f]{32,}$/);
      expect(await r.joinAllowances.salt()).toBe(salt);
      const club = 'C' + randomHex(3).toUpperCase();
      await r.joinAllowances.save({ kind: 'address', clubCode: club, key: 'k1', tokens: 2.5, updatedAt: T0 });
      await r.joinAllowances.save({ kind: 'address', clubCode: club, key: 'k1', tokens: 1.5, updatedAt: T0 + 10 });
      await r.joinAllowances.save({ kind: 'device', clubCode: club, key: 'k2', tokens: 0, updatedAt: T0 - 2 * DAY });
      expect(await r.joinAllowances.forClub(club, T0 - 3 * DAY)).toHaveLength(2);
      expect((await r.joinAllowances.list(T0 - DAY)).filter((x) => x.clubCode === club)).toEqual([{ kind: 'address', clubCode: club, key: 'k1', tokens: 1.5, updatedAt: T0 + 10 }]);
      expect(await r.joinAllowances.prune(T0 - DAY)).toBeGreaterThanOrEqual(1);
      expect(await r.joinAllowances.forClub(club, 0)).toHaveLength(1);
    });

    it('a club registry restarted on the same store still refuses a fifth account from one address today, and a third from one device', async () => {
      const r = repos();
      let clock = Date.now();
      const now = () => clock;
      const first = new ClubRegistry({ allowances: r.joinAllowances, now });
      await first.load();
      const owner = { userId: randomUUID(), name: 'Owner' };
      const club = first.createClub(owner, 'Restart club', {}, {});
      const ip = '198.51.100.' + Math.floor(Math.random() * 200);
      for (let i = 0; i < CLUB_LIMITS.joinsPerDayPerClubAddress; i++) first.joinClub(club.code, { userId: randomUUID(), name: `P${i}` }, { ip });
      const install = 'install-' + randomHex(4);
      for (let i = 0; i < CLUB_LIMITS.joinsPerDayPerClubDevice; i++) first.joinClub(club.code, { userId: randomUUID(), name: `D${i}` }, { ip: `192.0.2.${i}`, device: install });
      await first.allowancesSaved();
      // The store never holds the address or the install id itself.
      expect(JSON.stringify(await r.joinAllowances.forClub(club.code, 0))).not.toContain(ip);
      expect(JSON.stringify(await r.joinAllowances.forClub(club.code, 0))).not.toContain(install);

      clock += 60_000;
      const second = new ClubRegistry({ allowances: r.joinAllowances, now });
      await second.load();
      // The club itself is the store's business (here: none); the allowance is what is checked first.
      (second as unknown as { clubs: Map<string, unknown> }).clubs.set(club.code, JSON.parse(JSON.stringify(first.club(club.code))));
      expect(() => second.joinClub(club.code, { userId: randomUUID(), name: 'Fifth' }, { ip })).toThrow(ClubError);
      expect(() => second.joinClub(club.code, { userId: randomUUID(), name: 'Third' }, { ip: '192.0.2.99', device: install })).toThrow(/this device/);
      // Another address still joins; and a day later the first one may again.
      second.joinClub(club.code, { userId: randomUUID(), name: 'Other' }, { ip: '203.0.113.77' });
      clock += DAY;
      const third = new ClubRegistry({ allowances: r.joinAllowances, now });
      await third.load();
      (third as unknown as { clubs: Map<string, unknown> }).clubs.set(club.code, JSON.parse(JSON.stringify(second.club(club.code))));
      expect(third.joinClub(club.code, { userId: randomUUID(), name: 'Tomorrow' }, { ip }).status).toBe('joined');
    });

    it('keeps the hourly join buckets by kind and key, and prunes the ones an hour old', async () => {
      const r = repos();
      const club = 'H' + randomHex(3).toUpperCase();
      const key = 'addr-' + randomHex(6);
      await r.joinAllowances.saveHour({ kind: 'address', key, tokens: 9, updatedAt: T0 });
      await r.joinAllowances.saveHour({ kind: 'address', key, tokens: 8.5, updatedAt: T0 + 10 });
      await r.joinAllowances.saveHour({ kind: 'club', key: club, tokens: 59, updatedAt: T0 + 20 });
      await r.joinAllowances.saveHour({ kind: 'club_new', key: club, tokens: 0, updatedAt: T0 - 2 * HOUR });
      const mine = <T extends { key: string }>(rows: T[]) => rows.filter((x) => x.key === key || x.key === club);
      expect(mine(await r.joinAllowances.listHours(T0 - HOUR)).sort((x, y) => x.updatedAt - y.updatedAt)).toEqual([
        { kind: 'address', key, tokens: 8.5, updatedAt: T0 + 10 },
        { kind: 'club', key: club, tokens: 59, updatedAt: T0 + 20 },
      ]);
      expect(await r.joinAllowances.pruneHours(T0 - HOUR)).toBeGreaterThanOrEqual(1);
      expect(mine(await r.joinAllowances.listHours(0))).toHaveLength(2);
    });

    it('a club registry restarted on the same store still refuses an eleventh club from one address this hour, and a sixty-first join to one club', async () => {
      const r = repos();
      let clock = Date.now();
      const now = () => clock;
      const first = new ClubRegistry({ allowances: r.joinAllowances, now });
      await first.load();
      const clubs = Array.from({ length: CLUB_LIMITS.joinsPerHourPerIp + 1 }, (_, i) => first.createClub({ userId: randomUUID(), name: `Owner ${i}` }, `Hour club ${i}`, {}, {}));
      const ip = '198.51.100.' + Math.floor(Math.random() * 200);
      for (let i = 0; i < CLUB_LIMITS.joinsPerHourPerIp; i++) first.joinClub(clubs[i].code, { userId: randomUUID(), name: `P${i}` }, { ip });
      const last = clubs[CLUB_LIMITS.joinsPerHourPerIp].code;
      expect(() => first.joinClub(last, { userId: randomUUID(), name: 'Eleventh' }, { ip })).toThrow(/from this connection/);
      // One club's hour, for established accounts and for new ones (each from its own address).
      const big = clubs[1].code;
      const fresh = { accountCreatedAt: clock };
      for (let i = 0; i < CLUB_LIMITS.joinsPerHourPerClub - 1; i++) first.joinClub(big, { userId: randomUUID(), name: `E${i}` }, { ip: `10.1.${i}.9` });
      for (let i = 0; i < CLUB_LIMITS.joinsPerHourPerClub; i++) first.joinClub(big, { userId: randomUUID(), name: `N${i}` }, { ip: `10.2.${i}.9`, ...fresh });
      expect(() => first.joinClub(big, { userId: randomUUID(), name: 'E61' }, { ip: '203.0.113.1' })).toThrow(/a lot of join requests/);
      expect(() => first.joinClub(big, { userId: randomUUID(), name: 'N61' }, { ip: '203.0.113.2', ...fresh })).toThrow(/a lot of join requests/);
      await first.allowancesSaved();
      // The store never holds the address itself.
      expect(JSON.stringify(await r.joinAllowances.listHours(0))).not.toContain(ip);

      // A restart a second later (a club refills one join a minute): every hourly allowance still stands.
      clock += 1000;
      const second = new ClubRegistry({ allowances: r.joinAllowances, now });
      await second.load();
      for (const c of clubs) (second as unknown as { clubs: Map<string, unknown> }).clubs.set(c.code, JSON.parse(JSON.stringify(first.club(c.code))));
      expect(() => second.joinClub(last, { userId: randomUUID(), name: 'Eleventh' }, { ip })).toThrow(/from this connection/);
      expect(() => second.joinClub(big, { userId: randomUUID(), name: 'E61' }, { ip: '203.0.113.3' })).toThrow(/a lot of join requests/);
      expect(() => second.joinClub(big, { userId: randomUUID(), name: 'N61' }, { ip: '203.0.113.4', ...fresh })).toThrow(/a lot of join requests/);
      // An hour on, they have refilled.
      clock += HOUR;
      const third = new ClubRegistry({ allowances: r.joinAllowances, now });
      await third.load();
      for (const c of clubs) (third as unknown as { clubs: Map<string, unknown> }).clubs.set(c.code, JSON.parse(JSON.stringify(second.club(c.code))));
      expect(third.joinClub(last, { userId: randomUUID(), name: 'Eleventh' }, { ip }).status).toBe('joined');
      expect(third.joinClub(big, { userId: randomUUID(), name: 'E61' }, { ip: '203.0.113.5' }).status).toBe('joined');
    });

    it('a club that turned down its whole queue keeps the hourly allowance it got back across a restart', async () => {
      const r = repos();
      let clock = Date.now();
      const now = () => clock;
      const first = new ClubRegistry({ allowances: r.joinAllowances, now });
      await first.load();
      const owner = { userId: randomUUID(), name: 'Owner' };
      const club = first.createClub(owner, 'Queue club', {}, { joinRequiresApproval: true });
      for (let i = 0; i < CLUB_LIMITS.joinsPerHourPerClub; i++) first.joinClub(club.code, { userId: randomUUID(), name: `Q${i}` }, { ip: `10.3.${i}.9` });
      expect(() => first.joinClub(club.code, { userId: randomUUID(), name: 'Q61' }, { ip: '203.0.113.9' })).toThrow(/a lot of join requests/);
      expect(first.rejectAll(club.code, owner.userId).rejected).toBe(CLUB_LIMITS.joinsPerHourPerClub);
      await first.allowancesSaved();
      clock += 1000;
      const second = new ClubRegistry({ allowances: r.joinAllowances, now });
      await second.load();
      (second as unknown as { clubs: Map<string, unknown> }).clubs.set(club.code, JSON.parse(JSON.stringify(first.club(club.code))));
      expect(second.joinClub(club.code, { userId: randomUUID(), name: 'Wanted' }, { ip: '203.0.113.10' }).status).toBe('pending');
    });

    it('a matchmaker writes its pair counts to the store, where a new matchmaker (a restart) leaves them', async () => {
      const r = repos();
      const ids = [await user(), await user(), await user()];
      let clock = T0 + 5000;
      const make = () => new Matchmaker({ fillMs: 1000, check: async () => null, avoid: async () => [], openTable: () => 'ROOM', pairStore: r.quickMatchPairs, now: () => clock });
      const mm = make();
      const peer = (userId: string, address: string): QueuePeer => ({ peerId: randomUUID(), userId, address, send: () => undefined });
      await mm.enqueue(peer(ids[0], '198.51.100.20'));
      await mm.enqueue(peer(ids[1], '198.51.100.20'));
      await mm.enqueue(peer(ids[2], '203.0.113.20'));
      clock += 1000;
      mm.tick();
      await mm.pairsSaved();
      expect(mm.frequentPairs(1)).toEqual([]);
      make();
      const mine = (await r.quickMatchPairs.frequent(1, 1000)).filter((p) => ids.includes(p.a));
      expect(mine).toHaveLength(3);
      const [a, b] = sorted(ids[0], ids[1]);
      expect(mine.find((p) => p.a === a && p.b === b)).toMatchObject({ tables: 1, sharedAddress: 1 });
    });
  });
}

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('quick-match counts (memory)', () => memory);

describe.skipIf(!PG_URL)('quick-match counts (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_counts_' + randomHex(6);
  const servers: SignalServer[] = [];

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => {} });
    pg = createPgRepos(pool);
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  contract('contract', () => pg);

  it('a server restarted on the same database still lists the pairs and still refuses a fifth join from one address', async () => {
    const adminToken = 'admin-' + randomHex(16);
    const boot = async () => {
      // A new pool each time: nothing survives in the process, only in the database.
      const p = createPool(PG_URL!, { options: '-c search_path=' + schema });
      const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos: createRepos({ pool: p }), sessions: new SessionService(createPgRepos(p), { pepper: 'counts-pepper-0123456789abcdef' }), providers: {}, config: loadConfig({ TRUST_PROXY: '1' }), botDelayMs: 0, persistDebounceMs: 20, log: () => undefined, quickMatchFillMs: 1500, adminToken });
      servers.push(server);
      const close = server.close.bind(server);
      server.close = async () => {
        await close();
        await p.end();
      };
      return { server, base: `http://127.0.0.1:${server.address().port}` };
    };
    let { server, base } = await boot();
    let n = 0;
    const guest = async () => {
      const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.20.0.${++n}` }, body: JSON.stringify({ device: { id: randomUUID(), platform: 'ios' }, displayName: `G${n}` }) });
      const json = (await res.json()) as { userId: string; session: { token: string } };
      await fetch(`${base}/api/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${json.session.token}` }, body: JSON.stringify({ birthYear: 1990 }) });
      return json;
    };
    const call = (method: string, path: string, token: string, from = '10.30.0.1', body?: unknown) =>
      fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': from }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    // Two accounts from one IPv4 address are matched together once their wait is up, and counted.
    const [x, y] = [await guest(), await guest()];
    // Both are in the queue well before the 1.5 s fill wait is up (kept apart by their address meanwhile).
    await Promise.all([x, y].map((g) => server.matchmaker.enqueue({ peerId: randomUUID(), userId: g.userId, address: '198.51.100.44', send: () => undefined })));
    expect(server.matchmaker.size()).toBe(2);
    await expect.poll(() => server.matchmaker.size(), { timeout: 10_000 }).toBe(0);
    await server.matchmaker.pairsSaved();

    // Four accounts join a club from one address; the fifth is refused.
    const owner = await guest();
    const club = (await (await call('POST', '/api/clubs', owner.session.token, '10.40.0.1', { name: 'Counted club' })).json()) as { club?: { code: string }; code?: string };
    const code = club.club?.code ?? club.code!;
    for (let i = 0; i < CLUB_LIMITS.joinsPerDayPerClubAddress; i++) expect((await call('POST', `/api/clubs/${code}/join`, (await guest()).session.token, '10.50.0.9')).status).toBe(200);
    expect((await call('POST', `/api/clubs/${code}/join`, (await guest()).session.token, '10.50.0.9')).status).toBe(429);

    await server.close();
    servers.splice(0);
    ({ server, base } = await boot());

    const pairs = (await (await fetch(`${base}/api/admin/quick-match/pairs?min=1`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as { scope: string; pairs: Array<{ a: { id: string }; b: { id: string }; tables: number; sharedAddress: number }> };
    expect(pairs.scope).toBe('database');
    expect(pairs.pairs.filter((p) => [x.userId, y.userId].includes(p.a.id)).map((p) => [p.a.id, p.b.id, p.tables, p.sharedAddress])).toEqual([[...[x.userId, y.userId].sort(), 1, 1]]);
    expect((await call('POST', `/api/clubs/${code}/join`, (await guest()).session.token, '10.50.0.9')).status).toBe(429);
    expect((await call('POST', `/api/clubs/${code}/join`, (await guest()).session.token, '10.50.0.10')).status).toBe(200);
    const view = (await (await fetch(`${base}/api/admin/clubs/${code}/join-allowances`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as { scope: string; perDay: { address: number; device: number }; buckets: Array<{ kind: string; key: string; joinedToday: number }> };
    expect(view.scope).toBe('database');
    expect(view.perDay).toEqual({ address: CLUB_LIMITS.joinsPerDayPerClubAddress, device: CLUB_LIMITS.joinsPerDayPerClubDevice });
    expect(view.buckets.filter((b) => b.kind === 'address').map((b) => b.joinedToday)).toEqual([4, 1]);
    expect(JSON.stringify(view)).not.toContain('10.50.0.9');
    expect((await fetch(`${base}/api/admin/clubs/${code}/join-allowances`)).status).toBe(401);
  });
});
