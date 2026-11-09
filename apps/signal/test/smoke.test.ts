/**
 * The production smoke test (scripts/smoke.ts) run against the real game server on port 0: it
 * plays a whole hand with three bots, verifies the audit and deletes its account; a failure at
 * any step is reported by name and still deletes the account.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos, type RepoHandle } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';
import { runSmoke, smokeUrls, SMOKE_DISPLAY_NAME } from '../scripts/smoke';

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
    log: () => undefined,
  });
  servers.push(server);
  return { server, repos, base: `http://127.0.0.1:${server.address().port}` };
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
    expect(result.steps.map((s) => s.name)).toEqual(['health', 'config', 'guest', 'socket', 'table', 'bots', 'hand', 'audit', 'leave', 'delete']);
    expect(result.steps.every((s) => s.ok && s.ms >= 0)).toBe(true);
    expect(result.steps.find((s) => s.name === 'audit')!.detail).toMatch(/^hand 0 verified/);
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

  it('refuses an address that is not a URL before contacting anything', async () => {
    const result = await runSmoke('not a url');
    expect(result).toMatchObject({ ok: false, steps: [] });
    expect(result.error).toMatch(/Not a URL/);
  });
});
