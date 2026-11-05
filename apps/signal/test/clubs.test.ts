import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, RULE_LIMITS } from '@mjm/engine';
import { CLUB_LIMITS, ClubError, ClubRegistry, sanitizeSettings, type Club, type ClubData } from '../src/clubs';
import { RoomRegistry } from '../src/rooms';
import { buildRoutes, createApiHandler, type ApiOptions } from '../src/api';
import { BucketTable } from '../src/limits';

const alice = { userId: 'user-alice-1', name: 'Alice', avatar: '🐼' };
const bob = { userId: 'user-bob-22', name: 'Bob' };
const aliceCreds = { ...alice, secret: 'alice-secret-0123456789' };
const bobCreds = { ...bob, secret: 'bob-secret-0123456789abc' };

describe('ClubRegistry', () => {
  it('creates, joins, sets rules, opens tables and ranks standings; persists through the store', () => {
    let saved: ClubData = { clubs: [], credentials: {} };
    const store = { load: () => saved, save: (c: ClubData) => (saved = JSON.parse(JSON.stringify(c))) };
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
    // Reload from the store
    const reg2 = new ClubRegistry({ store });
    expect(reg2.club(club.code).members.find((m) => m.userId === bob.userId)!.points).toBe(-400);
    expect(reg2.clubsForUser(bob.userId)).toHaveLength(1);
  });
});

describe('API routes + hosted club tables', () => {
  it('opens a server-hosted table for a club and tracks it through host events', () => {
    let now = 0;
    const rooms = new RoomRegistry({ allowHosted: true, now: () => now });
    const clubs = new ClubRegistry({ now: () => now });
    const routes = buildRoutes({ clubs, rooms });
    const call = (method: string, path: string, body: Record<string, unknown> = {}) => {
      for (const r of routes) {
        const m = r.pattern.exec(path);
        if (r.method === method && m) {
          const params: Record<string, string> = {};
          r.keys.forEach((k, i) => (params[k] = m[i + 1]));
          return r.handler(params, body, {} as never) as never;
        }
      }
      throw new Error(`no route ${method} ${path}`);
    };
    const club = call('POST', '/api/clubs', { user: aliceCreds, name: 'API Club', rules: { handsPerMatch: 4 } }) as Club;
    // Same user id with a different secret is rejected; missing secret is rejected
    expect(() => call('POST', `/api/clubs/${club.code}/join`, { user: { ...alice, secret: 'wrong-secret-0123456789' } })).toThrow(/Identity check/);
    expect(() => call('POST', `/api/clubs/${club.code}/join`, { user: bob })).toThrow(ClubError);
    expect((call('POST', `/api/clubs/${club.code}/join`, { user: bobCreds }) as { status: string }).status).toBe('joined');
    const table = call('POST', `/api/clubs/${club.code}/tables`, { user: aliceCreds, label: 'Friday' }) as { code: string; rules: { handsPerMatch: number } };
    expect(table.rules.handsPerMatch).toBe(4);
    expect(rooms.hasRoom(table.code)).toBe(true);
    expect((call('GET', `/api/clubs/${club.code}`) as Club).tables[0].label).toBe('Friday');
    // A room with no peers survives ticks until keep-alive expires
    rooms.tick();
    expect(rooms.hasRoom(table.code)).toBe(true);
    now += 16 * 60_000;
    rooms.tick();
    expect(rooms.hasRoom(table.code)).toBe(false);
    // Unknown club → 404-type error
    expect(() => call('GET', '/api/clubs/NOPE99')).toThrow(ClubError);
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
    let saves = 0;
    const store = { load: (): ClubData => ({ clubs: [], credentials: {} }), save: () => void saves++ };
    const reg = new ClubRegistry({ store });
    const club = reg.createClub(alice, 'Quiet');
    reg.addTable(club.code, alice.userId, { code: 'T1' });
    const before = saves;
    const patch = { status: 'playing' as const, players: [{ seat: 0, name: 'Alice', isBot: false, connected: true }], handNumber: 1, scores: [0, 0, 0, 0] };
    reg.updateTable(club.code, 'T1', patch);
    expect(saves).toBe(before + 1);
    for (let i = 0; i < 50; i++) reg.updateTable(club.code, 'T1', JSON.parse(JSON.stringify(patch)));
    expect(saves).toBe(before + 1);
    reg.updateTable(club.code, 'T1', { ...patch, scores: [10, -10, 0, 0] });
    expect(saves).toBe(before + 2);
  });

  it('cleans up legacy store data on load', () => {
    const legacy = { clubs: [{ ...new ClubRegistry().createClub(alice, 'Old'), rules: { basePoints: 'x' }, settings: { membersCanOpenTables: false, joinRequiresApproval: false, neutralHost: true } }], credentials: {} } as unknown as ClubData;
    const reg = new ClubRegistry({ store: { load: () => legacy, save: () => undefined } });
    const c = reg.all()[0];
    expect(c.settings).toEqual({ membersCanOpenTables: false, joinRequiresApproval: false });
    expect(c.rules.basePoints).toBe(DEFAULT_RULES.basePoints);
  });
});

/** Run the real HTTP handler against an in-memory request and response. */
async function http(handler: ReturnType<typeof createApiHandler>, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '10.0.0.1' } });
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    headersSent: false,
    setHeader: (k: string, v: string) => (out.headers[k.toLowerCase()] = v),
    writeHead: (status: number, h: Record<string, string> = {}) => {
      out.status = status;
      for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v;
    },
    end: (b?: string) => (out.body = b ?? ''),
  } as unknown as ServerResponse;
  const handled = await handler(req, res);
  return { handled, ...out, json: out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {} };
}

function api(opts: ApiOptions = {}) {
  const rooms = new RoomRegistry({ allowHosted: true, maxHostedTables: 3 });
  const clubs = new ClubRegistry();
  return { rooms, clubs, handler: createApiHandler({ clubs, rooms }, opts) };
}

describe('club HTTP API', () => {
  it('answers bad field types with 400, not 500', async () => {
    const { handler } = api();
    expect((await http(handler, 'POST', '/api/clubs', { user: aliceCreds, name: 5 })).status).toBe(400);
    const created = await http(handler, 'POST', '/api/clubs', { user: aliceCreds, name: 'HTTP' });
    expect(created.status).toBe(200);
    const code = created.json.code as string;
    expect((await http(handler, 'PATCH', `/api/clubs/${code}`, { user: aliceCreds, name: { trim: 1 } })).status).toBe(400);
    expect((await http(handler, 'PATCH', `/api/clubs/${code}`, { user: aliceCreds, description: [] })).status).toBe(400);
    expect((await http(handler, 'POST', `/api/clubs/${code}/tables`, { user: aliceCreds, label: 42 })).status).toBe(400);
    expect((await http(handler, 'POST', `/api/clubs/${code}/tables`, { user: aliceCreds, botSkill: 'grandmaster' })).status).toBe(400);
    expect((await http(handler, 'POST', `/api/clubs/${code}/members/${alice.userId}/role`, { user: aliceCreds, role: 'god' })).status).toBe(400);
    expect((await http(handler, 'POST', '/api/clubs', { user: 'nope' })).status).toBe(400);
    expect((await http(handler, 'POST', '/api/clubs', '{not json')).status).toBe(400);
  });

  it('refuses a table before creating a room, and maps a full server to 503', async () => {
    const { handler, rooms } = api();
    const code = (await http(handler, 'POST', '/api/clubs', { user: aliceCreds, name: 'Rooms', settings: { membersCanOpenTables: false } })).json.code as string;
    await http(handler, 'POST', `/api/clubs/${code}/join`, { user: bobCreds });
    // Bob may not open tables, and no room is left behind.
    expect((await http(handler, 'POST', `/api/clubs/${code}/tables`, { user: bobCreds })).status).toBe(403);
    expect(rooms.stats().hostedTables).toBe(0);
    const ok = await http(handler, 'POST', `/api/clubs/${code}/tables`, { user: aliceCreds, botSkill: 'pro', rules: { basePoints: -5 } });
    expect(ok.status).toBe(200);
    expect((ok.json.rules as { basePoints: number }).basePoints).toBe(0);
    expect(rooms.hostedTable(ok.json.code as string)!.rules.basePoints).toBe(0);
    rooms.createHostedRoom();
    rooms.createHostedRoom();
    const full = await http(handler, 'POST', `/api/clubs/${code}/tables`, { user: aliceCreds });
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
    const { handler } = api();
    const big = JSON.stringify({ user: aliceCreds, name: 'x', description: '麻'.repeat(23_000) }); // about 69 KB of UTF-8 but only about 23 K characters
    expect(big.length).toBeLessThan(64 * 1024);
    expect((await http(handler, 'POST', '/api/clubs', big)).status).toBe(400);
  });
});
