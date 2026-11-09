import { describe, expect, it } from 'vitest';
import type { Authoriser, FetchLike } from './http';
import { clubErrorMessage, clubLink, clubsApi, ownerRestricted, OWNER_GRACE_DAYS } from './clubs';
import { parseDeepLink } from '../push/deeplink';
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
    await clubsApi.setRole(ctx, 'AB12', 'u-7', 'owner');
    await clubsApi.leave(ctx, 'AB12', 'me-1');
    expect(calls.map((c) => [c.method, c.url.replace('https://game.example', ''), c.body])).toEqual([
      ['POST', '/api/clubs/AB12/tables/T%201/close', {}],
      ['POST', '/api/clubs/AB12/tables/T1/evict', { userId: 'u-9' }],
      ['POST', '/api/clubs/AB12/bans', { userId: 'u-9' }],
      ['DELETE', '/api/clubs/AB12/bans/u-9', {}],
      ['POST', '/api/clubs/AB12/members/u-8/reject', {}],
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
    ];
    for (const [e, key] of cases) {
      const m = clubErrorMessage(e);
      expect(m?.key).toBe(key);
      expect(en(key, m?.params)).toBeTruthy();
      expect(zh(key, m?.params)).toMatch(/[一-鿿]/);
    }
    expect(clubErrorMessage({ code: 'limit', message: 'You can own at most 3 clubs' })?.params).toEqual({ max: 3 });
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
