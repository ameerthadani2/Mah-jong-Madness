import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../api/http';
import { clubsApi } from '../api/clubs';
import { ApiError, AuthClient, authStorageKey, REFRESH_AFTER_MS } from './client';
import { memoryStore } from './store';
import type { DeviceInfo, StoredAuth } from './types';

const BASE = 'https://game.example';
const KEY = authStorageKey(BASE);
const DEVICE: DeviceInfo = { id: 'dev-1', platform: 'ios', appBuild: '7', locale: 'en' };
const user = (id: string, kind: 'guest' | 'account' = 'guest') => ({ id, kind, displayName: 'Tester', avatar: 'lady', locale: 'en', birthYear: null, createdAt: '2026-01-01T00:00:00Z' });
const session = (token: string) => ({ token, expiresAt: '2026-12-31T00:00:00Z' });

interface Call {
  method: string;
  path: string;
  auth?: string;
  body?: Record<string, unknown>;
}
type Reply = { status: number; body?: unknown } | 'network';

/** A scripted game server: each route answers from a queue (the last answer repeats), every request is recorded. */
function fakeServer(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.slice(BASE.length);
    const key = `${init.method} ${path}`;
    calls.push({ method: init.method, path, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const queue = routes[key];
    if (!queue?.length) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not_found', message: `no route ${key}` }) };
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (reply === 'network') throw new TypeError('Network request failed');
    return { ok: reply.status < 400, status: reply.status, text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)) };
  };
  return { fetch, calls, routes };
}

const T0 = Date.parse('2026-06-01T00:00:00Z');

function setup(routes: Record<string, Reply[]>, stored?: StoredAuth, now = { t: T0 }) {
  const server = fakeServer(routes);
  const store = memoryStore(stored ? { [KEY]: JSON.stringify(stored) } : {});
  const client = new AuthClient({ base: BASE, store, fetch: server.fetch, device: () => DEVICE, now: () => now.t, profile: () => ({ displayName: 'Tester', avatar: 'lady' }) });
  const saved = async () => {
    const raw = await store.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  };
  return { ...server, store, client, saved, now };
}

const guestReply: Reply = { status: 201, body: { userId: 'u-guest', guestSecret: 'a'.repeat(64), session: session('mjs_guest1'), user: user('u-guest') } };
const storedGuest = (over: Partial<StoredAuth> = {}): StoredAuth => ({ v: 1, userId: 'u-guest', guestSecret: 'a'.repeat(64), kind: 'guest', session: { token: 'mjs_old', expiresAt: '2026-12-31T00:00:00Z', refreshedAt: T0 }, ...over });

describe('AuthClient: bootstrap and sessions', () => {
  it('does nothing until a session is needed, then bootstraps a guest and stores id, secret and session', async () => {
    const s = setup({ 'POST /api/auth/guest': [guestReply] });
    await s.client.load();
    expect(s.client.snapshot().status).toBe('offline');
    expect(s.calls).toHaveLength(0);
    expect(await s.client.ensureSession()).toBe('mjs_guest1');
    expect(s.calls).toEqual([{ method: 'POST', path: '/api/auth/guest', auth: undefined, body: { device: DEVICE, displayName: 'Tester', avatar: 'lady' } }]);
    const saved = await s.saved();
    expect(saved).toMatchObject({ userId: 'u-guest', guestSecret: 'a'.repeat(64), kind: 'guest', session: { token: 'mjs_guest1', refreshedAt: T0 } });
    expect(JSON.stringify(saved).length).toBeLessThan(2048);
    expect(s.client.snapshot()).toMatchObject({ status: 'guest', userId: 'u-guest' });
  });

  it('shares one bootstrap between concurrent callers', async () => {
    const s = setup({ 'POST /api/auth/guest': [guestReply] });
    const [a, b] = await Promise.all([s.client.ensureSession(), s.client.ensureSession()]);
    expect(a).toBe('mjs_guest1');
    expect(b).toBe('mjs_guest1');
    expect(s.calls).toHaveLength(1);
  });

  it('uses a fresh stored token without asking the server', async () => {
    const s = setup({}, storedGuest());
    s.now.t = T0 + REFRESH_AFTER_MS - 1000;
    expect(await s.client.ensureSession()).toBe('mjs_old');
    expect(s.calls).toHaveLength(0);
  });

  it('refreshes a token older than a day and stores the new one', async () => {
    const s = setup({ 'POST /api/auth/refresh': [{ status: 200, body: { session: session('mjs_new') } }] }, storedGuest());
    s.now.t = T0 + REFRESH_AFTER_MS + 1;
    expect(await s.client.ensureSession()).toBe('mjs_new');
    expect(s.calls[0]).toMatchObject({ method: 'POST', path: '/api/auth/refresh', auth: 'Bearer mjs_old' });
    expect((await s.saved())!.session).toEqual({ token: 'mjs_new', expiresAt: '2026-12-31T00:00:00Z', refreshedAt: s.now.t });
  });

  it('keeps using a still-valid token when the refresh cannot reach the server', async () => {
    const s = setup({ 'POST /api/auth/refresh': ['network'] }, storedGuest());
    s.now.t = T0 + REFRESH_AFTER_MS + 1;
    expect(await s.client.ensureSession()).toBe('mjs_old');
  });

  it('on session_expired refreshes first, then logs the guest back in when the refresh is refused', async () => {
    const s = setup(
      {
        'POST /api/auth/refresh': [{ status: 401, body: { error: 'session_expired' } }],
        'POST /api/auth/guest/login': [{ status: 200, body: { session: session('mjs_login'), user: user('u-guest') } }],
      },
      storedGuest(),
    );
    await s.client.invalidate('session_expired');
    expect((await s.saved())!.expired).toBe(true);
    expect(await s.client.ensureSession()).toBe('mjs_login');
    expect(s.calls.map((c) => c.path)).toEqual(['/api/auth/refresh', '/api/auth/guest/login']);
    expect(s.calls[1].body).toEqual({ userId: 'u-guest', guestSecret: 'a'.repeat(64), device: DEVICE });
  });

  it('logs the guest in when the token is gone, and starts a new guest when the old one no longer exists', async () => {
    const s = setup({ 'POST /api/auth/guest/login': [{ status: 401, body: { error: 'invalid_credentials' } }], 'POST /api/auth/guest': [guestReply] }, storedGuest({ userId: 'u-gone', session: null }));
    expect(await s.client.ensureSession()).toBe('mjs_guest1');
    expect(s.calls.map((c) => c.path)).toEqual(['/api/auth/guest/login', '/api/auth/guest']);
    expect((await s.saved())!.userId).toBe('u-guest');
  });

  it('surfaces a network failure without wiping the stored guest', async () => {
    const s = setup({ 'POST /api/auth/guest/login': ['network'] }, storedGuest({ session: null }));
    await expect(s.client.ensureSession()).rejects.toMatchObject({ code: 'auth_unreachable' });
    expect((await s.saved())!.guestSecret).toBe('a'.repeat(64));
  });
});

describe('AuthClient: authorised requests', () => {
  it('on a 401 drops the token, signs in again once and retries', async () => {
    const s = setup(
      {
        'GET /api/me': [{ status: 401, body: { error: 'session_revoked' } }, { status: 200, body: { user: user('u-guest'), wallet: { diamonds: 0, bonusDiamonds: 0 }, entitlements: [], identities: [], serverNow: '' } }],
        'POST /api/auth/guest/login': [{ status: 200, body: { session: session('mjs_login'), user: user('u-guest') } }],
      },
      storedGuest(),
    );
    const me = await s.client.getMe();
    expect(me.user.id).toBe('u-guest');
    expect(s.calls.map((c) => `${c.path} ${c.auth ?? ''}`)).toEqual(['/api/me Bearer mjs_old', '/api/auth/guest/login ', '/api/me Bearer mjs_login']);
  });

  it('retries only once', async () => {
    const s = setup({ 'GET /api/me': [{ status: 401, body: { error: 'invalid_session' } }], 'POST /api/auth/guest/login': [{ status: 200, body: { session: session('mjs_login'), user: user('u-guest') } }] }, storedGuest());
    await expect(s.client.getMe()).rejects.toBeInstanceOf(ApiError);
    expect(s.calls.filter((c) => c.path === '/api/me')).toHaveLength(2);
  });

  it('club calls send the bearer token and no user credentials, and recover from a 401', async () => {
    const s = setup(
      {
        'POST /api/clubs': [{ status: 401, body: { error: 'session_rotated' } }, { status: 201, body: { code: 'CLUB1', name: 'Tea' } }],
        'POST /api/auth/guest/login': [{ status: 200, body: { session: session('mjs_login'), user: user('u-guest') } }],
      },
      storedGuest(),
    );
    const club = await clubsApi.create({ base: BASE, auth: s.client, fetch: s.fetch }, 'Tea', {});
    expect(club.code).toBe('CLUB1');
    const posts = s.calls.filter((c) => c.path === '/api/clubs');
    expect(posts.map((c) => c.auth)).toEqual(['Bearer mjs_old', 'Bearer mjs_login']);
    expect(posts[1].body).toEqual({ name: 'Tea', rules: {} });
  });

  it('turns server errors into typed ApiErrors', async () => {
    const s = setup({ 'DELETE /api/auth/identities/apple': [{ status: 409, body: { error: 'last_identity', message: 'Link another sign-in method before removing this one' } }] }, storedGuest({ kind: 'account' }));
    await expect(s.client.unlink('apple')).rejects.toMatchObject({ name: 'ApiError', code: 'last_identity', status: 409 });
  });
});

describe('AuthClient: providers, sign-out and deletion', () => {
  it('a merged link replaces the stored session and account, and voids the guest secret', async () => {
    const s = setup({ 'POST /api/auth/link': [{ status: 200, body: { session: session('mjs_v'), user: user('u-v', 'account'), merged: true } }] }, storedGuest());
    const r = await s.client.link('apple', 'id-token', 'raw-nonce');
    expect(r.merged).toBe(true);
    expect(s.calls[0]).toEqual({ method: 'POST', path: '/api/auth/link', auth: 'Bearer mjs_old', body: { provider: 'apple', token: 'id-token', nonce: 'raw-nonce' } });
    expect(await s.saved()).toMatchObject({ userId: 'u-v', kind: 'account', guestSecret: null, session: { token: 'mjs_v' } });
    expect(s.client.snapshot()).toMatchObject({ status: 'account', userId: 'u-v' });
  });

  it('an unmerged link upgrades the guest in place and keeps its secret', async () => {
    const s = setup({ 'POST /api/auth/link': [{ status: 200, body: { session: session('mjs_up'), user: user('u-guest', 'account'), merged: false } }] }, storedGuest());
    await s.client.link('google', 'id-token', 'n');
    expect(await s.saved()).toMatchObject({ userId: 'u-guest', kind: 'account', guestSecret: 'a'.repeat(64), session: { token: 'mjs_up' } });
  });

  it('provider login replaces the session; not_linked is reported', async () => {
    const s = setup({ 'POST /api/auth/login': [{ status: 404, body: { error: 'not_linked' } }, { status: 200, body: { session: session('mjs_w'), user: user('u-w', 'account') } }] }, storedGuest());
    await expect(s.client.loginWithProvider('apple', 't', 'n')).rejects.toMatchObject({ code: 'not_linked' });
    await s.client.loginWithProvider('apple', 't', 'n');
    expect(s.calls[1]).toMatchObject({ auth: 'Bearer mjs_old', body: { provider: 'apple', token: 't', nonce: 'n', device: DEVICE } });
    expect(await s.saved()).toMatchObject({ userId: 'u-w', kind: 'account', guestSecret: null, session: { token: 'mjs_w' } });
  });

  it('sign-out revokes the session and forgets the account', async () => {
    const s = setup({ 'POST /api/auth/logout': [{ status: 204 }] }, storedGuest({ kind: 'account' }));
    await s.client.logout();
    expect(s.calls[0]).toMatchObject({ path: '/api/auth/logout', auth: 'Bearer mjs_old' });
    expect(await s.saved()).toBeNull();
    expect(s.client.snapshot().status).toBe('offline');
  });

  it('delete clears everything once the server confirms, and keeps it when the server cannot be reached', async () => {
    const s = setup({ 'DELETE /api/me': ['network'] }, storedGuest());
    await expect(s.client.deleteAccount()).rejects.toBeInstanceOf(ApiError);
    expect(await s.saved()).not.toBeNull();
    s.routes['DELETE /api/me'] = [{ status: 204 }];
    await s.client.deleteAccount();
    expect(await s.saved()).toBeNull();
    expect(s.client.snapshot()).toEqual({ status: 'offline', userId: null, displayName: null, hasSession: false });
  });

  it('PATCH /api/me sends only the changed fields', async () => {
    const s = setup({ 'PATCH /api/me': [{ status: 200, body: { user: { ...user('u-guest'), displayName: 'Mei' } } }] }, storedGuest());
    await s.client.updateMe({ displayName: 'Mei' });
    expect(s.calls[0]).toMatchObject({ method: 'PATCH', body: { displayName: 'Mei' } });
    expect(s.client.snapshot().displayName).toBe('Mei');
  });
});

describe('authStorageKey', () => {
  it('is a valid secure-store key per server', () => {
    expect(authStorageKey('https://game.example:8443')).toBe('mjm.auth.game.example_8443');
    expect(authStorageKey('http://localhost:8787')).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
