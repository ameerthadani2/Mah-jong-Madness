import { describe, expect, it } from 'vitest';
import { BucketTable, clientIp, TokenBucket } from '../src/limits';
import { LIMITS, loadConfig, pepperFromEnv, providersFromEnv } from '../src/config';

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses until tokens refill', () => {
    let now = 0;
    const b = new TokenBucket(3, 1, () => now);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, true]);
    expect(b.take()).toBe(false);
    now += 999;
    expect(b.take()).toBe(false);
    now += 1;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it('refills fractionally and never above capacity', () => {
    let now = 0;
    const b = new TokenBucket(2, 0.5, () => now);
    b.take(2);
    now += 1000; // half a token
    expect(b.take()).toBe(false);
    now += 1000;
    expect(b.take()).toBe(true);
    now += 60_000;
    expect(b.available()).toBe(2);
    expect(b.isFull()).toBe(true);
  });

  it('spends nothing when a multi-token take is refused', () => {
    const b = new TokenBucket(5, 0, () => 0);
    expect(b.take(6)).toBe(false);
    expect(b.available()).toBe(5);
    expect(b.take(5)).toBe(true);
    expect(b.take()).toBe(false);
  });

  it('matches the per-socket message limit: 60 at once, then 30 per second', () => {
    let now = 0;
    const b = new TokenBucket(LIMITS.messageBurst, LIMITS.messagesPerSec, () => now);
    let sent = 0;
    while (b.take()) sent++;
    expect(sent).toBe(60);
    now += 1000;
    sent = 0;
    while (b.take()) sent++;
    expect(sent).toBe(30);
  });
});

describe('BucketTable', () => {
  it('keeps one bucket per key', () => {
    const t = new BucketTable<string>(2, 0, { now: () => 0 });
    expect(t.take('a')).toBe(true);
    expect(t.take('a')).toBe(true);
    expect(t.take('a')).toBe(false);
    expect(t.take('b')).toBe(true);
    expect(t.size).toBe(2);
  });

  it('evicts buckets that are idle and full, but keeps ones still draining', () => {
    let now = 0;
    const t = new BucketTable<string>(10, 1, { now: () => now, idleMs: 60_000 });
    t.take('quiet');
    for (let i = 0; i < 10; i++) t.take('busy');
    now = 5_000;
    t.take('busy'); // busy has been used recently
    now = 64_000;
    // quiet: idle 64 s and refilled → evicted. busy: idle 59 s → kept.
    expect(t.sweep()).toBe(1);
    expect(t.size).toBe(1);
    now = 200_000;
    expect(t.sweep()).toBe(1);
    expect(t.size).toBe(0);
  });

  it('never evicts a bucket that has not refilled, so eviction cannot reset a limit', () => {
    let now = 0;
    const t = new BucketTable<string>(10, 0.01, { now: () => now, idleMs: 1_000 });
    for (let i = 0; i < 10; i++) t.take('ip');
    now = 5_000;
    expect(t.sweep()).toBe(0);
    expect(t.take('ip')).toBe(false);
  });

  it('sweeps lazily as time passes, so the table cannot grow without bound', () => {
    let now = 0;
    const t = new BucketTable<number>(1, 1, { now: () => now, idleMs: 60_000 });
    for (let i = 0; i < 1000; i++) t.take(i);
    expect(t.size).toBe(1000);
    now = 120_000;
    t.take(-1);
    expect(t.size).toBe(1);
  });
});

describe('clientIp', () => {
  const req = (xff?: string | string[]) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.9' } });

  it('ignores x-forwarded-for unless the proxy is trusted', () => {
    expect(clientIp(req('1.2.3.4'), false)).toBe('10.0.0.9');
    expect(clientIp(req('1.2.3.4'), 0)).toBe('10.0.0.9');
  });

  it('takes the hop TRUST_PROXY places from the right, never the client-written left end', () => {
    // One proxy (TRUST_PROXY=1): the rightmost entry is the one the proxy appended.
    expect(clientIp(req('1.2.3.4, 5.6.7.8'), 1)).toBe('5.6.7.8');
    expect(clientIp(req('1.2.3.4, 5.6.7.8'), true)).toBe('5.6.7.8');
    // Two proxies (e.g. a CDN in front of a load balancer): the second from the right.
    expect(clientIp(req('6.6.6.6, 1.2.3.4, 5.6.7.8'), 2)).toBe('1.2.3.4');
    // Repeated headers are read as one list, in order.
    expect(clientIp(req(['9.9.9.9, 1.1.1.1', '2.2.2.2']), 1)).toBe('2.2.2.2');
    // Fewer entries than proxies: the leftmost one there is.
    expect(clientIp(req('5.6.7.8'), 3)).toBe('5.6.7.8');
    expect(clientIp(req(undefined), 1)).toBe('10.0.0.9');
    expect(clientIp(req(' , '), 1)).toBe('10.0.0.9');
    expect(clientIp({ headers: {} }, 1)).toBe('unknown');
  });

  it('gives a client that forges the first hop the same key every time (probe verify-signal/xff.ts)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(clientIp(req(`10.0.${i}.1, 203.0.113.7`), 1));
    expect([...seen]).toEqual(['203.0.113.7']);
    // ...so the per-IP HTTP bucket runs dry however the header is varied.
    const table = new BucketTable<string>(LIMITS.httpBurst, LIMITS.httpPerSec, { now: () => 0 });
    const allowed = Array.from({ length: 100 }, (_, i) => table.take(clientIp(req(`198.51.${i}.9, 203.0.113.7`), 1))).filter(Boolean).length;
    expect(allowed).toBe(LIMITS.httpBurst);
  });
});

describe('loadConfig', () => {
  it('has safe defaults', () => {
    const c = loadConfig({});
    expect(c).toEqual({ port: 8787, hostTables: true, dataDir: null, trustProxy: 0, corsOrigins: [], maxHostedTables: 500, p2pRooms: false, minBuild: 0, maintenance: null, revenueCatWebhookSecret: null });
  });

  it('parses every variable and rejects nonsense numbers', () => {
    const c = loadConfig({ PORT: '9000', HOST_TABLES: '0', DATA_DIR: '/data', TRUST_PROXY: '1', CORS_ORIGINS: 'http://localhost:8081, https://play.example ', MAX_HOSTED_TABLES: '20', P2P_ROOMS: 'true', MIN_BUILD: '42', MAINTENANCE_MESSAGE: ' Back at 10:00 ', REVENUECAT_WEBHOOK_SECRET: ' rc-secret ' });
    expect(c).toEqual({ port: 9000, hostTables: false, dataDir: '/data', trustProxy: 1, corsOrigins: ['http://localhost:8081', 'https://play.example'], maxHostedTables: 20, p2pRooms: true, minBuild: 42, maintenance: 'Back at 10:00', revenueCatWebhookSecret: 'rc-secret' });
    const bad = loadConfig({ PORT: '99999', MAX_HOSTED_TABLES: '-3', TRUST_PROXY: '0', P2P_ROOMS: 'nope', MIN_BUILD: 'soon' });
    expect(bad.minBuild).toBe(0);
    expect(bad.port).toBe(8787);
    expect(bad.maxHostedTables).toBe(500);
    expect(bad.trustProxy).toBe(0);
    expect(bad.p2pRooms).toBe(false);
  });

  it('reads TRUST_PROXY as a hop count (0 = off)', () => {
    const hops = (v: string) => loadConfig({ TRUST_PROXY: v }).trustProxy;
    expect(hops('2')).toBe(2);
    expect(hops(' 1 ')).toBe(1);
    expect(hops('0')).toBe(0);
    expect(hops('true')).toBe(1);
    expect(hops('off')).toBe(0);
    expect(hops('-1')).toBe(0);
    expect(hops('1.5')).toBe(0);
    expect(hops('lots')).toBe(0);
  });
});

describe('accounts configuration', () => {
  it('enables only the providers whose ids are set, splitting GOOGLE_CLIENT_IDS on commas', () => {
    expect(providersFromEnv({})).toEqual({});
    expect(providersFromEnv({ APPLE_CLIENT_ID: ' com.example.app ', GOOGLE_CLIENT_IDS: 'ios.apps, android.apps,, web.apps ', FACEBOOK_APP_ID: '' })).toEqual({
      apple: { clientIds: ['com.example.app'] },
      google: { clientIds: ['ios.apps', 'android.apps', 'web.apps'] },
    });
    expect(providersFromEnv({ FACEBOOK_APP_ID: '123' })).toEqual({ facebook: { appId: '123' } });
  });

  it('uses AUTH_PEPPER, or a random per-process pepper with a warning', () => {
    const warnings: string[] = [];
    expect(pepperFromEnv({ AUTH_PEPPER: 'p1', AUTH_PEPPER_PREVIOUS: 'p0' }, (w) => warnings.push(w))).toEqual({ pepper: 'p1', previousPepper: 'p0' });
    expect(warnings).toEqual([]);
    const a = pepperFromEnv({}, (w) => warnings.push(w));
    const b = pepperFromEnv({ AUTH_PEPPER: '  ' }, (w) => warnings.push(w));
    expect(a.pepper).toMatch(/^[0-9a-f]{64}$/);
    expect(b.pepper).not.toBe(a.pepper);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/AUTH_PEPPER is not set/);
  });
});
