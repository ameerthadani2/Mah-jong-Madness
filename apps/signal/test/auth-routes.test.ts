/**
 * The account routes of docs/API.md through the real HTTP handler (createApiHandler) over the
 * memory repositories: guest bootstrap and login, refresh with its grace window, logout, the
 * profile, provider link and login against a local key set, unlinking, the error codes, the auth
 * rate limits and `GET /api/config`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { sha256Hex } from '@mjm/engine';
import { perMinute } from '../src/api';
import type { ProviderConfig } from '../src/auth';
import type { Club } from '../src/clubs';
import { apiFixture } from './helpers';

const MINUTE = 60_000;
const APPLE_AUD = 'com.example.mahjong';
const GOOGLE_AUD = 'web-client.apps.googleusercontent.com';
const device = () => ({ id: crypto.randomUUID(), platform: 'ios', appBuild: '12', locale: 'en' });
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

let appleKey: CryptoKey;
let googleKey: CryptoKey;
let providers: ProviderConfig;

beforeAll(async () => {
  const a = await generateKeyPair('ES256', { extractable: true });
  const g = await generateKeyPair('RS256', { extractable: true });
  appleKey = a.privateKey;
  googleKey = g.privateKey;
  const jwk = async (k: CryptoKey, kid: string, alg: string): Promise<JWK> => ({ ...(await exportJWK(k)), kid, alg, use: 'sig' });
  providers = {
    apple: { clientIds: [APPLE_AUD], jwks: { keys: [await jwk(a.publicKey, 'apple-1', 'ES256')] } },
    google: { clientIds: [GOOGLE_AUD], jwks: { keys: [await jwk(g.publicKey, 'google-1', 'RS256')] } },
  };
});

/** An Apple-shaped id token (the nonce claim is sha256 of the raw nonce) or a Google-shaped one (the raw nonce). */
function idToken(provider: 'apple' | 'google', sub: string, nonce: string, extra: Record<string, unknown> = {}) {
  const apple = provider === 'apple';
  return new SignJWT({ nonce: apple ? sha256Hex(nonce) : nonce, ...extra })
    .setProtectedHeader({ alg: apple ? 'ES256' : 'RS256', kid: apple ? 'apple-1' : 'google-1' })
    .setIssuer(apple ? 'https://appleid.apple.com' : 'https://accounts.google.com')
    .setAudience(apple ? APPLE_AUD : GOOGLE_AUD)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(apple ? appleKey : googleKey);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('guest accounts', () => {
  it('creates a guest (201) with the documented shape, and signs back in with the id and secret', async () => {
    const { call, repos } = apiFixture();
    const d = device();
    const res = await call('POST', '/api/auth/guest', { device: d, displayName: '  Mei ', avatar: 'lady' });
    expect(res.status).toBe(201);
    const { userId, guestSecret, session, user } = res.json as { userId: string; guestSecret: string; session: { token: string; expiresAt: string }; user: Record<string, unknown> };
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(guestSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(session.token).toMatch(/^mjs_[0-9a-f]{64}$/);
    expect(session.expiresAt).toMatch(ISO);
    expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(user).toEqual({ id: userId, kind: 'guest', displayName: 'Mei', avatar: 'lady', locale: 'en', birthYear: null, createdAt: expect.stringMatching(ISO) });
    // The app's own device id is kept.
    expect((await repos.devices.get(d.id))?.userId).toBe(userId);

    const login = await call('POST', '/api/auth/guest/login', { userId, guestSecret, device: d });
    expect(login.status).toBe(200);
    expect((login.json.user as { id: string }).id).toBe(userId);
    expect((login.json.session as { token: string }).token).not.toBe(session.token);
    const wrong = await call('POST', '/api/auth/guest/login', { userId, guestSecret: '0'.repeat(64), device: d });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toBe('invalid_credentials');
    expect(typeof wrong.json.message).toBe('string');
    expect((await call('POST', '/api/auth/guest/login', { userId: 5 })).json.error).toBe('invalid_credentials');
  });

  it('assigns a fresh device id when the app sends one already taken or not a UUID', async () => {
    const { call, repos } = apiFixture();
    const d = device();
    const first = (await call('POST', '/api/auth/guest', { device: d })).json.userId as string;
    const second = (await call('POST', '/api/auth/guest', { device: d })).json.userId as string;
    expect((await repos.devices.get(d.id))?.userId).toBe(first);
    expect(await repos.devices.listForUser(second)).toHaveLength(1);
    expect((await call('POST', '/api/auth/guest', { device: { id: 'not-a-uuid' } })).status).toBe(201);
    expect((await call('POST', '/api/auth/guest', { displayName: 7 })).status).toBe(400);
  });
});

describe('sessions', () => {
  it('refreshes: the old token keeps working for five minutes and cannot be refreshed twice', async () => {
    let now = Date.UTC(2026, 10, 5);
    const { call, guest } = apiFixture({ now: () => now });
    const g = await guest('Rui');
    const refreshed = await call('POST', '/api/auth/refresh', undefined, g.auth);
    expect(refreshed.status).toBe(200);
    const next = (refreshed.json.session as { token: string; expiresAt: string });
    expect(next.token).not.toBe(g.token);
    expect(Date.parse(next.expiresAt)).toBe(now + 30 * 86_400_000);
    // Grace window: the old token still reads /api/me...
    expect((await call('GET', '/api/me', undefined, g.auth)).status).toBe(200);
    // ...but cannot fork the chain.
    expect((await call('POST', '/api/auth/refresh', undefined, g.auth)).json.error).toBe('session_rotated');
    now += 5 * MINUTE + 1;
    const late = await call('GET', '/api/me', undefined, g.auth);
    expect(late.status).toBe(401);
    expect(late.json.error).toBe('session_revoked');
    expect((await call('GET', '/api/me', undefined, bearer(next.token))).status).toBe(200);
    // Thirty days without use and the session has expired.
    now += 31 * 86_400_000;
    expect((await call('GET', '/api/me', undefined, bearer(next.token))).json.error).toBe('session_expired');
  });

  it('logs out this session only', async () => {
    const { call, guest } = apiFixture();
    const g = await guest('Ann');
    const other = (await call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret })).json.session as { token: string };
    const out = await call('POST', '/api/auth/logout', undefined, g.auth);
    expect(out.status).toBe(204);
    expect(out.body).toBe('');
    expect((await call('GET', '/api/me', undefined, g.auth)).json.error).toBe('session_revoked');
    expect((await call('GET', '/api/me', undefined, bearer(other.token))).status).toBe(200);
  });

  it('answers 401 invalid_session for a missing or malformed bearer', async () => {
    const { call } = apiFixture();
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: `Basic mjs_${'a'.repeat(64)}` }, bearer(`mjs_${'a'.repeat(64)}`)]) {
      const res = await call('GET', '/api/me', undefined, headers);
      expect(res.status).toBe(401);
      expect(res.json.error).toBe('invalid_session');
    }
  });
});

describe('the profile', () => {
  it('reads, edits and deletes the account', async () => {
    const { call, guest, repos, clubs } = apiFixture();
    const g = await guest('Kai');
    await repos.wallet.apply({ userId: g.userId, delta: 50, bonus: 5, reason: 'test', createdAt: Date.now() });
    await repos.wallet.setEntitlement({ userId: g.userId, entitlement: 'coach_gold', expiresAt: Date.UTC(2027, 0, 1), source: 'store', updatedAt: Date.now() });
    const me = await call('GET', '/api/me', undefined, g.auth);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({
      user: { id: g.userId, kind: 'guest', displayName: 'Kai' },
      wallet: { diamonds: 50, bonusDiamonds: 5 },
      entitlements: [{ entitlement: 'coach_gold', expiresAt: '2027-01-01T00:00:00.000Z' }],
      identities: [],
    });
    expect(me.json.serverNow).toMatch(ISO);

    const patched = await call('PATCH', '/api/me', { displayName: ' Kai Lin ', avatar: 'gent', locale: 'zh-TW', birthYear: 1990 }, g.auth);
    expect(patched.json.user).toMatchObject({ displayName: 'Kai Lin', avatar: 'gent', locale: 'zh-TW', birthYear: 1990 });
    for (const bad of [{ displayName: 3 }, { birthYear: 1850 }, { birthYear: 'old' }, { locale: 'not a tag!' }]) {
      const res = await call('PATCH', '/api/me', bad, g.auth);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('invalid');
    }
    // The avatar can be cleared; the birth year, once given, stays (see birth-year.test.ts).
    expect(((await call('PATCH', '/api/me', { avatar: null }, g.auth)).json.user as { birthYear: unknown; avatar: unknown })).toMatchObject({ birthYear: 1990, avatar: null });

    // Deleting anonymises club rows, ends every session and the guest secret stops working.
    const club = clubs.createClub({ userId: 'owner-user-1', name: 'Owner' }, 'Club');
    await call('POST', `/api/clubs/${club.code}/join`, {}, g.auth);
    expect(clubs.club(club.code).members.find((m) => m.userId === g.userId)!.name).toBe('Kai Lin');
    await clubs.flush();
    const del = await call('DELETE', '/api/me', undefined, g.auth);
    expect(del.status).toBe(204);
    expect((await call('GET', '/api/me', undefined, g.auth)).status).toBe(401);
    expect((await call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret })).json.error).toBe('invalid_credentials');
    expect(clubs.club(club.code).members.find((m) => m.userId === g.userId)!.name).toBe('Deleted player');
    // Nothing personal is left on the row; the record is kept until the purge.
    expect(await repos.users.get(g.userId)).toMatchObject({ displayName: 'Deleted player', avatar: null, email: null, birthYear: null, locale: null });
    await clubs.flush();
    expect((await repos.clubs.get(club.code))!.members.find((m) => m.userId === g.userId)!.name).toBe('Deleted player');
  });

  it("deleting a club owner's account hands the club to its senior admin, and dissolves a club nobody else is in", async () => {
    const { call, guest, clubs, repos } = apiFixture();
    const owner = await guest('Owner');
    const admin = await guest('Ada');
    const member = await guest('Mem');
    const club = (await call('POST', '/api/clubs', { name: 'Handover', settings: { joinRequiresApproval: true } }, owner.auth)).json as unknown as Club;
    for (const who of [member, admin]) {
      await call('POST', `/api/clubs/${club.code}/join`, {}, who.auth);
      await call('POST', `/api/clubs/${club.code}/members/${who.userId}/approve`, {}, owner.auth);
    }
    await call('POST', `/api/clubs/${club.code}/members/${admin.userId}/role`, { role: 'admin' }, owner.auth);
    const solo = (await call('POST', '/api/clubs', { name: 'Just me' }, owner.auth)).json as unknown as Club;
    const newbie = await guest('Newbie');
    await call('POST', `/api/clubs/${club.code}/join`, {}, newbie.auth);
    expect((await call('DELETE', '/api/me', undefined, owner.auth)).status).toBe(204);
    const after = clubs.club(club.code);
    expect(after.ownerId).toBe(admin.userId);
    expect(after.members.map((m) => [m.userId, m.role])).toEqual(expect.arrayContaining([[admin.userId, 'owner'], [owner.userId, 'member'], [member.userId, 'member']]));
    // The new owner can run the club: the pending request can be approved.
    expect((await call('POST', `/api/clubs/${club.code}/members/${newbie.userId}/approve`, {}, admin.auth)).status).toBe(200);
    expect((await call('GET', `/api/clubs/${solo.code}`, undefined, admin.auth)).status).toBe(404);
    await clubs.flush();
    expect((await repos.clubs.get(club.code))!.ownerId).toBe(admin.userId);
    expect(await repos.clubs.get(solo.code)).toBeNull();
  });
});

describe('provider sign-in', () => {
  it('links a provider to a guest, then signs in with it on a new install', async () => {
    const { call, guest } = apiFixture({ deps: { providers } });
    const g = await guest('Lee');
    const nonce = 'raw-nonce-0123456789';
    const linked = await call('POST', '/api/auth/link', { provider: 'apple', token: await idToken('apple', 'apple-sub-1', nonce, { email: 'lee@example.com', email_verified: 'true' }), nonce }, g.auth);
    expect(linked.status).toBe(200);
    expect(linked.json.merged).toBe(false);
    expect((linked.json.user as { kind: string }).kind).toBe('account');
    expect((linked.json.session as { token: string }).token).toBe(g.token);
    expect(((await call('GET', '/api/me', undefined, g.auth)).json.identities)).toEqual([{ provider: 'apple', email: 'lee@example.com' }]);
    // The guest secret has been replaced: the response carries the new one for this device, the old one is dead.
    const rotated = linked.json.guestSecret as string;
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(g.guestSecret);
    expect((await call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret })).status).toBe(401);
    expect((await call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: rotated })).status).toBe(200);

    const n2 = 'second-nonce-0123456789';
    const signedIn = await call('POST', '/api/auth/login', { provider: 'apple', token: await idToken('apple', 'apple-sub-1', n2), nonce: n2, device: device() });
    expect(signedIn.status).toBe(200);
    expect((signedIn.json.user as { id: string }).id).toBe(g.userId);
    expect((signedIn.json.session as { token: string }).token).toMatch(/^mjs_/);

    // A token for an identity nobody linked: 404 not_linked, and the app offers to attach it.
    const n3 = 'third-nonce-0123456789';
    const unknown = await call('POST', '/api/auth/login', { provider: 'google', token: await idToken('google', 'google-sub-9', n3), nonce: n3, device: device() });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe('not_linked');
  });

  it('merges a guest into the account that already holds the identity, moving its clubs', async () => {
    const { call, guest, clubs } = apiFixture({ deps: { providers } });
    const owner = await guest('Account');
    const n1 = 'merge-nonce-one-0123';
    await call('POST', '/api/auth/link', { provider: 'google', token: await idToken('google', 'google-sub-2', n1), nonce: n1 }, owner.auth);
    const phone = await guest('New phone');
    const club = (await call('POST', '/api/clubs', { name: 'Guest club' }, phone.auth)).json as unknown as Club;
    const n2 = 'merge-nonce-two-0123';
    const merged = await call('POST', '/api/auth/link', { provider: 'google', token: await idToken('google', 'google-sub-2', n2), nonce: n2 }, phone.auth);
    expect(merged.status).toBe(200);
    expect(merged.json.merged).toBe(true);
    expect((merged.json.user as { id: string }).id).toBe(owner.userId);
    const fresh = (merged.json.session as { token: string }).token;
    expect(fresh).not.toBe(phone.token);
    // The guest's own session ended; the new one belongs to the account, which now owns the club.
    expect((await call('GET', '/api/me', undefined, phone.auth)).status).toBe(401);
    expect(((await call('GET', '/api/me', undefined, bearer(fresh))).json.user as { id: string }).id).toBe(owner.userId);
    expect(clubs.club(club.code).ownerId).toBe(owner.userId);
    expect(clubs.club(club.code).members.map((m) => m.userId)).toEqual([owner.userId]);
    expect(((await call('GET', `/api/clubs/${club.code}/standings`, undefined, bearer(fresh))).status)).toBe(200);

    // Rule 3: an account that already has a provider cannot take another account's identity.
    const other = await guest('Other');
    const n3 = 'merge-nonce-three-01';
    await call('POST', '/api/auth/link', { provider: 'apple', token: await idToken('apple', 'apple-sub-7', n3), nonce: n3 }, other.auth);
    const n4 = 'merge-nonce-four-012';
    const clash = await call('POST', '/api/auth/link', { provider: 'google', token: await idToken('google', 'google-sub-2', n4), nonce: n4 }, other.auth);
    expect(clash.status).toBe(409);
    expect(clash.json.error).toBe('identity_in_use');
  });

  it('unlinks a provider only while another remains', async () => {
    // More than five auth calls for one user here; the per-user limit has its own test.
    const { call, guest } = apiFixture({ deps: { providers }, api: { authUserLimiter: perMinute(100) } });
    const g = await guest('Two ways');
    const n1 = 'unlink-nonce-one-0123';
    const n2 = 'unlink-nonce-two-0123';
    await call('POST', '/api/auth/link', { provider: 'apple', token: await idToken('apple', 'apple-sub-3', n1), nonce: n1 }, g.auth);
    await call('POST', '/api/auth/link', { provider: 'google', token: await idToken('google', 'google-sub-3', n2), nonce: n2 }, g.auth);
    expect((await call('DELETE', '/api/auth/identities/facebook', undefined, g.auth)).json.error).toBe('not_found');
    expect((await call('DELETE', '/api/auth/identities/myspace', undefined, g.auth)).json.error).toBe('invalid');
    expect((await call('DELETE', '/api/auth/identities/google', undefined, g.auth)).status).toBe(204);
    const last = await call('DELETE', '/api/auth/identities/apple', undefined, g.auth);
    expect(last.status).toBe(409);
    expect(last.json.error).toBe('last_identity');
  });

  it('rejects bad tokens, unknown providers and providers this server has not configured', async () => {
    const { call, guest } = apiFixture({ deps: { providers }, api: { authUserLimiter: perMinute(100) } });
    const g = await guest('Picky');
    const nonce = 'reject-nonce-0123456';
    const cases: Array<[unknown, number, string]> = [
      [{ provider: 'apple', token: await idToken('apple', 'apple-sub-4', 'some-other-nonce'), nonce }, 401, 'invalid_token'],
      [{ provider: 'apple', token: 'x'.repeat(40), nonce }, 401, 'invalid_token'],
      [{ provider: 'myspace', token: 'x'.repeat(40), nonce }, 400, 'invalid'],
      [{ provider: 'facebook', token: 'x'.repeat(40), nonce }, 404, 'provider_disabled'],
      [{ provider: 'apple', token: 'x'.repeat(40), nonce: 42 }, 400, 'invalid'],
      // The nonce is not optional: a token that was never bound to one is refused, on link and on login.
      [{ provider: 'apple', token: await idToken('apple', 'apple-sub-4', nonce) }, 400, 'invalid'],
      [{ provider: 'apple', token: await idToken('apple', 'apple-sub-4', nonce), nonce: '' }, 400, 'invalid'],
    ];
    for (const [body, status, error] of cases) {
      const res = await call('POST', '/api/auth/link', body, g.auth);
      expect([res.status, res.json.error]).toEqual([status, error]);
    }
    const noNonce = await call('POST', '/api/auth/login', { provider: 'apple', token: await idToken('apple', 'apple-sub-4', nonce), device: device() });
    expect([noNonce.status, noNonce.json.error]).toEqual([400, 'invalid']);
    // Without any provider configured (no secrets set), every provider is disabled.
    const bare = apiFixture();
    const h = await bare.guest('Bare');
    expect((await bare.call('POST', '/api/auth/link', { provider: 'apple', token: 'x'.repeat(40), nonce }, h.auth)).json.error).toBe('provider_disabled');
  });
});

describe('configuration and rate limits', () => {
  it('reports the enabled providers and the feature flags', async () => {
    const withApple = apiFixture({ deps: { providers: { apple: providers.apple }, config: { minBuild: 7, maintenance: 'Back soon' } } });
    const res = await withApple.call('GET', '/api/config');
    expect(res.json).toEqual({ authProviders: ['apple'], storeEnabled: false, pushEnabled: false, minBuild: 7, maintenance: 'Back soon', serverNow: expect.stringMatching(ISO) });
    expect((await apiFixture().call('GET', '/api/config')).json).toMatchObject({ authProviders: [], minBuild: 0, maintenance: null });
  });

  it('allows five auth requests a minute per IP', async () => {
    let now = Date.UTC(2026, 10, 5);
    const { call } = apiFixture({ now: () => now });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/auth/guest', { device: device() }, {}, '203.0.113.5')).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    const limited = await call('POST', '/api/auth/guest', { device: device() }, {}, '203.0.113.5');
    expect(limited.json.error).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBe('12');
    // Other IPs, and routes outside /api/auth, are unaffected; a token comes back every 12 s.
    expect((await call('POST', '/api/auth/guest', { device: device() }, {}, '203.0.113.6')).status).toBe(201);
    expect((await call('GET', '/api/config', undefined, {}, '203.0.113.5')).status).toBe(200);
    now += 12_000;
    expect((await call('POST', '/api/auth/guest', { device: device() }, {}, '203.0.113.5')).status).toBe(201);
  });

  it('allows five auth requests a minute per user, from any IP', async () => {
    const { call, guest, repos } = apiFixture();
    const g = await guest('Busy');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // The bearer routes count against the same user.
    expect((await call('POST', '/api/auth/refresh', undefined, g.auth)).json.error).toBe('rate_limited');
    // The refused sign-in issued no session (the bootstrap's plus five): the limit is spent once the secret is proven, before one is made.
    expect(await repos.sessions.revokeAllForUser(g.userId, Date.now())).toBe(6);
  });

  it("a stranger's failed guest sign-ins with your id cannot lock you out of your own session", async () => {
    let now = Date.UTC(2026, 10, 5);
    const { call, guest } = apiFixture({ now: () => now, deps: { providers } });
    const victim = await guest('Victim');
    // Five bad guesses from one address: refused, and that address is done guessing this id for a while.
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/auth/guest/login', { userId: victim.userId, guestSecret: 'nope' }, {}, '203.0.113.9')).status).toBe(401);
    expect((await call('POST', '/api/auth/guest/login', { userId: victim.userId, guestSecret: 'nope' }, {}, '203.0.113.9')).status).toBe(429);
    // The victim, elsewhere, is unaffected on every authenticated auth route and on guest sign-in.
    expect((await call('POST', '/api/auth/refresh', undefined, victim.auth, '198.51.100.1')).status).toBe(200);
    expect((await call('POST', '/api/auth/guest/login', { userId: victim.userId, guestSecret: victim.guestSecret }, {}, '198.51.100.2')).status).toBe(200);
    const nonce = 'victim-nonce-0123456789';
    expect((await call('POST', '/api/auth/link', { provider: 'google', token: await idToken('google', 'google-sub-v', nonce), nonce }, victim.auth, '198.51.100.3')).status).toBe(200);
    // Kept up for two minutes, one guess every twelve seconds, it still changes nothing for the victim.
    for (let i = 0; i < 10; i++) {
      now += 12_000;
      await call('POST', '/api/auth/guest/login', { userId: victim.userId, guestSecret: 'nope' }, {}, '203.0.113.9');
      expect((await call('POST', '/api/auth/logout', undefined, victim.auth, '198.51.100.' + (10 + i))).status).not.toBe(429);
    }
  });
});

describe('sessions and sockets', () => {
  /** A peer connected to the registry as a verified socket, recording how it is closed. */
  function socket(fixture: ReturnType<typeof apiFixture>, userId: string, sessionId: string) {
    const closes: Array<[number | undefined, string | undefined]> = [];
    const id = fixture.rooms.hello(fixture.rooms.connect({ send: () => undefined, close: (code, reason) => closes.push([code, reason]) }), userId, sessionId);
    return { id, closes };
  }

  it('logging out, deleting the account and linking close the sockets those sessions opened with 4401', async () => {
    const f = apiFixture({ deps: { providers } });
    const g = await f.guest('Sock');
    const mine = socket(f, g.userId, (await f.sessions.verify(g.token)).sessionId);
    const other = (await f.call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret })).json.session as { token: string };
    const theirs = socket(f, g.userId, (await f.sessions.verify(other.token)).sessionId);
    // Logout ends this session's socket only.
    expect((await f.call('POST', '/api/auth/logout', undefined, bearer(other.token))).status).toBe(204);
    expect(theirs.closes).toEqual([[4401, 'Session ended']]);
    expect(mine.closes).toEqual([]);
    // Linking a provider ends every other session of the user, sockets included, but not the caller's.
    const third = (await f.call('POST', '/api/auth/guest/login', { userId: g.userId, guestSecret: g.guestSecret })).json.session as { token: string };
    const again = socket(f, g.userId, (await f.sessions.verify(third.token)).sessionId);
    const nonce = 'socket-nonce-0123456789';
    expect((await f.call('POST', '/api/auth/link', { provider: 'apple', token: await idToken('apple', 'apple-sub-s', nonce), nonce }, g.auth)).status).toBe(200);
    expect(again.closes).toEqual([[4401, 'Session ended']]);
    expect(mine.closes).toEqual([]);
    // Deleting the account ends all of them.
    expect((await f.call('DELETE', '/api/me', undefined, g.auth)).status).toBe(204);
    expect(mine.closes).toEqual([[4401, 'Session ended']]);
    expect(f.rooms.peerUser(mine.id)).toBe(g.userId); // the socket layer removes the peer when the close lands
  });

  it('merging a guest into an account ends the guest\'s sockets and moves its reports', async () => {
    const f = apiFixture({ deps: { providers } });
    const owner = await f.guest('Account');
    const n1 = 'merge-sock-nonce-0001';
    await f.call('POST', '/api/auth/link', { provider: 'google', token: await idToken('google', 'google-sub-m', n1), nonce: n1 }, owner.auth);
    const phone = await f.guest('Phone');
    const reporter = await f.guest('Reporter');
    expect((await f.call('POST', '/api/reports', { reportedUserId: phone.userId, reason: 'cheating' }, reporter.auth)).status).toBe(201);
    const s = socket(f, phone.userId, (await f.sessions.verify(phone.token)).sessionId);
    const n2 = 'merge-sock-nonce-0002';
    const merged = await f.call('POST', '/api/auth/link', { provider: 'google', token: await idToken('google', 'google-sub-m', n2), nonce: n2 }, phone.auth);
    expect(merged.json.merged).toBe(true);
    expect(s.closes).toEqual([[4401, 'Session ended']]);
    expect((await f.repos.reports.listAbout(owner.userId)).map((r) => r.reporterId)).toEqual([reporter.userId]);
    expect(await f.repos.reports.listAbout(phone.userId)).toEqual([]);
    // The merged-away guest row keeps nothing personal.
    expect(await f.repos.users.get(phone.userId)).toMatchObject({ displayName: '', locale: null, mergedInto: owner.userId });
  });
});
