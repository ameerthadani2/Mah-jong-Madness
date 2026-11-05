import { describe, expect, it } from 'vitest';
import { ApiError, type Authoriser, type FetchLike } from '../api/http';
import type { KeyValueStore } from '../telemetry/consent';
import { PushRegistrar, REREGISTER_AFTER_MS, pushStorageKey, type PermissionStatus, type PushPlatform } from './registration';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function setup(o: { status?: PermissionStatus; canAskAgain?: boolean; grant?: PermissionStatus; token?: string | null; session?: boolean; pushEnabled?: boolean | null; reply?: number } = {}) {
  const sent: Sent[] = [];
  const kvData: Record<string, string> = {};
  const kv: KeyValueStore = { getItem: async (k) => kvData[k] ?? null, setItem: async (k, v) => void (kvData[k] = v) };
  const perm = { status: o.status ?? 'undetermined', canAskAgain: o.canAskAgain ?? true };
  const counts = { requested: 0, tokens: 0 };
  const platform: PushPlatform = {
    getPermission: async () => ({ ...perm }),
    requestPermission: async () => {
      counts.requested++;
      perm.status = o.grant ?? 'granted';
      return perm.status;
    },
    getToken: async () => {
      counts.tokens++;
      return o.token === undefined ? 'ExponentPushToken[abc]' : o.token;
    },
  };
  let status = o.reply ?? 200;
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status < 400, status, text: async () => (status < 400 ? '{"ok":true}' : '{"error":"unavailable"}') };
  };
  const auth: Authoriser = { token: async () => 'mjs_session', onUnauthorised: () => undefined };
  let now = 1_000_000;
  const reg = () =>
    new PushRegistrar({
      platform,
      kv,
      base: 'https://game.example',
      auth,
      hasSession: () => o.session ?? true,
      pushEnabled: () => (o.pushEnabled === undefined ? true : o.pushEnabled),
      devicePlatform: 'ios',
      locale: () => 'zh-TW',
      fetch,
      now: () => now,
    });
  return { reg, sent, counts, kvData, perm, setReply: (s: number) => (status = s), advance: (ms: number) => (now += ms) };
}

describe('push registration', () => {
  it('never prompts at launch, even when permission is still undetermined', async () => {
    const s = setup({ status: 'undetermined' });
    expect(await s.reg().refreshOnStart()).toBe('not-granted');
    expect(s.counts.requested).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it('asks after a club is joined and registers the token with the bearer session', async () => {
    const s = setup();
    expect(await s.reg().requestAfterClub()).toBe('registered');
    expect(s.counts.requested).toBe(1);
    expect(s.sent).toEqual([
      { url: 'https://game.example/api/push/token', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mjs_session' }, body: { token: 'ExponentPushToken[abc]', platform: 'ios', locale: 'zh-TW' } },
    ]);
  });

  it('asks only once, and never after a refusal', async () => {
    const s = setup({ grant: 'denied' });
    const r = s.reg();
    expect(await r.requestAfterClub()).toBe('denied');
    expect(await r.requestAfterClub()).toBe('denied');
    expect(s.counts.requested).toBe(1);
    // A new launch remembers the prompt was shown.
    s.perm.status = 'undetermined';
    expect(await s.reg().requestAfterClub()).toBe('not-granted');
    expect(s.counts.requested).toBe(1);
    expect(s.sent).toEqual([]);
  });

  it('does nothing without a session or when the server has push switched off', async () => {
    const offline = setup({ session: false });
    expect(await offline.reg().requestAfterClub()).toBe('no-session');
    expect(await offline.reg().refreshOnStart()).toBe('no-session');
    const off = setup({ pushEnabled: false });
    expect(await off.reg().requestAfterClub()).toBe('disabled');
    const unknown = setup({ pushEnabled: null });
    expect(await unknown.reg().requestAfterClub()).toBe('disabled');
    expect([offline, off, unknown].every((s) => s.counts.requested === 0 && s.sent.length === 0)).toBe(true);
  });

  it('refreshes at launch when already granted, skipping an unchanged recent token', async () => {
    const s = setup({ status: 'granted' });
    expect(await s.reg().refreshOnStart()).toBe('registered');
    expect(await s.reg().refreshOnStart()).toBe('unchanged');
    expect(s.sent).toHaveLength(1);
    s.advance(REREGISTER_AFTER_MS + 1);
    expect(await s.reg().refreshOnStart()).toBe('registered');
    expect(s.sent).toHaveLength(2);
    expect(s.counts.requested).toBe(0);
  });

  it('re-sends a rotated token', async () => {
    const s = setup({ status: 'granted' });
    const r = s.reg();
    await r.refreshOnStart();
    expect(await r.tokenChanged()).toBe('registered');
    expect(s.sent).toHaveLength(2);
  });

  it('reports a failed registration and retries it next time', async () => {
    const s = setup({ status: 'granted', reply: 503 });
    expect(await s.reg().refreshOnStart()).toBe('failed');
    s.setReply(200);
    expect(await s.reg().refreshOnStart()).toBe('registered');
  });

  it('skips a build that cannot have a push token', async () => {
    const s = setup({ status: 'granted', token: null });
    expect(await s.reg().refreshOnStart()).toBe('no-token');
    expect(s.sent).toEqual([]);
  });

  it('retries once with a fresh session after a 401', async () => {
    const s = setup({ status: 'granted' });
    let calls = 0;
    const tokens = ['mjs_old', 'mjs_new'];
    const r = new PushRegistrar({
      platform: { getPermission: async () => ({ status: 'granted', canAskAgain: true }), requestPermission: async () => 'granted', getToken: async () => 'ExponentPushToken[x]' },
      kv: { getItem: async () => null, setItem: async () => undefined },
      base: 'https://game.example',
      auth: { token: async () => tokens[Math.min(calls, 1)], onUnauthorised: (e: ApiError) => void (calls += e.status === 401 ? 1 : 0) },
      hasSession: () => true,
      pushEnabled: () => true,
      devicePlatform: 'android',
      locale: () => 'en',
      fetch: async (_url, init) => {
        s.sent.push({ url: _url, method: init.method, headers: init.headers, body: undefined });
        const ok = init.headers.authorization === 'Bearer mjs_new';
        return { ok, status: ok ? 200 : 401, text: async () => (ok ? '{}' : '{"error":"session_expired"}') };
      },
    });
    expect(await r.refreshOnStart()).toBe('registered');
    expect(s.sent.map((x) => x.headers.authorization)).toEqual(['Bearer mjs_old', 'Bearer mjs_new']);
  });

  it('keeps one record per game server', () => {
    expect(pushStorageKey('https://game.example')).toBe('mjm.push.game.example');
    expect(pushStorageKey('http://localhost:8787')).toBe('mjm.push.localhost_8787');
  });
});
