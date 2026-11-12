/**
 * The production smoke test (scripts/smoke.ts) run against the real game server on port 0: it
 * plays a whole hand with three bots, verifies the audit, checks that the table reached storage
 * and deletes its account; a failure at any step is reported by name and still deletes the
 * account. With DATABASE_URL_TEST the storage checks also run against Postgres.
 */
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createRepos, type RepoHandle } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';
import { parseArgs, runSmoke, smokeStorage, smokeUrls, SMOKE_DISPLAY_NAME } from '../scripts/smoke';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const IMAGE = 'registry.fly.io/mahjong-test:deployment-01JTESTIMAGE';

const servers: SignalServer[] = [];
const stubs: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(stubs.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(env: Record<string, string> = {}, repos: RepoHandle = createRepos()) {
  const server = await createSignalServer({
    port: 0,
    host: '127.0.0.1',
    repos,
    sessions: new SessionService(repos.repos, { pepper: 'smoke-pepper-0123456789abcdef' }),
    providers: {},
    config: loadConfig(env),
    botDelayMs: 0,
    persistDebounceMs: 20,
    imageRef: IMAGE,
    log: () => undefined,
  });
  servers.push(server);
  return { server, repos, base: `http://127.0.0.1:${server.address().port}` };
}

/**
 * A proxy in front of `target` (requests and socket upgrades pass through) that answers
 * `DELETE /api/me` itself with 204 and deletes nothing: a server whose account deletion does not work.
 */
async function proxyThatDoesNotDelete(target: string): Promise<string> {
  const to = new URL(target);
  const s = createServer((req, res) => {
    if (req.method === 'DELETE' && req.url === '/api/me') {
      res.writeHead(204).end();
      return;
    }
    const up = request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  s.on('upgrade', (req, socket, head) => {
    const up = connect(Number(to.port), to.hostname, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${String(v)}\r\n`).join('')}\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  stubs.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

/** Collects the smoke test's lines and the account ids it names. */
function capture() {
  const lines: string[] = [];
  const created: string[] = [];
  return {
    lines,
    created,
    log: (line: string) => {
      lines.push(line);
      const m = /user ([0-9a-f-]{36})/.exec(line);
      if (m) created.push(m[1]);
    },
  };
}

/** A plain HTTP server answering every request with `status` and `body`. */
async function stub(status: number, body: unknown): Promise<string> {
  const s = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  stubs.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const addr = s.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

/** Every user the memory repositories hold, deleted or not. */
async function usersNamed(repos: RepoHandle, ids: string[]) {
  return Promise.all(ids.map((id) => repos.repos.users.get(id)));
}

describe('smoke test', () => {
  it('derives the socket address from an http, https, ws or wss address, keeping only the origin', () => {
    expect(smokeUrls('https://mahjong-signal.fly.dev')).toEqual({ base: 'https://mahjong-signal.fly.dev', wsUrl: 'wss://mahjong-signal.fly.dev' });
    expect(smokeUrls('wss://mahjong-signal.fly.dev/socket')).toEqual({ base: 'https://mahjong-signal.fly.dev', wsUrl: 'wss://mahjong-signal.fly.dev' });
    expect(smokeUrls('http://127.0.0.1:8787/')).toEqual({ base: 'http://127.0.0.1:8787', wsUrl: 'ws://127.0.0.1:8787' });
    expect(smokeUrls('ws://localhost:8787')).toEqual({ base: 'http://localhost:8787', wsUrl: 'ws://localhost:8787' });
    expect(() => smokeUrls('ftp://example.com')).toThrow(/Unsupported scheme/);
    expect(() => smokeUrls('mahjong-signal.fly.dev')).toThrow(/Not a URL/);
  });

  it('plays a whole hand against the real server with three bots, verifies its audit and deletes the smoke account', async () => {
    const { base, repos, server } = await start();
    const created: string[] = [];
    const lines: string[] = [];
    const result = await runSmoke(base, {
      handTimeoutMs: 60_000,
      log: (line) => {
        lines.push(line);
        const m = /user ([0-9a-f-]{36})/.exec(line);
        if (m) created.push(m[1]);
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.wsUrl).toBe(base.replace('http://', 'ws://'));
    expect(result.steps.map((s) => s.name)).toEqual(['health', 'config', 'guest', 'socket', 'table', 'bots', 'hand', 'audit', 'snapshot', 'leave', 'delete']);
    expect(result.steps.every((s) => s.ok && s.ms >= 0)).toBe(true);
    expect(result.steps.find((s) => s.name === 'audit')!.detail).toMatch(/^hand 0 verified/);
    // It says which build answered, that the table reached storage, and that the deleted session is dead.
    expect(result.steps.find((s) => s.name === 'health')!.detail).toBe(`storage memory, 0 tables, image ${IMAGE}`);
    expect(result.steps.find((s) => s.name === 'snapshot')!.detail).toMatch(/^\d+ written during the hand, none failed, last at \d{4}-\d\d-\d\dT/);
    expect(result.steps.find((s) => s.name === 'delete')!.detail).toBe('the session no longer works');
    expect(lines.every((l) => l.startsWith('ok '))).toBe(true);
    // The account was a marked smoke account, and it is gone (anonymised) afterwards.
    expect(created).toHaveLength(1);
    const [user] = await usersNamed(repos, created);
    expect(user?.deletedAt).not.toBeNull();
    expect(user?.displayName).not.toBe(SMOKE_DISPLAY_NAME);
    // The socket and seat were let go.
    await expect.poll(() => server.rooms.stats().peers, { timeout: 5_000 }).toBe(0);
  }, 90_000);

  it('names the failing step and still deletes the account when the server cannot open a table', async () => {
    const { base, repos } = await start({ HOST_TABLES: '0' });
    const created: string[] = [];
    const lines: string[] = [];
    const result = await runSmoke(base, {
      log: (line) => {
        lines.push(line);
        const m = /user ([0-9a-f-]{36})/.exec(line);
        if (m) created.push(m[1]);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^table: the server refused to open a table/);
    expect(result.steps.map((s) => [s.name, s.ok])).toEqual([
      ['health', true],
      ['config', true],
      ['guest', true],
      ['socket', true],
      ['table', false],
    ]);
    expect(lines).toContain('cleanup: the smoke account was deleted');
    const [user] = await usersNamed(repos, created);
    expect(user?.deletedAt).not.toBeNull();
  });

  it('fails at the health check when the server reports its database down', async () => {
    const base = await stub(503, { ok: false, db: 'down', storage: 'pg' });
    const result = await runSmoke(base);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^health: \/health answered 503/);
    expect(result.steps).toHaveLength(1);
  });

  it('fails at the health check when a 200 answer still reports the database not ok', async () => {
    const base = await stub(200, { ok: true, db: 'slow', storage: 'pg' });
    const result = await runSmoke(base);
    expect(result.error).toBe("health: /health reports the database as 'slow'");
  });

  it('fails with a clear message when nothing answers at the address', async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(r));
    const result = await runSmoke(`http://127.0.0.1:${port}`, { stepTimeoutMs: 3_000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^health: GET http:\/\/127\.0\.0\.1:\d+\/health failed: ECONNREFUSED/);
  });

  it('reports snapshot writes and the image on /health, counting a write the store refuses', async () => {
    const { base, repos, server } = await start();
    const health = async () => (await (await fetch(`${base}/health`)).json()) as { ok: boolean; image: string | null; snapshots: { saved: number; failed: number; lastSavedAt: string | null; lastFailedAt: string | null } };
    expect(await health()).toMatchObject({ ok: true, image: IMAGE, snapshots: { saved: 0, failed: 0, lastSavedAt: null, lastFailedAt: null } });
    server.rooms.createHostedRoom();
    await server.persister.flush();
    const saved = await health();
    expect(saved.snapshots).toMatchObject({ saved: 1, failed: 0, lastFailedAt: null });
    expect(Date.parse(saved.snapshots.lastSavedAt!)).toBeGreaterThan(Date.now() - 60_000);
    repos.repos.tableSnapshots.save = () => Promise.reject(new Error('relation "table_snapshots" does not exist'));
    await server.persister.flush();
    const failed = await health();
    expect(failed.snapshots).toMatchObject({ saved: 1, failed: 1, lastSavedAt: saved.snapshots.lastSavedAt });
    expect(failed.snapshots.lastFailedAt).not.toBeNull();
    // Still 200: a storage fault must not make the platform restart the machine and end every table.
    expect(failed.ok).toBe(true);
  });

  it('fails when the server is on the wrong storage, saying what a memory server loses', async () => {
    const { base } = await start();
    const wrong = await runSmoke(base, { expectStorage: 'pg' });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toBe("health: /health reports storage 'memory', expected 'pg': accounts, clubs and tables are lost at every restart (DATABASE_URL is not set, or ALLOW_EPHEMERAL=1 is still on)");
    expect(wrong.steps).toHaveLength(1);
    // A server that names Postgres but no database answer is refused too, and so is one that predates the field.
    expect((await runSmoke(await stub(200, { ok: true, storage: 'pg' }), { expectStorage: 'pg' })).error).toBe('health: /health does not report the database as ok');
    expect((await runSmoke(await stub(200, { ok: true }), { expectStorage: 'pg' })).error).toMatch(/^health: \/health reports storage 'unknown', expected 'pg'/);
  });

  it('fails after the hand when the table could not be written to storage, and still deletes the account', async () => {
    const { base, repos } = await start();
    repos.repos.tableSnapshots.save = () => Promise.reject(new Error('relation "table_snapshots" does not exist'));
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(' '));
    const seen = capture();
    let result;
    try {
      result = await runSmoke(base, { handTimeoutMs: 60_000, expectStorage: 'memory', log: seen.log });
    } finally {
      console.error = original;
    }
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^snapshot: \d+ table snapshot writes? failed during the hand \(last at \d{4}-.*\): tables would not survive a restart/);
    expect(result.steps.map((s) => [s.name, s.ok]).slice(-2)).toEqual([['audit', true], ['snapshot', false]]);
    expect(errors.some((l) => l.includes('snapshot not saved'))).toBe(true);
    expect(seen.lines).toContain('cleanup: the smoke account was deleted');
    expect((await usersNamed(repos, seen.created))[0]?.deletedAt).not.toBeNull();
  }, 90_000);

  it('fails when the deleted account\'s session still works', async () => {
    const { base, repos } = await start();
    const seen = capture();
    const result = await runSmoke(await proxyThatDoesNotDelete(base), { handTimeoutMs: 60_000, log: seen.log });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("delete: the deleted account's session still works: GET /api/me answered 200 instead of 401");
    expect(result.steps.map((s) => s.name).slice(-3)).toEqual(['snapshot', 'leave', 'delete']);
    expect((await usersNamed(repos, seen.created))[0]?.deletedAt).toBeNull();
  }, 90_000);

  it('reads --expect-storage from the command line or SMOKE_EXPECT_STORAGE and refuses anything else', () => {
    expect(parseArgs(['https://x.fly.dev'])).toEqual({ url: 'https://x.fly.dev', json: false });
    expect(parseArgs(['https://x.fly.dev', '--expect-storage', 'pg', '--hand-timeout', '120', '--json'])).toEqual({ url: 'https://x.fly.dev', expectStorage: 'pg', handTimeoutMs: 120_000, json: true });
    expect(parseArgs(['--expect-storage=memory', 'ws://localhost:8787'])).toMatchObject({ url: 'ws://localhost:8787', expectStorage: 'memory' });
    expect(parseArgs(['https://x.fly.dev'], { SMOKE_EXPECT_STORAGE: 'postgres' }).expectStorage).toBe('pg');
    expect(parseArgs(['https://x.fly.dev', '--expect-storage', 'memory'], { SMOKE_EXPECT_STORAGE: 'pg' }).expectStorage).toBe('memory');
    expect(smokeStorage('  ')).toBeUndefined();
    expect(() => parseArgs(['https://x.fly.dev', '--expect-storage', 'sqlite'])).toThrow(/takes 'pg' or 'memory', not 'sqlite'/);
    expect(() => parseArgs(['https://x.fly.dev', '--expect-storage'])).toThrow(/takes 'pg' or 'memory'/);
    expect(() => parseArgs(['https://x.fly.dev', '--expect-store', 'pg'])).toThrow(/Unknown option '--expect-store'/);
  });

  it('refuses an address that is not a URL before contacting anything', async () => {
    const result = await runSmoke('not a url');
    expect(result).toMatchObject({ ok: false, steps: [] });
    expect(result.error).toMatch(/Not a URL/);
  });
});

describe.skipIf(!PG_URL)('smoke test (Postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const schema = 'mjm_smoke_' + randomHex(6);

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => undefined });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  it('passes with --expect-storage pg while tables reach the database, and fails once they cannot be written', async () => {
    const { base } = await start({}, createRepos({ pool }));
    const good = await runSmoke(base, { handTimeoutMs: 60_000, expectStorage: 'pg' });
    expect(good.error).toBeUndefined();
    expect(good.steps.find((s) => s.name === 'health')!.detail).toBe(`storage pg, db ok, 0 tables, image ${IMAGE}`);
    expect(good.steps.find((s) => s.name === 'snapshot')!.detail).toMatch(/written during the hand, none failed/);
    expect((await runSmoke(base, { expectStorage: 'memory' })).error).toBe("health: /health reports storage 'pg', expected 'memory'");

    // The database still answers (/health says db ok) but the table cannot be stored.
    await pool.query('ALTER TABLE table_snapshots RENAME TO table_snapshots_away');
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(' '));
    let bad;
    try {
      bad = await runSmoke(base, { handTimeoutMs: 60_000, expectStorage: 'pg' });
    } finally {
      console.error = original;
      await pool.query('ALTER TABLE table_snapshots_away RENAME TO table_snapshots');
    }
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((s) => s.name === 'health')!.ok).toBe(true);
    expect(bad.error).toMatch(/^snapshot: \d+ table snapshot writes? failed during the hand/);
    expect(errors.some((l) => /snapshot not saved.*table_snapshots/.test(l))).toBe(true);
  }, 120_000);
});
