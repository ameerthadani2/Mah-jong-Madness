import { describe, expect, it } from 'vitest';
import { BucketTable, clientIp, TokenBucket } from '../src/limits';
import { LIMITS, loadConfig } from '../src/config';

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
  });

  it('takes the first hop behind a trusted proxy', () => {
    expect(clientIp(req('1.2.3.4, 5.6.7.8'), true)).toBe('1.2.3.4');
    expect(clientIp(req(['9.9.9.9, 1.1.1.1', '2.2.2.2']), true)).toBe('9.9.9.9');
    expect(clientIp(req(undefined), true)).toBe('10.0.0.9');
    expect(clientIp(req(' , '), true)).toBe('10.0.0.9');
    expect(clientIp({ headers: {} }, true)).toBe('unknown');
  });
});

describe('loadConfig', () => {
  it('has safe defaults', () => {
    const c = loadConfig({}, '/srv');
    expect(c).toEqual({ port: 8787, hostTables: true, dataDir: '/srv/data', trustProxy: false, corsOrigins: [], maxHostedTables: 500, p2pRooms: false });
  });

  it('parses every variable and rejects nonsense numbers', () => {
    const c = loadConfig({ PORT: '9000', HOST_TABLES: '0', DATA_DIR: '/data', TRUST_PROXY: '1', CORS_ORIGINS: 'http://localhost:8081, https://play.example ', MAX_HOSTED_TABLES: '20', P2P_ROOMS: 'true' }, '/srv');
    expect(c).toEqual({ port: 9000, hostTables: false, dataDir: '/data', trustProxy: true, corsOrigins: ['http://localhost:8081', 'https://play.example'], maxHostedTables: 20, p2pRooms: true });
    const bad = loadConfig({ PORT: '99999', MAX_HOSTED_TABLES: '-3', TRUST_PROXY: '0', P2P_ROOMS: 'nope' }, '/srv');
    expect(bad.port).toBe(8787);
    expect(bad.maxHostedTables).toBe(500);
    expect(bad.trustProxy).toBe(false);
    expect(bad.p2pRooms).toBe(false);
  });
});
