/**
 * POST /api/reports (validation, storage, 10 a day per reporter) and club seasons
 * (POST /api/clubs/:code/season, standings with season and lifetime points), through the real
 * API handler over the memory repositories.
 */
import { describe, expect, it } from 'vitest';
import type { Club, SeasonRecord } from '../src/clubs';
import { apiFixture } from './helpers';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3_600_000;

function clock() {
  let t = T0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('POST /api/reports', () => {
  it('stores a report (201) and, for a player who allowed analytics, reports it without the free text', async () => {
    const events: Array<{ event: string; props?: Record<string, unknown> }> = [];
    const c = clock();
    const f = apiFixture({ now: c.now, deps: { analytics: { enabled: true, capture: (_id, event, props) => events.push({ event, props }), shutdown: async () => {} } } });
    const a = await f.guest('Ah-Hua');
    const b = await f.guest('Bao');
    expect((await f.call('PATCH', '/api/me', { analyticsConsent: true }, a.auth)).status).toBe(200);
    const res = await f.call('POST', '/api/reports', { reportedUserId: b.userId, roomCode: 'ab12cd', reason: 'abusive_chat', details: '  Swore at everyone  ' }, a.auth);
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ id: 1, status: 'open', createdAt: new Date(T0).toISOString() });
    expect(await f.repos.reports.listAbout(b.userId)).toEqual([
      { id: 1, reporterId: a.userId, reportedUserId: b.userId, roomCode: 'AB12CD', reason: 'abusive_chat', details: 'Swore at everyone', status: 'open', createdAt: T0 },
    ]);
    // The consent lookup is asynchronous: let it settle before reading the events.
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([{ event: 'report_filed', props: { reason: 'abusive_chat', hasRoom: true, hasDetails: true } }]);
  });

  it('sends no server-side analytics for a player who has not allowed them, or turned them off', async () => {
    const events: string[] = [];
    const f = apiFixture({ deps: { analytics: { enabled: true, capture: (_id, event) => events.push(event), shutdown: async () => {} } } });
    const silent = await f.guest('Never asked');
    const optedOut = await f.guest('Said no');
    const target = await f.guest('Target');
    expect((await f.call('PATCH', '/api/me', { analyticsConsent: false }, optedOut.auth)).status).toBe(200);
    expect((await f.call('PATCH', '/api/me', { analyticsConsent: 'yes' }, optedOut.auth)).status).toBe(400);
    for (const who of [silent, optedOut]) {
      expect((await f.call('POST', '/api/reports', { reportedUserId: target.userId, reason: 'cheating' }, who.auth)).status).toBe(201);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([]);
  });

  it('rejects bad input: no target, self, unknown reason, bad room code, unknown player, no session', async () => {
    const f = apiFixture();
    const a = await f.guest();
    const b = await f.guest();
    const post = (body: unknown, auth = a.auth) => f.call('POST', '/api/reports', body, auth);
    expect((await post({ reason: 'cheating' })).status).toBe(400);
    expect((await post({ reportedUserId: a.userId, reason: 'cheating' })).status).toBe(400);
    expect((await post({ reportedUserId: b.userId, reason: 'rude' })).status).toBe(400);
    expect((await post({ reportedUserId: b.userId, reason: 'cheating', roomCode: 'no way!' })).status).toBe(400);
    expect((await post({ reportedUserId: b.userId, reason: 'cheating', details: 42 })).status).toBe(400);
    const missing = await post({ reportedUserId: crypto.randomUUID(), reason: 'cheating' });
    expect([missing.status, missing.json.error]).toEqual([404, 'not_found']);
    expect((await post({ reportedUserId: b.userId, reason: 'cheating' }, {})).status).toBe(401);
    expect(await f.repos.reports.listAbout(b.userId)).toEqual([]);
  });

  it('allows 10 reports a day per reporter, then 429 until the oldest is a day old', async () => {
    const c = clock();
    const f = apiFixture({ now: c.now });
    const a = await f.guest();
    const targets = await Promise.all(Array.from({ length: 11 }, () => f.guest()));
    for (let i = 0; i < 10; i++) {
      expect((await f.call('POST', '/api/reports', { reportedUserId: targets[i].userId, reason: 'stalling' }, a.auth)).status).toBe(201);
      c.advance(HOUR);
    }
    const limited = await f.call('POST', '/api/reports', { reportedUserId: targets[10].userId, reason: 'stalling' }, a.auth);
    expect([limited.status, limited.json.error]).toEqual([429, 'rate_limited']);
    // Another player is not limited by a's reports.
    const b = await f.guest();
    expect((await f.call('POST', '/api/reports', { reportedUserId: targets[10].userId, reason: 'other' }, b.auth)).status).toBe(201);
    c.advance(14 * HOUR + 1); // the first report is now more than 24 hours old
    expect((await f.call('POST', '/api/reports', { reportedUserId: targets[10].userId, reason: 'stalling' }, a.auth)).status).toBe(201);
  });
});

describe('club seasons', () => {
  async function clubWithResults() {
    const c = clock();
    const f = apiFixture({ now: c.now });
    const owner = await f.guest('Ah-Hua');
    const member = await f.guest('Bao');
    const club = (await f.call('POST', '/api/clubs', { name: 'Tea House' }, owner.auth)).json as unknown as Club;
    await f.call('POST', `/api/clubs/${club.code}/join`, {}, member.auth);
    f.clubs.recordMatch(club.code, [
      { userId: owner.userId, points: 120, handsWon: 2 },
      { userId: member.userId, points: -120, handsWon: 1 },
    ]);
    return { ...f, c, owner, member, club };
  }

  it('standings carry season and lifetime points and the season number', async () => {
    const { call, owner, club } = await clubWithResults();
    const rows = (await call('GET', `/api/clubs/${club.code}/standings`, undefined, owner.auth)).json as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.name, r.seasonPoints, r.lifetimePoints, r.points, r.season])).toEqual([
      ['Ah-Hua', 120, 120, 120, 1],
      ['Bao', -120, -120, -120, 1],
    ]);
  });

  it('the owner starts a new season: standings are archived, season points reset, lifetime kept', async () => {
    const { call, clubs, c, owner, member, club } = await clubWithResults();
    c.advance(HOUR);
    const res = await call('POST', `/api/clubs/${club.code}/season`, {}, owner.auth);
    expect(res.status).toBe(200);
    const archived = res.json.archived as SeasonRecord;
    expect(archived).toEqual({
      season: 1,
      startedAt: T0,
      endedAt: T0 + HOUR,
      standings: [
        { userId: owner.userId, name: 'Ah-Hua', points: 120 },
        { userId: member.userId, name: 'Bao', points: -120 },
      ],
    });
    const after = res.json.club as Club;
    expect([after.season, after.seasonStartedAt, after.seasons]).toEqual([2, T0 + HOUR, [archived]]);

    // A match in the new season counts towards both.
    clubs.recordMatch(club.code, [
      { userId: owner.userId, points: -30, handsWon: 0 },
      { userId: member.userId, points: 30, handsWon: 1 },
    ]);
    const rows = (await call('GET', `/api/clubs/${club.code}/standings`, undefined, member.auth)).json as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.name, r.seasonPoints, r.lifetimePoints, r.season])).toEqual([
      ['Bao', 30, -90, 2],
      ['Ah-Hua', -30, 90, 2],
    ]);
    // Members see the history on the club.
    const seen = (await call('GET', `/api/clubs/${club.code}`, undefined, member.auth)).json as unknown as Club;
    expect(seen.seasons).toEqual([archived]);
  });

  it('only the owner may start a season; it is stored with the club', async () => {
    const { call, repos, clubs, owner, member, club } = await clubWithResults();
    const denied = await call('POST', `/api/clubs/${club.code}/season`, {}, member.auth);
    expect([denied.status, denied.json.error]).toEqual([403, 'forbidden']);
    expect((await call('POST', '/api/clubs/NOPE99/season', {}, owner.auth)).status).toBe(404);
    expect((await call('POST', `/api/clubs/${club.code}/season`, {})).status).toBe(401);
    await call('POST', `/api/clubs/${club.code}/season`, {}, owner.auth);
    await clubs.flush();
    const stored = await repos.clubs.get(club.code);
    expect(stored?.season).toBe(2);
    expect(stored?.members.map((m) => m.seasonPoints)).toEqual([0, 0]);
    expect(stored?.seasons).toHaveLength(1);
  });

  it('reads clubs stored before seasons existed as season 1 with every point in it', async () => {
    const { repos, clubs, owner, club } = await clubWithResults();
    await clubs.flush();
    const f2 = apiFixture();
    // A club row from before this change: no season fields and no seasonPoints.
    const legacy = structuredClone(await repos.clubs.get(club.code)) as Club;
    delete legacy.season;
    delete legacy.seasonStartedAt;
    delete legacy.seasons;
    for (const m of legacy.members) delete m.seasonPoints;
    await f2.repos.clubs.save(legacy);
    await f2.clubs.load();
    const rows = f2.clubs.standings(club.code);
    expect(rows.map((r) => [r.userId === owner.userId, r.seasonPoints, r.lifetimePoints, r.season])).toEqual([
      [true, 120, 120, 1],
      [false, -120, -120, 1],
    ]);
  });
});
