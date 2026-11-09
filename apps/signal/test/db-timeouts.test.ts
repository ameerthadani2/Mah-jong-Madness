/**
 * A database that hangs (frozen compute, network black hole) no longer hangs the server: queries
 * time out, `/health` answers 503 within two seconds, and `close()` finishes within its deadline
 * (probe dbhang: with Postgres stopped, /health never answered and SIGTERM took over 40 s).
 * The Postgres cases put a TCP proxy between the pool and the database that can stop forwarding
 * mid-connection, which is what a hung database looks like from the server.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket as TcpSocket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { WebSocket } from 'ws';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createPool, DB_QUERY_TIMEOUT_MS, ping, poolConfig, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createRepos, type RepoHandle } from '../src/repos';
import { RoomRegistry } from '../src/rooms';
import { createSignalServer } from '../src/server';
import { createSocketServer, TRY_AGAIN_LATER, UNAUTHORISED, VerifyUnavailable } from '../src/sockets';
import { apiFixture } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();

describe('pool settings', () => {
  it('times every query out after 5 s, and has the server cancel statements on a direct connection only', () => {
    const direct = poolConfig('postgres://u@localhost:5432/db');
    expect(direct.query_timeout).toBe(DB_QUERY_TIMEOUT_MS);
    expect(DB_QUERY_TIMEOUT_MS).toBe(5_000);
    expect(direct.statement_timeout).toBe(5_000);
    const neonPooled = poolConfig('postgres://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/db?sslmode=require');
    expect(neonPooled.query_timeout).toBe(5_000);
    expect(neonPooled.statement_timeout).toBeUndefined();
    expect(poolConfig('postgres://u@db.internal:6432/db').statement_timeout).toBeUndefined();
    expect(poolConfig('postgres://u@ep-cool-name-123456.eu-central-1.aws.neon.tech/db').statement_timeout).toBe(5_000);
    // Migrations wait on a lock and may run long statements: no timeouts.
    const migrations = poolConfig('postgres://u@localhost/db', { queryTimeoutMs: 0, statementTimeoutMs: 0 });
    expect(migrations.query_timeout).toBeUndefined();
    expect(migrations.statement_timeout).toBeUndefined();
  });

  it('answers a ping within its timeout when the database never does', async () => {
    const hung = { query: () => new Promise<never>(() => undefined) };
    const t0 = Date.now();
    expect(await ping(hung as never, 100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('/health when the database is down or slow, and while draining', () => {
  it('answers 503 db down when the check fails, says no, or is slower than the limit', async () => {
    for (const healthy of [() => Promise.resolve(false), () => Promise.reject(new Error('refused')), () => new Promise<boolean>(() => undefined)]) {
      const { call } = apiFixture({ deps: { healthy, healthTimeoutMs: 50 } });
      const t0 = Date.now();
      const res = await call('GET', '/health');
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ ok: false, db: 'down' });
    }
    const ok = await apiFixture({ deps: { healthy: () => Promise.resolve(true) } }).call('GET', '/health');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, db: 'ok' });
  });

  it('answers 503 draining once shutdown has begun', async () => {
    const res = await apiFixture({ deps: { draining: () => true, healthy: () => Promise.resolve(true) } }).call('GET', '/health');
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ ok: false, draining: true });
  });
});

describe('shutdown', () => {
  it('refuses socket upgrades while the server is not accepting', async () => {
    const http = createHttpServer();
    let accepting = true;
    createSocketServer(http, new RoomRegistry(), { trustProxy: 0 }, undefined, {}, () => accepting);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const open = (): Promise<string> =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.on('open', () => (ws.close(), resolve('open')));
        ws.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
        ws.on('error', () => resolve('error'));
      });
    expect(await open()).toBe('open');
    accepting = false;
    expect(await open()).toBe('refused 503');
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  });

  it('finishes within its deadline even when the final table writes never complete', async () => {
    const repos = createRepos();
    // Every snapshot write hangs, as it would against a frozen database.
    repos.repos.tableSnapshots.save = () => new Promise<void>(() => undefined);
    const server = await createSignalServer({
      port: 0,
      host: '127.0.0.1',
      repos,
      sessions: new SessionService(repos.repos, { pepper: 'p'.repeat(32) }),
      providers: {},
      config: loadConfig({}),
      log: () => undefined,
      closeDeadlineMs: 300,
    });
    server.rooms.createHostedRoom();
    const base = `http://127.0.0.1:${server.address().port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
    try {
      const t0 = Date.now();
      await server.close();
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      console.error = original;
    }
    expect(errors.some((e) => e.includes('shutdown deadline'))).toBe(true);
    // No new connections once closed.
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });
});

describe('a session check the database could not answer', () => {
  it('closes the socket with 1013 (try again later), not 4401 (sign in again)', async () => {
    const codes: number[] = [];
    for (const failure of [new VerifyUnavailable('Query read timeout'), new Error('bad token')]) {
      const http = createHttpServer();
      createSocketServer(http, new RoomRegistry(), { trustProxy: 0 }, undefined, { verify: () => Promise.reject(failure) });
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
      const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', auth: 'token' })));
      codes.push(await new Promise<number>((r) => ws.on('close', (code) => r(code))));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    }
    expect(codes).toEqual([TRY_AGAIN_LATER, UNAUTHORISED]);
  });
});

/** A TCP proxy to Postgres that can turn into a black hole: connections stay open, nothing comes back. */
async function blackHoleProxy(target: URL): Promise<{ port: number; hang(): void; close(): Promise<void> }> {
  let hung = false;
  const sockets = new Set<TcpSocket>();
  const server: TcpServer = createTcpServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
    client.on('data', (d) => !hung && upstream.write(d));
    upstream.on('data', (d) => !hung && client.write(d));
    const end = () => (client.destroy(), upstream.destroy());
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    hang: () => (hung = true),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe.skipIf(!PG_URL)('a hung Postgres', () => {
  const schema = 'mjm_hang_' + randomHex(6);
  let admin: Pool;
  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => undefined });
    await pool.end();
  });
  afterAll(async () => {
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.end();
  });

  it('times a query out instead of waiting forever, and the server cancels a slow statement', async () => {
    const target = new URL(PG_URL!);
    const proxy = await blackHoleProxy(target);
    const via = new URL(PG_URL!);
    via.hostname = '127.0.0.1';
    via.port = String(proxy.port);
    const pool = createPool(via.toString(), { queryTimeoutMs: 300 });
    pool.on('error', () => undefined);
    try {
      expect(await ping(pool)).toBe(true);
      proxy.hang();
      const t0 = Date.now();
      await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(await ping(pool, 200)).toBe(false);
    } finally {
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
    const direct = createPool(PG_URL!, { queryTimeoutMs: 5_000, statementTimeoutMs: 200 });
    try {
      await expect(direct.query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
    } finally {
      await direct.end();
    }
  });

  it('answers /health 503 within about two seconds and still shuts down within its deadline', async () => {
    const proxy = await blackHoleProxy(new URL(PG_URL!));
    const via = new URL(PG_URL!);
    via.hostname = '127.0.0.1';
    via.port = String(proxy.port);
    const pool = createPool(via.toString(), { options: '-c search_path=' + schema });
    pool.on('error', () => undefined);
    const repos: RepoHandle = createRepos({ pool });
    const server = await createSignalServer({
      port: 0,
      host: '127.0.0.1',
      repos,
      sessions: new SessionService(repos.repos, { pepper: 'p'.repeat(32) }),
      providers: {},
      config: loadConfig({}),
      log: () => undefined,
      persistDebounceMs: 10,
      closeDeadlineMs: 1_000,
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      server.rooms.createHostedRoom();
      proxy.hang();
      const t0 = Date.now();
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, db: 'down' });
      expect(Date.now() - t0).toBeLessThan(3_000);
      const t1 = Date.now();
      await server.close();
      expect(Date.now() - t1).toBeLessThan(3_000);
    } finally {
      console.error = original;
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
  }, 15_000);
});

