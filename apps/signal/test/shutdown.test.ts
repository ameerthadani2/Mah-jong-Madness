/**
 * SIGTERM with a database that cannot take the final write (probe dbhang: "snapshot not saved",
 * then exit 0): `closeAndReport()` says whether every table reached the store, and the process's
 * stop (src/shutdown.ts, used by src/main.ts) exits 1 when it did not, so the platform sees the
 * failure. The hung-Postgres case itself is in db-timeouts.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos } from '../src/repos';
import { createSignalServer } from '../src/server';
import { shutdown } from '../src/shutdown';

async function serverWith(failSaves: boolean) {
  const handle = createRepos({});
  const repos = handle.repos;
  const snapshots = repos.tableSnapshots;
  let failing = false;
  const save = snapshots.save.bind(snapshots);
  snapshots.save = async (s) => {
    if (failing) throw new Error('Connection terminated due to connection timeout');
    return save(s);
  };
  const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos: handle, sessions: new SessionService(repos, { pepper: 'p'.repeat(32) }), providers: {}, config: loadConfig({}), log: () => undefined, persistDebounceMs: 10_000, closeDeadlineMs: 2_000 });
  server.rooms.createHostedRoom();
  failing = failSaves;
  return server;
}

describe('the final write on shutdown', () => {
  it('reports the tables written when the store took them', async () => {
    const server = await serverWith(false);
    expect(await server.closeAndReport()).toEqual({ written: true });
  });

  it('reports a snapshot that was not saved, and the stop exits 1 after closing everything else', async () => {
    const server = await serverWith(true);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
    const ran: string[] = [];
    try {
      const code = await shutdown({ server, after: [() => ran.push('analytics'), async () => ran.push('database')], error: (l) => errors.push(l) });
      expect(code).toBe(1);
    } finally {
      console.error = original;
    }
    expect(ran).toEqual(['analytics', 'database']);
    expect(errors.some((l) => l.includes('snapshot not saved'))).toBe(true);
    expect(errors.some((l) => l.includes('final table snapshot was not saved'))).toBe(true);
    // close() again answers the same report.
    expect(await server.closeAndReport()).toEqual({ written: false });
  });

  it('exits 0 when everything was written and closed, and 1 when a later step fails', async () => {
    const ok = { closeAndReport: async () => ({ written: true }) };
    expect(await shutdown({ server: ok, after: [() => undefined] })).toBe(0);
    const lines: string[] = [];
    expect(await shutdown({ server: ok, after: [() => Promise.reject(new Error('pool end failed'))], error: (l) => lines.push(l) })).toBe(1);
    expect(lines).toEqual(['[signal] shutdown error pool end failed']);
    expect(await shutdown({ server: { closeAndReport: () => Promise.reject(new Error('boom')) }, after: [], error: () => undefined })).toBe(1);
  });
});
