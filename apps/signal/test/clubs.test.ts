import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, RULE_LIMITS } from '@mjm/engine';
import { deleteAccount } from '../src/auth';
import { CLUB_LIMITS, ClubError, ClubRegistry, sanitizeSettings, type Club, type ClubStore } from '../src/clubs';
import { createMemoryRepos, type Repos } from '../src/repos';
import type { ApiOptions } from '../src/api';
import { BucketTable } from '../src/limits';
import { apiFixture, request } from './helpers';

const alice = { userId: 'user-alice-1', name: 'Alice', avatar: '🐼' };
const bob = { userId: 'user-bob-22', name: 'Bob' };

describe('ClubRegistry', () => {
  it('creates, joins, sets rules, opens tables and ranks standings; persists club by club through the store', async () => {
    const store = createMemoryRepos().clubs;
    const reg = new ClubRegistry({ store, now: () => 1000 });
    const club = reg.createClub(alice, 'Taipei Tigers', { basePoints: 300, taiPoints: 100 });
    expect(club.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(club.rules.basePoints).toBe(300);
    expect(reg.joinClub(club.code.toLowerCase(), bob).status).toBe('joined');
    expect(() => reg.update(club.code, bob.userId, { rules: { taiPoints: 1 } })).toThrow(ClubError);
    reg.update(club.code, alice.userId, { rules: { taiPoints: 50 }, settings: { joinRequiresApproval: true } });
    expect(reg.joinClub(club.code, { userId: 'user-carol-3', name: 'Carol' }).status).toBe('pending');
    reg.approve(club.code, alice.userId, 'user-carol-3');
    expect(reg.club(club.code).members).toHaveLength(3);
    const t = reg.addTable(club.code, bob.userId, { code: 'ROOM01' });
    expect(t.rules.taiPoints).toBe(50);
    reg.recordMatch(club.code, [
      { userId: alice.userId, points: 400, handsWon: 3 },
      { userId: bob.userId, points: -400, handsWon: 1 },
    ]);
    const st = reg.standings(club.code);
    expect(st[0].userId).toBe(alice.userId);
    expect(st[0].matchesWon).toBe(1);
    // Reload from the store once the writes behind the registry have landed.
    await reg.flush();
    const reg2 = new ClubRegistry({ store });
    await reg2.load();
    expect(reg2.club(club.code).members.find((m) => m.userId === bob.userId)!.points).toBe(-400);
    expect(reg2.clubsForUser(bob.userId)).toHaveLength(1);
    expect(reg2.club(club.code).tables.map((t) => t.code)).toEqual(['ROOM01']);
  });

  it('writes each club in order and folds a burst of changes into one write', async () => {
    const saved: string[] = [];
    const inner = createMemoryRepos().clubs;
    const store: ClubStore = { ...inner, save: async (c) => (saved.push(`${c.code}:${c.name}`), inner.save(c)) };
    const reg = new ClubRegistry({ store });
    const a = reg.createClub(alice, 'One');
    for (let i = 0; i < 10; i++) reg.update(a.code, alice.userId, { name: `One ${i}` });
    await reg.flush();
    // The writes run behind the registry, so the create and the ten renames become one write.
    expect(saved).toEqual([`${a.code}:One 9`]);
    reg.update(a.code, alice.userId, { name: 'Two' });
    reg.update(a.code, alice.userId, { description: 'later' });
    await reg.flush();
    expect(saved).toEqual([`${a.code}:One 9`, `${a.code}:Two`]);
    expect(await inner.get(a.code)).toMatchObject({ name: 'Two', description: 'later' });
  });

  it('writes a club again after a failed write: at once on flush, and with backoff in between', async () => {
    vi.useFakeTimers();
    try {
      const inner = createMemoryRepos().clubs;
      let failures = 0;
      const store: ClubStore = {
        ...inner,
        save: async (c) => {
          if (failures > 0) {
            failures--;
            throw new Error('connection terminated unexpectedly');
          }
          return inner.save(c);
        },
      };
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const reg = new ClubRegistry({ store, retryDelayMs: 1000 });
      const club = reg.createClub(alice, 'Night owls');
      await reg.flush();
      // One transient error at the last change before a restart: flush() still gets it written.
      failures = 1;
      reg.recordMatch(club.code, [{ userId: alice.userId, points: 120, handsWon: 3 }]);
      await reg.flush();
      expect(reg.unsaved).toEqual([]);
      expect((await inner.get(club.code))!.members[0].points).toBe(120);
      // Two errors in a row with no flush: the retry timer (1 s, then 2 s) brings the store up to date.
      failures = 2;
      reg.recordMatch(club.code, [{ userId: alice.userId, points: 30, handsWon: 1 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(reg.unsaved).toEqual([club.code]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(reg.unsaved).toEqual([club.code]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(reg.unsaved).toEqual([]);
      expect((await inner.get(club.code))!.members[0].points).toBe(150);
      expect(errors).toHaveBeenCalledTimes(3);
      // The next process reads the right standings.
      const next = new ClubRegistry({ store: inner });
      await next.load();
      expect(next.club(club.code).members[0].points).toBe(150);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('an account deletion racing a club write keeps the anonymised name in the store and the points scored meanwhile', async () => {
    const repos = createMemoryRepos();
    const inner = repos.clubs;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // A slow store (each save takes 20 ms) and a slow deletion transaction (it runs after 5 ms).
    const store: ClubStore = { ...inner, save: async (c) => (await sleep(20), inner.save(c)) };
    const slowRepos: Repos = { ...repos, transaction: async (fn) => (await sleep(5), repos.transaction(fn)) };
    const owner = await repos.users.create({ id: randomUUID(), kind: 'guest', displayName: 'Owner', createdAt: Date.now() });
    const gina = await repos.users.create({ id: randomUUID(), kind: 'guest', displayName: 'Gina RealName', createdAt: Date.now() });
    const reg = new ClubRegistry({ store });
    const club = reg.createClub({ userId: owner.id, name: 'Owner' }, 'Race');
    reg.joinClub(club.code, { userId: gina.id, name: gina.displayName });
    await reg.flush();
    // DELETE /api/me, as api.ts does it, with a hand finishing in the club while the transaction runs.
    await reg.flush();
    const deletion = deleteAccount(slowRepos, gina.id);
    setTimeout(() => reg.recordMatch(club.code, [{ userId: owner.id, points: 10, handsWon: 1 }]), 1);
    await deletion;
    reg.anonymiseMember(gina.id);
    await reg.flush();
    const inMemory = reg.club(club.code);
    expect(inMemory.members.find((m) => m.userId === gina.id)!.name).toBe('Deleted player');
    expect(inMemory.members.find((m) => m.userId === owner.id)!.points).toBe(10);
    const stored = (await inner.get(club.code))!;
    expect(stored.members.find((m) => m.userId === gina.id)!.name).toBe('Deleted player');
    expect(stored.members.find((m) => m.userId === owner.id)!.points).toBe(10);
  });
});

describe('API routes + hosted club tables', () => {
  it('opens a server-hosted table for a club and tracks it through host events', async () => {
    let now = 0;
    const { call, guest, rooms } = apiFixture({ now: () => now });
    const a = await guest('Alice');
    const b = await guest('Bob');
    const created = await call('POST', '/api/clubs', { name: 'API Club', rules: { handsPerMatch: 4 } }, a.auth);
    expect(created.status).toBe(200);
    const club = created.json as unknown as Club;
    expect(club.ownerId).toBe(a.userId);
    expect(club.members[0]).toMatchObject({ userId: a.userId, name: 'Alice' });
    // Without a session, or with a bad one, nothing happens.
    expect((await call('POST', `/api/clubs/${club.code}/join`, {})).status).toBe(401);
    expect((await call('POST', `/api/clubs/${club.code}/join`, {}, { authorization: `Bearer mjs_${'0'.repeat(64)}` })).json.error).toBe('invalid_session');
    expect((await call('POST', `/api/clubs/${club.code}/join`, {}, b.auth)).json.status).toBe('joined');
    const table = (await call('POST', `/api/clubs/${club.code}/tables`, { label: 'Friday' }, a.auth)).json as { code: string; rules: { handsPerMatch: number } };
    expect(table.rules.handsPerMatch).toBe(4);
    expect(rooms.hasRoom(table.code)).toBe(true);
    expect(rooms.clubOf(table.code)).toBe(club.code);
    expect(((await call('GET', `/api/clubs/${club.code}`, undefined, a.auth)).json as unknown as Club).tables[0].label).toBe('Friday');
    // A room with no peers survives ticks until keep-alive expires
    rooms.tick();
    expect(rooms.hasRoom(table.code)).toBe(true);
    now += 16 * 60_000;
    rooms.tick();
    expect(rooms.hasRoom(table.code)).toBe(false);
    // Unknown club → 404
    expect((await call('GET', '/api/clubs/NOPE99', undefined, a.auth)).status).toBe(404);
  });

  it('shows members the whole club and everyone else the public view; standings are members-only', async () => {
    const { call, guest } = apiFixture();
    const a = await guest('Alice');
    const c = await guest('Carol');
    const club = (await call('POST', '/api/clubs', { name: 'Private', settings: { joinRequiresApproval: true } }, a.auth)).json as unknown as Club;
    await call('PATCH', `/api/clubs/${club.code}`, { description: 'Fridays' }, a.auth);
    const outsider = await call('GET', `/api/clubs/${club.code}`, undefined, c.auth);
    expect(outsider.json).toEqual({ code: club.code, name: 'Private', description: 'Fridays', memberCount: 1, joinRequiresApproval: true });
    expect((await call('GET', `/api/clubs/${club.code}/standings`, undefined, c.auth)).status).toBe(403);
    // A pending request is not membership.
    const join = await call('POST', `/api/clubs/${club.code}/join`, {}, c.auth);
    expect(join.json.status).toBe('pending');
    expect(join.json.club).toEqual(outsider.json);
    expect((await call('GET', `/api/clubs/${club.code}/standings`, undefined, c.auth)).status).toBe(403);
    expect((await call('GET', `/api/users/${c.userId}/clubs`, undefined, c.auth)).json).toEqual([outsider.json]);
    // Nobody can list someone else's clubs.
    expect((await call('GET', `/api/users/${a.userId}/clubs`, undefined, c.auth)).status).toBe(403);
    // Carol renames herself before she is approved: the club shows her current name.
    await call('PATCH', '/api/me', { displayName: 'Carol W' }, c.auth);
    const approved = (await call('POST', `/api/clubs/${club.code}/members/${c.userId}/approve`, {}, a.auth)).json as unknown as Club;
    expect(approved.members.find((m) => m.userId === c.userId)!.name).toBe('Carol W');
    const standings = (await call('GET', `/api/clubs/${club.code}/standings`, undefined, c.auth)).json as unknown as Array<{ userId: string }>;
    expect(standings.map((s) => s.userId).sort()).toEqual([a.userId, c.userId].sort());
    // A later profile change reaches every club row.
    await call('PATCH', '/api/me', { displayName: 'Carol X', avatar: 'chef' }, c.auth);
    const full = (await call('GET', `/api/clubs/${club.code}`, undefined, a.auth)).json as unknown as Club;
    expect(full.members.find((m) => m.userId === c.userId)).toMatchObject({ name: 'Carol X', avatar: 'chef' });
  });
});

const user = (n: number) => ({ userId: `user-${String(n).padStart(4, '0')}`, name: `P${n}` });

function expectClubError(fn: () => unknown, code: ClubError['code'], message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ClubError);
  expect((caught as ClubError).code).toBe(code);
  if (message) expect((caught as ClubError).message).toMatch(message);
}

describe('ClubRegistry validation and limits', () => {
  it('accepts only known roles and never lets the owner change their own role', () => {
    const reg = new ClubRegistry();
    const club = reg.createClub(alice, 'Roles');
    reg.joinClub(club.code, bob);
    expectClubError(() => reg.setRole(club.code, alice.userId, bob.userId, 'superuser'), 'invalid', /Role must be/);
    expectClubError(() => reg.setRole(club.code, alice.userId, bob.userId, { role: 'admin' }), 'invalid');
    expectClubError(() => reg.setRole(club.code, alice.userId, alice.userId, 'member'), 'forbidden', /own role/);
    expect(reg.club(club.code).ownerId).toBe(alice.userId);
    expect(reg.club(club.code).members.find((m) => m.userId === alice.userId)!.role).toBe('owner');
    // A valid change still works, and transferring ownership demotes the old owner.
    expect(reg.setRole(club.code, alice.userId, bob.userId, 'admin').members.find((m) => m.userId === bob.userId)!.role).toBe('admin');
    reg.setRole(club.code, alice.userId, bob.userId, 'owner');
    expect(reg.club(club.code).ownerId).toBe(bob.userId);
    expect(reg.club(club.code).members.find((m) => m.userId === alice.userId)!.role).toBe('admin');
  });

  it('sanitises settings to strict booleans and drops unknown keys', () => {
    expect(sanitizeSettings({ joinRequiresApproval: 'yes', membersCanOpenTables: 0, neutralHost: true, evil: 1 })).toEqual({ membersCanOpenTables: true, joinRequiresApproval: false });
    expect(sanitizeSettings(['x'])).toEqual({ membersCanOpenTables: true, joinRequiresApproval: false });
    const reg = new ClubRegistry();
    const club = reg.createClub(alice, 'Settings', {}, { joinRequiresApproval: 'true', neutralHost: false });
    expect(club.settings).toEqual({ membersCanOpenTables: true, joinRequiresApproval: false });
    reg.update(club.code, alice.userId, { settings: { joinRequiresApproval: true, membersCanOpenTables: 'no' } });
    expect(reg.club(club.code).settings).toEqual({ membersCanOpenTables: true, joinRequiresApproval: true });
  });

  it('sanitises rules at create, update and addTable', () => {
    const reg = new ClubRegistry();
    const club = reg.createClub(alice, 'Rules', { basePoints: 'x', deadWallSize: -30, handsPerMatch: 1e9, evil: 'y' });
    expect(club.rules.basePoints).toBe(DEFAULT_RULES.basePoints);
    expect(club.rules.deadWallSize).toBe(RULE_LIMITS.deadWallSize[0]);
    expect(club.rules.handsPerMatch).toBe(RULE_LIMITS.handsPerMatch[1]);
    expect('evil' in club.rules).toBe(false);
    reg.update(club.code, alice.userId, { rules: { taiPoints: 50, turnSeconds: -1, allowChi: 'false' } });
    const rules = reg.club(club.code).rules;
    expect(rules.taiPoints).toBe(50);
    expect(rules.turnSeconds).toBe(RULE_LIMITS.turnSeconds[0]);
    expect(rules.allowChi).toBe(true);
    // Table rules start from the club's rules, which are already sanitised.
    const t = reg.addTable(club.code, alice.userId, { code: 'ROOM01', rules: { maxTai: 999, basePoints: Number.NaN } });
    expect(t.rules.maxTai).toBe(RULE_LIMITS.maxTai[1]);
    expect(t.rules.basePoints).toBe(DEFAULT_RULES.basePoints);
    expect(t.rules.taiPoints).toBe(50);
  });

  it('turns non-string names, descriptions and labels into ClubErrors', () => {
    const reg = new ClubRegistry();
    expectClubError(() => reg.createClub(alice, 5), 'invalid', /must be text/);
    expectClubError(() => reg.createClub(alice, '   '), 'invalid', /required/);
    const club = reg.createClub(alice, 'Strings');
    expectClubError(() => reg.update(club.code, alice.userId, { name: {} }), 'invalid');
    expectClubError(() => reg.update(club.code, alice.userId, { description: ['a', 'b'], rules: { basePoints: 999 } }), 'invalid');
    // A rejected patch leaves the club unchanged.
    expect(reg.club(club.code).rules.basePoints).toBe(DEFAULT_RULES.basePoints);
    expectClubError(() => reg.addTable(club.code, alice.userId, { code: 'T1', label: 42 }), 'invalid');
    expect(reg.club(club.code).tables).toHaveLength(0);
    reg.update(club.code, alice.userId, { name: `  ${'N'.repeat(100)}  `, description: 'd'.repeat(1000) });
    expect(reg.club(club.code).name).toHaveLength(CLUB_LIMITS.nameLength);
    expect(reg.club(club.code).description).toHaveLength(CLUB_LIMITS.descriptionLength);
  });

  it('caps clubs per user at 10', () => {
    const reg = new ClubRegistry();
    for (let i = 0; i < CLUB_LIMITS.clubsPerUser; i++) reg.createClub(alice, `Club ${i}`);
    expectClubError(() => reg.createClub(alice, 'One too many'), 'limit', /at most 10/);
    const other = reg.createClub(bob, 'Elsewhere');
    expectClubError(() => reg.joinClub(other.code, alice), 'limit');
    expect(reg.clubsForUser(alice.userId)).toHaveLength(10);
    // Joining a club you already belong to does not count as a new membership.
    expect(reg.joinClub(reg.clubsForUser(alice.userId)[0].code, alice).status).toBe('already');
  });

  it('caps members per club at 200, for direct joins and for approvals', () => {
    const reg = new ClubRegistry();
    const club = reg.createClub(alice, 'Big');
    for (let i = 1; i < CLUB_LIMITS.membersPerClub; i++) expect(reg.joinClub(club.code, user(i)).status).toBe('joined');
    expect(reg.club(club.code).members).toHaveLength(200);
    expectClubError(() => reg.joinClub(club.code, user(999)), 'limit', /full/);
    reg.update(club.code, alice.userId, { settings: { joinRequiresApproval: true } });
    expect(reg.joinClub(club.code, user(1000)).status).toBe('pending');
    expectClubError(() => reg.approve(club.code, alice.userId, user(1000).userId), 'limit');
    expect(reg.club(club.code).pending).toHaveLength(1);
  });

  it('caps open tables per club at 5, not counting finished tables', () => {
    const reg = new ClubRegistry();
    const club = reg.createClub(alice, 'Tables');
    for (let i = 0; i < CLUB_LIMITS.openTablesPerClub; i++) reg.addTable(club.code, alice.userId, { code: `T${i}` });
    expectClubError(() => reg.addTable(club.code, alice.userId, { code: 'T9' }), 'limit', /5 open tables/);
    reg.updateTable(club.code, 'T0', { status: 'finished' });
    expect(reg.addTable(club.code, alice.userId, { code: 'T9' }).label).toBe("Alice's table");
  });

  it('does not rewrite the store for table updates that change nothing', () => {
    const reg = new ClubRegistry({ store: createMemoryRepos().clubs });
    const club = reg.createClub(alice, 'Quiet');
    reg.addTable(club.code, alice.userId, { code: 'T1' });
    const before = reg.writeCount;
    const patch = { status: 'playing' as const, players: [{ seat: 0, name: 'Alice', isBot: false, connected: true }], handNumber: 1, scores: [0, 0, 0, 0] };
    reg.updateTable(club.code, 'T1', patch);
    expect(reg.writeCount).toBe(before + 1);
    for (let i = 0; i < 50; i++) reg.updateTable(club.code, 'T1', JSON.parse(JSON.stringify(patch)));
    expect(reg.writeCount).toBe(before + 1);
    reg.updateTable(club.code, 'T1', { ...patch, scores: [10, -10, 0, 0] });
    expect(reg.writeCount).toBe(before + 2);
  });

  it('cleans up legacy store data on load', async () => {
    const legacy = [{ ...new ClubRegistry().createClub(alice, 'Old'), rules: { basePoints: 'x' }, settings: { membersCanOpenTables: false, joinRequiresApproval: false, neutralHost: true } }] as unknown as Club[];
    const store = createMemoryRepos().clubs;
    const reg = new ClubRegistry({ store: { ...store, loadAll: async () => legacy } });
    await reg.load();
    const c = reg.all()[0];
    expect(c.settings).toEqual({ membersCanOpenTables: false, joinRequiresApproval: false });
    expect(c.rules.basePoints).toBe(DEFAULT_RULES.basePoints);
  });
});

const http = (handler: ReturnType<typeof apiFixture>['handler'], method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(handler, method, url, body, headers);

function api(opts: ApiOptions = {}) {
  return apiFixture({ api: opts, rooms: { maxHostedTables: 3 } });
}

describe('club HTTP API', () => {
  it('answers bad field types with 400, not 500', async () => {
    const { handler, guest } = api();
    const a = (await guest('Alice')).auth;
    expect((await http(handler, 'POST', '/api/clubs', { name: 5 }, a)).status).toBe(400);
    const created = await http(handler, 'POST', '/api/clubs', { name: 'HTTP' }, a);
    expect(created.status).toBe(200);
    const code = created.json.code as string;
    const me = (created.json as unknown as Club).ownerId;
    expect((await http(handler, 'PATCH', `/api/clubs/${code}`, { name: { trim: 1 } }, a)).status).toBe(400);
    expect((await http(handler, 'PATCH', `/api/clubs/${code}`, { description: [] }, a)).status).toBe(400);
    expect((await http(handler, 'POST', `/api/clubs/${code}/tables`, { label: 42 }, a)).status).toBe(400);
    expect((await http(handler, 'POST', `/api/clubs/${code}/tables`, { botSkill: 'grandmaster' }, a)).status).toBe(400);
    expect((await http(handler, 'POST', `/api/clubs/${code}/members/${me}/role`, { role: 'god' }, a)).status).toBe(400);
    expect((await http(handler, 'POST', '/api/clubs', '{not json', a)).status).toBe(400);
    // The old trust-on-first-use body is not a credential any more.
    expect((await http(handler, 'POST', '/api/clubs', { user: { userId: 'user-alice-1', name: 'A', secret: 'x'.repeat(20) }, name: 'X' })).status).toBe(401);
  });

  it('refuses a table before creating a room, and maps a full server to 503', async () => {
    const { handler, rooms, guest } = api();
    const a = (await guest('Alice')).auth;
    const b = (await guest('Bob')).auth;
    const code = (await http(handler, 'POST', '/api/clubs', { name: 'Rooms', settings: { membersCanOpenTables: false } }, a)).json.code as string;
    await http(handler, 'POST', `/api/clubs/${code}/join`, {}, b);
    // Bob may not open tables, and no room is left behind.
    expect((await http(handler, 'POST', `/api/clubs/${code}/tables`, {}, b)).status).toBe(403);
    expect(rooms.stats().hostedTables).toBe(0);
    const ok = await http(handler, 'POST', `/api/clubs/${code}/tables`, { botSkill: 'pro', rules: { basePoints: -5 } }, a);
    expect(ok.status).toBe(200);
    expect((ok.json.rules as { basePoints: number }).basePoints).toBe(0);
    expect(rooms.hostedTable(ok.json.code as string)!.rules.basePoints).toBe(0);
    rooms.createHostedRoom();
    rooms.createHostedRoom();
    const full = await http(handler, 'POST', `/api/clubs/${code}/tables`, {}, a);
    expect(full.status).toBe(503);
    expect(full.json.error).toBe('unavailable');
  });

  it('sends CORS headers only to configured origins', async () => {
    const none = api().handler;
    const r1 = await http(none, 'GET', '/health', undefined, { origin: 'https://evil.example' });
    expect(r1.status).toBe(200);
    expect(r1.headers['access-control-allow-origin']).toBeUndefined();
    const some = api({ corsOrigins: ['http://localhost:8081'] }).handler;
    expect((await http(some, 'GET', '/health', undefined, { origin: 'https://evil.example' })).headers['access-control-allow-origin']).toBeUndefined();
    const ok = await http(some, 'OPTIONS', '/api/clubs', undefined, { origin: 'http://localhost:8081' });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(ok.headers.vary).toBe('origin');
    const any = api({ corsOrigins: ['*'] }).handler;
    expect((await http(any, 'GET', '/health', undefined, { origin: 'https://x.example' })).headers['access-control-allow-origin']).toBe('*');
  });

  it('rate-limits HTTP per client IP with 429', async () => {
    let now = 0;
    const limiter = new BucketTable<string>(30, 10, { now: () => now });
    const { handler } = api({ limiter });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await http(handler, 'GET', '/health')).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    now += 100; // one token comes back at 10 per second
    expect((await http(handler, 'GET', '/health')).status).toBe(200);
    expect((await http(handler, 'GET', '/health')).status).toBe(429);
  });

  it('rejects bodies over 64 KiB counted in bytes', async () => {
    const { handler, guest } = api();
    const a = (await guest('Alice')).auth;
    const big = JSON.stringify({ name: 'x', description: '麻'.repeat(23_000) }); // about 69 KB of UTF-8 but only about 23 K characters
    expect(big.length).toBeLessThan(64 * 1024);
    const res = await http(handler, 'POST', '/api/clubs', big, a);
    expect(res.status).toBe(413);
    expect(res.json).toMatchObject({ error: 'too_large' });
  });

});
