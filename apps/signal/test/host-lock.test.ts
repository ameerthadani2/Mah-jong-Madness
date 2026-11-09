/**
 * Only one server process hosts a database's tables. Two processes on one Postgres used to both
 * restore every table and deal two different games under the same code, overwriting each other's
 * snapshots (probe C). The server now takes a session advisory lock before it restores anything,
 * waits for it, fails to start without it, and shuts down if it loses it.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createHostLock, createPool, type HostLock, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createRepos, type RepoHandle } from '../src/repos';
import { createSignalServer, type SignalServerOptions } from '../src/server';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();

function serverOptions(repos: RepoHandle, extra: Partial<SignalServerOptions> = {}): SignalServerOptions {
  return { port: 0, host: '127.0.0.1', repos, sessions: new SessionService(repos.repos, { pepper: 'p'.repeat(32) }), providers: {}, config: loadConfig({}), log: () => undefined, ...extra };
}

/** A lock that records what the server does with it. */
function fakeLock(acquire: () => Promise<void> = async () => undefined) {
  const events: string[] = [];
  let lost: ((e: Error) => void) | null = null;
  const lock: HostLock = {
    acquire: async () => {
      events.push('acquire');
      await acquire();
    },
    onLost: (cb) => (lost = cb),
    release: async () => {
      events.push('release');
    },
  };
  return { lock, events, lose: (e: Error) => lost?.(e) };
}

describe('the server and its host lock', () => {
  it('takes the lock before restoring any table and gives it up only after the final write', async () => {
    const repos = createRepos();
    const { lock, events } = fakeLock();
    const listActive = repos.repos.tableSnapshots.listActive.bind(repos.repos.tableSnapshots);
    repos.repos.tableSnapshots.listActive = async () => (events.push('restore'), listActive());
    const save = repos.repos.tableSnapshots.save.bind(repos.repos.tableSnapshots);
    repos.repos.tableSnapshots.save = async (s) => (events.push('write'), save(s));
    const server = await createSignalServer(serverOptions(repos, { hostLock: lock }));
    server.rooms.createHostedRoom();
    await server.close();
    expect(events).toEqual(['acquire', 'restore', 'write', 'release']);
  });

  it('does not start (nothing restored, nothing listening) when the lock cannot be taken', async () => {
    const repos = createRepos();
    const { lock, events } = fakeLock(async () => {
      throw new Error('Another server still holds the host lock');
    });
    repos.repos.tableSnapshots.listActive = async () => (events.push('restore'), []);
    await expect(createSignalServer(serverOptions(repos, { hostLock: lock }))).rejects.toThrow('Another server still holds the host lock');
    expect(events).toEqual(['acquire']);
  });

  it('freezes the tables, writes them and shuts down when the lock is lost', async () => {
    const repos = createRepos();
    const { lock, events, lose } = fakeLock();
    let lostWith: Error | null = null;
    const done = new Promise<void>((resolve) => {
      void createSignalServer(
        serverOptions(repos, {
          hostLock: lock,
          onHostLockLost: (e) => {
            lostWith = e;
            resolve();
          },
        }),
      ).then((server) => {
        const code = server.rooms.createHostedRoom();
        const errors: string[] = [];
        const original = console.error;
        console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
        lose(new Error('Connection terminated'));
        console.error = original;
        expect(errors.join('\n')).toContain('lost the host lock');
        // Frozen at once: input after the loss is ignored.
        expect(server.rooms.handle('nobody', { t: 'leave' })).toBe('nobody');
        void code;
      });
    });
    await done;
    expect(lostWith!.message).toBe('Connection terminated');
    expect(events).toEqual(['acquire', 'release']);
    const [snapshot] = await repos.repos.tableSnapshots.listActive();
    expect(snapshot).toBeDefined();
  });
});

describe.skipIf(!PG_URL)('the host lock on Postgres', () => {
  const schema = 'mjm_lock_' + randomHex(6);
  let admin: Pool;
  /** A key of this run's own, so parallel test files never contend for the real one. */
  const key = () => 0x10000000 + randomInt(0, 0x0fffffff);

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

  it('lets one holder at a time take it, and the next one in once it is released', async () => {
    const k = key();
    const lines: string[] = [];
    const a = createHostLock(PG_URL!, { key: k });
    const b = createHostLock(PG_URL!, { key: k, retryMs: 100, waitMs: 600, log: (l) => lines.push(l) });
    await a.acquire();
    const t0 = Date.now();
    await expect(b.acquire()).rejects.toThrow(/Another server still holds the host lock/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(lines.some((l) => l.includes('waiting for it to stop'))).toBe(true);
    // The second process waits while the first finishes, then takes over.
    const c = createHostLock(PG_URL!, { key: k, retryMs: 100, waitMs: 5_000 });
    const taken = c.acquire();
    setTimeout(() => void a.release(), 300);
    await taken;
    await c.release();
  });

  it('reports the lock lost when its connection is cut', async () => {
    const k = key();
    const lock = createHostLock(PG_URL!, { key: k });
    await lock.acquire();
    const lost = new Promise<Error>((resolve) => lock.onLost(resolve));
    const holder = await admin.query<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1", [k]);
    expect(holder.rows.length).toBe(1);
    await admin.query('SELECT pg_terminate_backend($1)', [holder.rows[0].pid]);
    expect((await lost).message).toBeTruthy();
    await lock.release();
  });

  it('keeps a second server on the same database from hosting the tables', async () => {
    const k = key();
    const poolA = createPool(PG_URL!, { options: '-c search_path=' + schema });
    const poolB = createPool(PG_URL!, { options: '-c search_path=' + schema });
    const reposA = createRepos({ pool: poolA });
    const reposB = createRepos({ pool: poolB });
    const first = await createSignalServer(serverOptions(reposA, { hostLock: createHostLock(PG_URL!, { key: k }) }));
    try {
      const code = first.rooms.createHostedRoom();
      await first.persister.flush();
      let restoredBySecond = false;
      const listActive = reposB.repos.tableSnapshots.listActive.bind(reposB.repos.tableSnapshots);
      reposB.repos.tableSnapshots.listActive = async () => ((restoredBySecond = true), listActive());
      await expect(createSignalServer(serverOptions(reposB, { hostLock: createHostLock(PG_URL!, { key: k, retryMs: 100, waitMs: 500, log: () => undefined }) }))).rejects.toThrow(/host lock/);
      expect(restoredBySecond).toBe(false);
      expect(first.rooms.hasRoom(code)).toBe(true);
      // Once the first stops, a new server takes over and restores the table.
      await first.close();
      const next = await createSignalServer(serverOptions(reposB, { hostLock: createHostLock(PG_URL!, { key: k, retryMs: 100, waitMs: 5_000 }) }));
      expect(next.rooms.hasRoom(code)).toBe(true);
      await next.close();
    } finally {
      await first.close();
      await poolA.end();
      await poolB.end();
    }
  });
});
