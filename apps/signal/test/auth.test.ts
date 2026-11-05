/**
 * Accounts and sessions over the memory repositories: provider id tokens signed by locally
 * generated keys (Apple-shaped ES256, Google-shaped RS256), sessions on a fake clock, guest
 * bootstrap, every merge rule and account deletion.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type CryptoKey, type JWK } from 'jose';
import { sha256Hex } from '@mjm/engine';
import {
  AuthError,
  createGuest,
  deleteAccount,
  enabledProviders,
  hashToken,
  link,
  login,
  loginGuest,
  mintSessionToken,
  SessionService,
  unlink,
  verifyProviderToken,
  type AuthErrorCode,
  type ProviderConfig,
} from '../src/auth';
import { createMemoryRepos, DELETED_PLAYER_NAME, type Repos } from '../src/repos';
import type { Club } from '../src/clubs';
import { DEFAULT_RULES } from '@mjm/engine';

const MINUTE = 60_000;
const DAY = 86_400_000;
const PEPPER = 'pepper-current-0123456789';

/** Expects `p` to reject with an AuthError carrying `code` (and its HTTP status). */
async function rejectsWith(p: Promise<unknown>, code: AuthErrorCode, status?: number) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AuthError);
  expect((e as AuthError).code).toBe(code);
  if (status !== undefined) expect((e as AuthError).status).toBe(status);
}

// ---------------------------------------------------------------------------------------------

describe('provider id tokens', () => {
  const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
  const nowSec = Math.floor(NOW / 1000);
  const APPLE_AUD = 'com.example.mahjong';
  const GOOGLE_AUDS = ['web-client.apps.googleusercontent.com', 'ios-client.apps.googleusercontent.com'];
  let apple: { privateKey: CryptoKey; jwk: JWK };
  let google: { privateKey: CryptoKey; jwk: JWK };
  let stranger: CryptoKey;
  let cfg: ProviderConfig;

  beforeAll(async () => {
    const a = await generateKeyPair('ES256', { extractable: true });
    apple = { privateKey: a.privateKey, jwk: { ...(await exportJWK(a.publicKey)), kid: 'apple-1', alg: 'ES256', use: 'sig' } };
    const g = await generateKeyPair('RS256', { extractable: true });
    google = { privateKey: g.privateKey, jwk: { ...(await exportJWK(g.publicKey)), kid: 'google-1', alg: 'RS256', use: 'sig' } };
    stranger = (await generateKeyPair('ES256')).privateKey;
    cfg = {
      apple: { clientIds: [APPLE_AUD], jwks: { keys: [apple.jwk] } },
      google: { clientIds: GOOGLE_AUDS, jwks: { keys: [google.jwk] } },
      now: () => NOW,
    };
  });

  interface Claims {
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    nonce?: string;
    email?: string;
    email_verified?: boolean | string;
  }

  function sign(key: CryptoKey, alg: 'ES256' | 'RS256', kid: string, claims: Claims) {
    const { iss, aud, sub, exp, ...rest } = claims;
    const jwt = new SignJWT(rest).setProtectedHeader({ alg, kid }).setIssuedAt(nowSec - 10).setExpirationTime(exp ?? nowSec + 600);
    if (iss) jwt.setIssuer(iss);
    if (aud) jwt.setAudience(aud);
    if (sub) jwt.setSubject(sub);
    return jwt.sign(key);
  }
  const appleToken = (c: Claims = {}, key = apple.privateKey) =>
    sign(key, 'ES256', 'apple-1', { iss: 'https://appleid.apple.com', aud: APPLE_AUD, sub: '001234.apple-user', nonce: sha256Hex('raw-nonce'), ...c });
  const googleToken = (c: Claims = {}) =>
    sign(google.privateKey, 'RS256', 'google-1', { iss: 'https://accounts.google.com', aud: GOOGLE_AUDS[1], sub: '1098765', nonce: 'raw-nonce', ...c });

  it('accepts a valid Apple token (nonce is sha256 of the raw nonce) and returns a verified email', async () => {
    const token = await appleToken({ email: 'x@privaterelay.appleid.com', email_verified: 'true' });
    expect(await verifyProviderToken('apple', token, { ...cfg, nonce: 'raw-nonce' })).toEqual({ provider: 'apple', subject: '001234.apple-user', email: 'x@privaterelay.appleid.com' });
  });

  it('accepts a valid Google token from either issuer spelling and any configured client id', async () => {
    const token = await googleToken({ iss: 'accounts.google.com', aud: GOOGLE_AUDS[0], email: 'mei@example.com', email_verified: true });
    expect(await verifyProviderToken('google', token, { ...cfg, nonce: 'raw-nonce' })).toEqual({ provider: 'google', subject: '1098765', email: 'mei@example.com' });
    expect(await verifyProviderToken('google', await googleToken(), { ...cfg, nonce: 'raw-nonce' })).toEqual({ provider: 'google', subject: '1098765' });
  });

  it('drops an email the provider has not verified', async () => {
    const token = await googleToken({ email: 'unverified@example.com', email_verified: false });
    expect((await verifyProviderToken('google', token, { ...cfg, nonce: 'raw-nonce' })).email).toBeUndefined();
  });

  it('rejects the wrong audience', async () => {
    await rejectsWith(verifyProviderToken('apple', await appleToken({ aud: 'com.someone.else' }), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token', 401);
    await rejectsWith(verifyProviderToken('google', await googleToken({ aud: 'other-client' }), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
  });

  it('rejects the wrong issuer', async () => {
    await rejectsWith(verifyProviderToken('apple', await appleToken({ iss: 'https://evil.example.com' }), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
    await rejectsWith(verifyProviderToken('google', await googleToken({ iss: 'https://appleid.apple.com' }), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
  });

  it('rejects an expired token (beyond the 30 s clock tolerance)', async () => {
    await rejectsWith(verifyProviderToken('apple', await appleToken({ exp: nowSec - 3600 }), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
    // Within tolerance it still passes.
    await expect(verifyProviderToken('apple', await appleToken({ exp: nowSec - 10 }), { ...cfg, nonce: 'raw-nonce' })).resolves.toMatchObject({ provider: 'apple' });
  });

  it('rejects a bad nonce, an unhashed Apple nonce, and a nonce the request did not supply', async () => {
    await rejectsWith(verifyProviderToken('apple', await appleToken(), { ...cfg, nonce: 'another-nonce' }), 'invalid_token');
    await rejectsWith(verifyProviderToken('apple', await appleToken({ nonce: 'raw-nonce' }), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
    await rejectsWith(verifyProviderToken('google', await googleToken({ nonce: 'x' }), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
    await rejectsWith(verifyProviderToken('google', await googleToken(), cfg), 'invalid_token');
  });

  it('rejects a token signed by the wrong key, an unsigned token, and a token for the wrong provider', async () => {
    await rejectsWith(verifyProviderToken('apple', await appleToken({}, stranger), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
    const unsigned = new UnsecuredJWT({ nonce: sha256Hex('raw-nonce') }).setIssuer('https://appleid.apple.com').setAudience(APPLE_AUD).setSubject('x').setIssuedAt().setExpirationTime('5m').encode();
    await rejectsWith(verifyProviderToken('apple', unsigned, { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
    await rejectsWith(verifyProviderToken('google', await appleToken(), { ...cfg, nonce: 'raw-nonce' }), 'invalid_token');
  });

  it('refuses providers that are unknown or not configured', async () => {
    await rejectsWith(verifyProviderToken('myspace', await googleToken(), cfg), 'invalid', 400);
    await rejectsWith(verifyProviderToken('facebook', await googleToken(), cfg), 'provider_disabled', 400);
    await rejectsWith(verifyProviderToken('google', 123, cfg), 'invalid');
    expect(enabledProviders(cfg)).toEqual(['apple', 'google']);
    expect(enabledProviders({ google: { clientIds: [' '] }, facebook: { appId: '42' } })).toEqual(['facebook']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('sessions', () => {
  let repos: Repos;
  let t: number;
  const now = () => t;
  let sessions: SessionService;
  let userId: string;

  beforeEach(async () => {
    repos = createMemoryRepos();
    t = Date.UTC(2026, 0, 1);
    sessions = new SessionService(repos, { pepper: PEPPER, now });
    userId = (await createGuest(repos, PEPPER, { platform: 'ios' }, { now, sessions })).userId;
  });

  it('mints opaque tokens and stores only the peppered hash', async () => {
    expect(mintSessionToken()).toMatch(/^mjs_[0-9a-f]{64}$/);
    expect(hashToken('mjs_abc', 'p')).toBe(sha256Hex('p:mjs_abc'));
    const { token, session } = await sessions.create(userId, null);
    expect(session.tokenHash).toBe(hashToken(token, PEPPER));
    expect(JSON.stringify(await repos.sessions.get(session.id))).not.toContain(token.slice(4));
    expect(await sessions.verify(token)).toMatchObject({ userId, sessionId: session.id, inGrace: false, expiresAt: t + 30 * DAY });
  });

  it('slides the 30-day expiry while used, and expires when idle', async () => {
    const { token } = await sessions.create(userId);
    t += 20 * DAY;
    expect((await sessions.verify(token)).expiresAt).toBe(t + 30 * DAY);
    t += 29 * DAY;
    await expect(sessions.verify(token)).resolves.toMatchObject({ userId });
    t += 31 * DAY;
    await rejectsWith(sessions.verify(token), 'session_expired', 401);
  });

  it('rotates: the new token works, the old one has a 5-minute grace and cannot be rotated again', async () => {
    const first = await sessions.create(userId, null);
    const second = await sessions.rotate(first.token);
    expect(second.token).not.toBe(first.token);
    expect(second.session.rotatedFrom).toBe(first.session.id);
    expect(await sessions.verify(second.token)).toMatchObject({ userId, inGrace: false });
    t += 4 * MINUTE;
    expect(await sessions.verify(first.token)).toMatchObject({ userId, inGrace: true });
    await rejectsWith(sessions.rotate(first.token), 'session_rotated', 401);
    t += 2 * MINUTE;
    await rejectsWith(sessions.verify(first.token), 'session_revoked');
    await expect(sessions.verify(second.token)).resolves.toMatchObject({ userId });
  });

  it('revokes every session but the caller’s, and refuses unknown or malformed tokens', async () => {
    const a = await sessions.create(userId);
    const b = await sessions.create(userId);
    expect(await sessions.revokeAll(userId, a.session.id)).toBeGreaterThanOrEqual(1);
    await expect(sessions.verify(a.token)).resolves.toMatchObject({ userId });
    await rejectsWith(sessions.verify(b.token), 'session_revoked');
    await sessions.revoke(a.session.id);
    await rejectsWith(sessions.verify(a.token), 'session_revoked');
    await rejectsWith(sessions.verify(mintSessionToken()), 'invalid_session');
    await rejectsWith(sessions.verify('Bearer nonsense'), 'invalid_session');
    await rejectsWith(sessions.verify(undefined), 'invalid_session');
  });

  it('accepts the previous pepper during a rotation and upgrades the stored hash', async () => {
    const { token, session } = await sessions.create(userId);
    const rotated = new SessionService(repos, { pepper: 'pepper-next-9876543210', previousPepper: PEPPER, now });
    await expect(rotated.verify(token)).resolves.toMatchObject({ userId });
    expect((await repos.sessions.get(session.id))?.tokenHash).toBe(hashToken(token, 'pepper-next-9876543210'));
    // Once upgraded, the previous pepper is no longer needed; an unrelated pepper still fails.
    await expect(new SessionService(repos, { pepper: 'pepper-next-9876543210', now }).verify(token)).resolves.toMatchObject({ userId });
    await rejectsWith(new SessionService(repos, { pepper: 'pepper-other', now }).verify(token), 'invalid_session');
  });

  it('stops working once the account is deleted', async () => {
    const { token } = await sessions.create(userId);
    await repos.users.update(userId, { deletedAt: t });
    await rejectsWith(sessions.verify(token), 'session_revoked');
  });
});

// ---------------------------------------------------------------------------------------------

describe('guest accounts', () => {
  it('creates a guest with a device, secret and session; the secret logs in again', async () => {
    const repos = createMemoryRepos();
    const sessions = new SessionService(repos, { pepper: PEPPER });
    const g = await createGuest(repos, PEPPER, { platform: 'android', appBuild: '107', locale: 'zh-TW', pushToken: 42 }, { sessions });
    expect(g.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(g.guestSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(await sessions.verify(g.token)).toMatchObject({ userId: g.userId, deviceId: g.deviceId });
    expect(await repos.users.get(g.userId)).toMatchObject({ kind: 'guest', locale: 'zh-TW' });
    expect(await repos.devices.get(g.deviceId)).toMatchObject({ platform: 'android', appBuild: '107', pushToken: null });
    const identity = await repos.identities.get('guest', g.userId);
    expect(identity?.secretHash).toBe(hashToken(g.guestSecret, PEPPER));
    expect(identity?.secretHash).not.toContain(g.guestSecret);

    const again = await loginGuest(repos, PEPPER, g.userId, g.guestSecret, { sessions, deviceId: g.deviceId });
    expect(again.token).not.toBe(g.token);
    expect(await sessions.verify(again.token)).toMatchObject({ userId: g.userId, deviceId: g.deviceId });
  });

  it('refuses a wrong secret, an unknown user and junk with the same error', async () => {
    const repos = createMemoryRepos();
    const g = await createGuest(repos, PEPPER);
    await rejectsWith(loginGuest(repos, PEPPER, g.userId, g.guestSecret.replace(/.$/, (c) => (c === '0' ? '1' : '0'))), 'invalid_credentials', 401);
    await rejectsWith(loginGuest(repos, PEPPER, crypto.randomUUID(), g.guestSecret), 'invalid_credentials');
    await rejectsWith(loginGuest(repos, PEPPER, { id: g.userId }, g.guestSecret), 'invalid_credentials');
    await rejectsWith(loginGuest(repos, PEPPER, g.userId, ''), 'invalid_credentials');
  });

  it('accepts a guest secret hashed with the previous pepper and upgrades it', async () => {
    const repos = createMemoryRepos();
    const g = await createGuest(repos, PEPPER);
    const peppers = { current: 'pepper-next-9876543210', previous: PEPPER };
    await expect(loginGuest(repos, peppers, g.userId, g.guestSecret)).resolves.toMatchObject({ userId: g.userId });
    expect((await repos.identities.get('guest', g.userId))?.secretHash).toBe(hashToken(g.guestSecret, 'pepper-next-9876543210'));
  });
});

// ---------------------------------------------------------------------------------------------

describe('link, login, merge, unlink and deletion', () => {
  let repos: Repos;
  let sessions: SessionService;
  let t: number;
  const now = () => t;
  const apple = (subject: string) => ({ provider: 'apple' as const, subject, email: subject + '@privaterelay.appleid.com' });
  const google = (subject: string) => ({ provider: 'google' as const, subject });

  beforeEach(() => {
    repos = createMemoryRepos();
    t = Date.UTC(2026, 3, 1);
    sessions = new SessionService(repos, { pepper: PEPPER, now });
  });

  const guest = () => createGuest(repos, PEPPER, { platform: 'ios' }, { sessions, now });
  const opts = (g: { sessionId: string; deviceId?: string }) => ({ sessions, now, currentSessionId: g.sessionId, deviceId: g.deviceId ?? null });

  function club(ownerId: string, ownerName: string, extra: Partial<Club> = {}): Club {
    const m = (userId: string, name: string, role: 'owner' | 'admin' | 'member', points = 0) => ({ userId, name, role, joinedAt: t, points, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });
    return {
      code: 'C' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      name: 'Club',
      description: '',
      ownerId,
      createdAt: t,
      rules: DEFAULT_RULES,
      settings: { membersCanOpenTables: true, joinRequiresApproval: false },
      members: [m(ownerId, ownerName, 'owner')],
      pending: [],
      tables: [],
      ...extra,
      ...(extra.members ? { members: [m(ownerId, ownerName, 'owner'), ...extra.members] } : {}),
    };
  }

  it('rule 1: an unlinked identity is linked to the guest, which becomes an account; other sessions end', async () => {
    const g = await guest();
    const other = await loginGuest(repos, PEPPER, g.userId, g.guestSecret, { sessions });
    const result = await link(repos, g.userId, apple('a-1'), opts(g));
    expect(result).toEqual({ userId: g.userId, merged: false, affectedClubs: [] });
    expect(await repos.users.get(g.userId)).toMatchObject({ kind: 'account', email: 'a-1@privaterelay.appleid.com' });
    expect(await repos.identities.get('apple', 'a-1')).toMatchObject({ userId: g.userId, secretHash: null });
    await expect(sessions.verify(g.token)).resolves.toMatchObject({ userId: g.userId });
    await rejectsWith(sessions.verify(other.token), 'session_revoked');
    // Linking the same identity again changes nothing.
    expect(await link(repos, g.userId, apple('a-1'), opts(g))).toMatchObject({ userId: g.userId, merged: false });
    // And signing in with it now finds the account.
    const signedIn = await login(repos, apple('a-1'), { sessions, now, deviceId: g.deviceId });
    expect(await sessions.verify(signedIn.token)).toMatchObject({ userId: g.userId, deviceId: g.deviceId });
  });

  it('rule 2: a guest signing in with an identity that belongs to V is merged into V', async () => {
    const v = await guest();
    await repos.users.update(v.userId, { displayName: 'Vera', avatar: 'crane' });
    await link(repos, v.userId, google('g-1'), opts(v));
    const u = await guest();

    await repos.wallet.apply({ userId: u.userId, delta: 50, bonus: 10, reason: 'purchase', ref: 'u-tx', createdAt: t });
    await repos.wallet.apply({ userId: v.userId, delta: 7, reason: 'gift', createdAt: t });
    await repos.wallet.recordPurchase({ userId: u.userId, store: 'app_store', transactionId: 'u-tx', productId: 'diamonds_50', price: 0.99, currency: 'USD', eventId: null, raw: {}, createdAt: t });
    await repos.wallet.setEntitlement({ userId: u.userId, entitlement: 'coach_gold', expiresAt: t + 30 * DAY, source: 'store', updatedAt: t });
    await repos.puzzleResults.record({ userId: u.userId, kind: 'daily', puzzleKey: '2026-04-01', correct: true, seconds: 30, ratingAfter: 1210, createdAt: t });
    const uClub = club(u.userId, 'Guest U');
    const shared = club('owner-x', 'Xu', { members: [{ userId: u.userId, name: 'Guest U', role: 'member', joinedAt: t, points: 100, matchesPlayed: 1, matchesWon: 1, handsWon: 3 }, { userId: v.userId, name: 'Vera', role: 'admin', joinedAt: t, points: 900, matchesPlayed: 9, matchesWon: 5, handsWon: 20 }] });
    await repos.clubs.save(uClub);
    await repos.clubs.save(shared);

    const result = await link(repos, u.userId, google('g-1'), opts(u));
    expect(result).toMatchObject({ userId: v.userId, merged: true, mergedFrom: u.userId });
    expect([...result.affectedClubs].sort()).toEqual([uClub.code, shared.code].sort());
    // The device now holds a V session; U's sessions and guest login are gone.
    expect(await sessions.verify(result.token)).toMatchObject({ userId: v.userId, deviceId: u.deviceId });
    await rejectsWith(sessions.verify(u.token), 'session_revoked');
    await rejectsWith(loginGuest(repos, PEPPER, u.userId, u.guestSecret, { sessions }), 'invalid_credentials');
    expect(await repos.users.get(u.userId)).toMatchObject({ deletedAt: t, mergedInto: v.userId });
    // Wallet summed, purchases, entitlements and progress moved.
    expect(await repos.wallet.get(v.userId)).toMatchObject({ diamonds: 57, bonusDiamonds: 10 });
    expect((await repos.wallet.listPurchases(v.userId)).map((p) => p.transactionId)).toEqual(['u-tx']);
    expect((await repos.wallet.getEntitlements(v.userId)).map((e) => e.entitlement)).toEqual(['coach_gold']);
    expect(await repos.puzzleResults.listForUser(v.userId)).toHaveLength(1);
    expect((await repos.devices.get(u.deviceId))?.userId).toBe(v.userId);
    // Clubs: U's own club transfers to V; in the shared club V's row stays.
    const moved = (await repos.clubs.get(uClub.code))!;
    expect(moved.ownerId).toBe(v.userId);
    expect(moved.members).toEqual([expect.objectContaining({ userId: v.userId, name: 'Vera', avatar: 'crane', role: 'owner' })]);
    const kept = (await repos.clubs.get(shared.code))!;
    expect(kept.members.filter((m) => m.userId === v.userId || m.userId === u.userId)).toEqual([expect.objectContaining({ userId: v.userId, points: 900, role: 'admin' })]);
  });

  it('rule 3: an account that already has a provider cannot take an identity that belongs to someone else', async () => {
    const v = await guest();
    await link(repos, v.userId, google('g-1'), opts(v));
    const u = await guest();
    await link(repos, u.userId, apple('a-2'), opts(u));
    await rejectsWith(link(repos, u.userId, google('g-1'), opts(u)), 'identity_in_use', 409);
    // Nothing moved.
    expect((await repos.users.get(u.userId))?.deletedAt).toBeNull();
    expect((await repos.identities.get('google', 'g-1'))?.userId).toBe(v.userId);
  });

  it('rule 4: signing in with an unlinked identity is not_linked; unlinking keeps at least one provider', async () => {
    await rejectsWith(login(repos, apple('nobody'), { sessions, now }), 'not_linked', 404);
    const g = await guest();
    await link(repos, g.userId, apple('a-3'), opts(g));
    await rejectsWith(unlink(repos, g.userId, 'apple'), 'last_identity', 409);
    await rejectsWith(unlink(repos, g.userId, 'google'), 'not_found', 404);
    await link(repos, g.userId, google('g-3'), opts(g));
    await unlink(repos, g.userId, 'apple');
    expect((await repos.identities.listForUser(g.userId)).map((i) => i.provider).sort()).toEqual(['google', 'guest']);
    await rejectsWith(login(repos, apple('a-3'), { sessions, now }), 'not_linked');
  });

  it('deletion scrubs the profile, ends sign-in, anonymises club rows and keeps financial records', async () => {
    const g = await guest();
    await repos.users.update(g.userId, { displayName: 'Mei', avatar: 'panda', email: 'mei@example.com', birthYear: 1990 });
    await link(repos, g.userId, apple('a-4'), opts(g));
    await repos.wallet.apply({ userId: g.userId, delta: 20, reason: 'purchase', ref: 'del-tx', createdAt: t });
    await repos.wallet.recordPurchase({ userId: g.userId, store: 'play', transactionId: 'del-tx', productId: 'diamonds_20', price: null, currency: null, eventId: 'e-1', raw: {}, createdAt: t });
    const c = club('owner-x', 'Xu', { members: [{ userId: g.userId, name: 'Mei', avatar: 'panda', role: 'member', joinedAt: t, points: 40, matchesPlayed: 1, matchesWon: 0, handsWon: 1 }] });
    await repos.clubs.save(c);

    t += MINUTE;
    const { affectedClubs } = await deleteAccount(repos, g.userId, { now });
    expect(affectedClubs).toEqual([c.code]);
    expect(await repos.users.get(g.userId)).toMatchObject({ deletedAt: t, displayName: DELETED_PLAYER_NAME, avatar: null, email: null, birthYear: null });
    expect(await repos.identities.listForUser(g.userId)).toEqual([]);
    expect(await repos.devices.listForUser(g.userId)).toEqual([]);
    expect(await repos.sessions.findByHash(hashToken(g.token, PEPPER))).toBeNull();
    await rejectsWith(sessions.verify(g.token), 'invalid_session');
    await rejectsWith(loginGuest(repos, PEPPER, g.userId, g.guestSecret), 'invalid_credentials');
    await rejectsWith(login(repos, apple('a-4'), { sessions, now }), 'not_linked');
    const row = (await repos.clubs.get(c.code))!.members.find((m) => m.userId === g.userId)!;
    expect(row).toMatchObject({ name: DELETED_PLAYER_NAME, points: 40 });
    expect(row.avatar).toBeUndefined();
    expect(await repos.wallet.listPurchases(g.userId)).toHaveLength(1);
    expect(await repos.wallet.listLedger(g.userId)).toHaveLength(1);
    await rejectsWith(link(repos, g.userId, google('g-9'), { sessions, now }), 'not_found');
    await rejectsWith(deleteAccount(repos, crypto.randomUUID()), 'not_found');
  });
});
