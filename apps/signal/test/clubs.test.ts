import { describe, expect, it } from 'vitest';
import { ClubError, ClubRegistry, type Club, type ClubData } from '../src/clubs';
import { RoomRegistry } from '../src/rooms';
import { buildRoutes } from '../src/api';

const alice = { userId: 'user-alice-1', name: 'Alice', avatar: '🐼' };
const bob = { userId: 'user-bob-22', name: 'Bob' };
const aliceCreds = { ...alice, secret: 'alice-secret-0123456789' };
const bobCreds = { ...bob, secret: 'bob-secret-0123456789abc' };

describe('ClubRegistry', () => {
  it('creates, joins, sets rules, opens tables and ranks standings; persists through the store', () => {
    let saved: ClubData = { clubs: [], credentials: {} };
    const store = { load: () => saved, save: (c: ClubData) => (saved = JSON.parse(JSON.stringify(c))) };
    const reg = new ClubRegistry({ store, now: () => 1000, random: () => 0.3 });
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
    const clubs = new ClubRegistry({ now: () => now, random: () => 0.7 });
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
