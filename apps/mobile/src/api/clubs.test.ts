import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Authoriser, FetchLike } from './http';
import { DEFAULT_RULES } from '@mjm/engine';
import { clubErrorMessage, clubErrorText, clubLink, clubListLine, clubMemberCount, clubsApi, isMemberView, ownerRestricted, OWNER_GRACE_DAYS } from './clubs';
import { parseDeepLink } from '../push/deeplink';
import { rulesStakes } from '../logic/rules-text';
import { translator } from '../logic/translator.fixture';

const en = translator('en');
const zh = translator('zh-TW');

/** Records each request and answers with `status` and `body`. */
function recorder(body: unknown = {}, status = 200) {
  const calls: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status < 400, status, text: async () => (body === null ? '' : JSON.stringify(body)) };
  };
  const auth: Authoriser = { token: async () => 'mjs_tok', onUnauthorised: () => undefined };
  return { calls, ctx: { base: 'https://game.example', auth, fetch } };
}

describe('club owner tool routes', () => {
  it('send each owner action to its route with the bearer token', async () => {
    const { calls, ctx } = recorder({ code: 'AB12' });
    await clubsApi.closeTable(ctx, 'AB12', 'T 1');
    await clubsApi.evict(ctx, 'AB12', 'T1', 'u-9');
    await clubsApi.ban(ctx, 'AB12', 'u-9');
    await clubsApi.unban(ctx, 'AB12', 'u-9');
    await clubsApi.reject(ctx, 'AB12', 'u-8');
    await clubsApi.rejectAll(ctx, 'AB12', ['u-5', 'u-6']);
    await clubsApi.setRole(ctx, 'AB12', 'u-7', 'owner');
    await clubsApi.leave(ctx, 'AB12', 'me-1');
    expect(calls.map((c) => [c.method, c.url.replace('https://game.example', ''), c.body])).toEqual([
      ['POST', '/api/clubs/AB12/tables/T%201/close', {}],
      ['POST', '/api/clubs/AB12/tables/T1/evict', { userId: 'u-9' }],
      ['POST', '/api/clubs/AB12/bans', { userId: 'u-9' }],
      ['DELETE', '/api/clubs/AB12/bans/u-9', {}],
      ['POST', '/api/clubs/AB12/members/u-8/reject', {}],
      ['POST', '/api/clubs/AB12/pending/reject-all', { userIds: ['u-5', 'u-6'] }],
      ['POST', '/api/clubs/AB12/members/u-7/role', { role: 'owner' }],
      ['DELETE', '/api/clubs/AB12/members/me-1', {}],
    ]);
    expect(calls.every((c) => c.auth === 'Bearer mjs_tok')).toBe(true);
  });

  it('deletes a club with the typed confirmation and accepts the empty 204 reply', async () => {
    const { calls, ctx } = recorder(null, 204);
    await expect(clubsApi.deleteClub(ctx, 'AB12', 'Tea House')).resolves.toEqual({});
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'https://game.example/api/clubs/AB12', body: { confirm: 'Tea House' } });
  });

  it('surfaces fourwinds_required when creating a club without the plan', async () => {
    const { ctx } = recorder({ error: 'fourwinds_required', message: 'Creating a club needs The Four Winds Club' }, 403);
    await expect(clubsApi.create(ctx, 'Tea', {})).rejects.toMatchObject({ code: 'fourwinds_required' });
  });
});

describe('clubLink', () => {
  it('shares a web link with a link domain and the app scheme without one, both of which the app opens', () => {
    const web = clubLink('ab12cd', { scheme: 'mahjongmania', domain: 'play.example.com' });
    expect(web).toBe('https://play.example.com/c/AB12CD');
    expect(parseDeepLink(web, ['mahjongmania'], ['play.example.com'])).toEqual({ kind: 'club', club: 'AB12CD' });
    const app = clubLink('AB12CD', { scheme: 'mahjongmania' });
    expect(app).toBe('mahjongmania://club/AB12CD');
    expect(parseDeepLink(app, ['mahjongmania'])).toEqual({ kind: 'club', club: 'AB12CD' });
  });
});

describe('clubErrorMessage', () => {
  it('maps the owner-tool and Four Winds refusals to keys that exist in both languages', () => {
    const cases: Array<[unknown, string]> = [
      [{ code: 'fourwinds_required', message: 'Creating a club needs The Four Winds Club' }, 'clubs.create.fourWindsTitle'],
      [{ code: 'forbidden', message: 'You cannot join this club' }, 'clubs.errors.cannotJoin'],
      [{ code: 'limit', message: 'You can own at most 3 clubs' }, 'clubs.errors.ownLimit'],
      [{ code: 'limit', message: 'This club can have only 1 open table until its owner renews The Four Winds Club' }, 'clubs.errors.lapsedCap'],
      [{ code: 'invalid', message: "Type the club's name to confirm" }, 'clubs.errors.confirmName'],
      [{ code: 'not_found', message: 'Table not found' }, 'clubs.errors.tableNotFound'],
      [{ code: 'not_found', message: 'That account is not banned' }, 'clubs.errors.notBanned'],
      [{ code: 'forbidden', message: 'Only the owner can remove an admin' }, 'clubs.errors.adminOnAdmin'],
      [{ code: 'forbidden', message: 'The owner cannot be removed; transfer ownership first' }, 'clubs.errors.ownerProtected'],
      [{ code: 'forbidden', message: 'You cannot do that to yourself' }, 'clubs.errors.notYourself'],
      [{ code: 'limit', message: 'That member already owns 3 clubs, the most one account may own' }, 'clubs.errors.transferLimit'],
      [{ code: 'rate_limited', message: 'Too many clubs joined from this connection; try again in an hour' }, 'clubs.errors.joinRateIp'],
      [{ code: 'rate_limited', message: 'This club is getting a lot of join requests; try again later' }, 'clubs.errors.joinRateClub'],
      [{ code: 'limit', message: 'This club has too many pending requests; try again later' }, 'clubs.errors.queueFull'],
    ];
    for (const [e, key] of cases) {
      const m = clubErrorMessage(e);
      expect(m?.key).toBe(key);
      expect(en(key, m?.params)).toBeTruthy();
      expect(zh(key, m?.params)).toMatch(/[一-鿿]/);
    }
    expect(clubErrorMessage({ code: 'limit', message: 'You can own at most 3 clubs' })?.params).toEqual({ max: 3 });
    expect(clubErrorMessage({ code: 'limit', message: 'That member already owns 3 clubs, the most one account may own' })?.params).toEqual({ max: 3 });
    expect(clubErrorMessage(new Error('Network request failed'))).toBeNull();
  });
});

describe('ownerRestricted', () => {
  it('is true only once the owner lapse is older than the grace', () => {
    const now = Date.UTC(2026, 10, 9);
    expect(ownerRestricted({ ownerLapsedAt: null }, now)).toBe(false);
    expect(ownerRestricted({}, now)).toBe(false);
    expect(ownerRestricted({ ownerLapsedAt: now - (OWNER_GRACE_DAYS - 1) * 86_400_000 }, now)).toBe(false);
    expect(ownerRestricted({ ownerLapsedAt: now - OWNER_GRACE_DAYS * 86_400_000 }, now)).toBe(true);
  });
});

describe('the line under a club in My clubs', () => {
  const mine = (members: number, open: number) => ({
    code: 'AB12',
    name: 'Dragon Gate',
    description: '',
    rules: DEFAULT_RULES,
    settings: { membersCanOpenTables: true, joinRequiresApproval: false },
    members: Array.from({ length: members }, (_, i) => ({ userId: `u${i}`, name: `P${i}`, role: 'member' as const, joinedAt: 0, points: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 })),
    tables: Array.from({ length: open + 1 }, (_, i) => ({ code: `T${i}`, label: 't', rules: DEFAULT_RULES, createdBy: 'u0', createdAt: 0, status: i < open ? ('open' as const) : ('finished' as const), players: [], handNumber: 0, scores: [] })),
  });

  it('shows members, open tables and stakes for a club this player belongs to', () => {
    expect(clubListLine(mine(3, 2), en)).toBe(`3 members · 2 tables open · ${rulesStakes(DEFAULT_RULES)}`);
    expect(clubListLine(mine(3, 2), zh)).toBe(`3 位成員 · 2 張牌桌開放中 · ${rulesStakes(DEFAULT_RULES)}`);
    expect(clubListLine(mine(0, 0), en)).toContain('0 members · 0 tables open');
  });

  it('says "1 member" and "1 table open", not "1 members"', () => {
    expect(clubListLine(mine(1, 1), en)).toBe(`1 member · 1 table open · ${rulesStakes(DEFAULT_RULES)}`);
    expect(en('clubs.memberCount', { count: 1 })).toBe('1 member');
    expect(en('clubs.memberCount', { count: 2 })).toBe('2 members');
    expect(zh('clubs.memberCount', { count: 1 })).toBe('1 位成員');
  });

  it('shows the member count alone for a club the player has only asked to join (the server sends no rules)', () => {
    // What GET /api/users/:id/clubs returns for a pending request: the public view.
    const pending = { code: 'AB12', name: 'Dragon Gate', description: '', memberCount: 4, joinRequiresApproval: true };
    expect(clubListLine(pending, en)).toBe('4 members');
    expect(clubListLine(pending, zh)).toBe('4 位成員');
  });
});

describe('the member view and the public view of a club', () => {
  const member = { userId: 'me', name: 'Me', role: 'member' as const, joinedAt: 0, points: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 };
  const full = { code: 'AB12', name: 'Dragon Gate', description: '', rules: DEFAULT_RULES, settings: { membersCanOpenTables: true, joinRequiresApproval: false }, members: [member], tables: [] };
  // What GET /api/clubs/:code answers anyone who is not a member: no rules, settings, members or tables.
  const publicView = { code: 'AB12', name: 'Dragon Gate', description: '', memberCount: 2, joinRequiresApproval: true };

  it('is the member view only with rules, settings and this player among the members', () => {
    expect(isMemberView(full, 'me')).toBe(true);
    expect(isMemberView(full, 'someone-else')).toBe(false);
    expect(isMemberView(publicView, 'me')).toBe(false);
    expect(isMemberView({ ...full, members: undefined }, 'me')).toBe(false);
  });

  it('counts members from either view', () => {
    expect(clubMemberCount(full)).toBe(1);
    expect(clubMemberCount(publicView)).toBe(2);
    expect(clubMemberCount({})).toBe(0);
  });

  it('the club screen shows a non-member the join card and never reads rules or settings before that check', () => {
    const code = readFileSync(join(__dirname, '..', 'screens', 'ClubsScreen.tsx'), 'utf8');
    const screen = code.slice(code.indexOf('export function ClubScreen'));
    const guard = screen.indexOf('if (!isMemberView(club, user.userId))');
    expect(guard).toBeGreaterThan(0);
    // Everything above the guard works on the public view: no member-only field is read there.
    expect(screen.slice(0, guard)).not.toMatch(/club\.(rules|settings|members|tables)\b/);
    const guest = screen.slice(guard, screen.indexOf('const members = club.members'));
    expect(guest).toMatch(/testID="club-join"/);
    expect(guest).toMatch(/clubsApi\.join\(ctx, club\.code\)/);
    expect(guest).not.toMatch(/club\.(rules|settings)\b/);
    expect(guest).not.toMatch(/clubs\.tabs\./);
    // A member whose view turns public on a refresh is told why the screen changed.
    expect(screen).toMatch(/if \(wasMember\.current && !member\) setLostMembership\(true\)/);
    expect(guest).toMatch(/clubs\.guest\.removed/);
  });
});

describe('opening a club table too soon after another', () => {
  /** Answers each request with the next reply in the list (the last one for any further request). */
  function sequence(replies: Array<{ status: number; body: unknown }>) {
    let n = 0;
    const fetch: FetchLike = async () => {
      const r = replies[Math.min(n++, replies.length - 1)];
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    };
    const auth: Authoriser = { token: async () => 'mjs_tok', onUnauthorised: () => undefined };
    return { ctx: { base: 'https://game.example', auth, fetch }, calls: () => n };
  }
  // The server's reply when the account's or the address's allowance for new tables is spent (apps/signal/src/api.ts).
  const refused = { status: 429, body: { error: 'rate_limited', message: 'Please wait a few seconds before opening another table' } };
  const table = { code: 'T1', label: "Tester's table", rules: DEFAULT_RULES };

  it('asks the player to wait a few seconds, in the language of the app', async () => {
    const { ctx } = sequence([refused]);
    const failure = await clubsApi.openTable(ctx, 'AB12', { label: 'x' }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(clubErrorText(failure, en)).toBe(en('errors.rateLimited'));
    expect(clubErrorText(failure, en)).toMatch(/wait a few seconds/i);
    expect(clubErrorText(failure, zh)).toBe(zh('errors.rateLimited'));
    expect(clubErrorText(failure, zh)).toMatch(/請稍等幾秒/);
    // Never the server's English sentence or its error code.
    expect(clubErrorText(failure, zh)).not.toMatch(/[A-Za-z]{3,}/);
  });

  it('reads the same when the whole address is being slowed down, whatever the sentence', async () => {
    const { ctx } = sequence([{ status: 429, body: { error: 'rate_limited', message: 'Too many requests' } }]);
    const failure = await clubsApi.openTable(ctx, 'AB12', {}).catch((e: unknown) => e);
    expect(clubErrorText(failure, zh)).toBe(zh('errors.rateLimited'));
  });

  it('is not remembered: the next try reaches the server and opens the table', async () => {
    const { ctx, calls } = sequence([refused, { status: 200, body: table }]);
    await expect(clubsApi.openTable(ctx, 'AB12', {})).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(clubsApi.openTable(ctx, 'AB12', {})).resolves.toMatchObject({ code: 'T1' });
    expect(calls()).toBe(2);
  });

  it('keeps its own lines for the refusals a club has words for', () => {
    expect(clubErrorText({ code: 'not_found', message: 'Table not found' }, en)).toBe(en('clubs.errors.tableNotFound'));
    expect(clubErrorText({ code: 'rate_limited', message: 'This club is getting a lot of join requests; try again later' }, zh)).toBe(zh('clubs.errors.joinRateClub'));
  });
});
