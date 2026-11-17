/**
 * The hosted-table cap (`MAX_HOSTED_TABLES`) governs opening new tables only: at boot every live
 * snapshot is restored even when there are more of them than the cap allows (the cap was lowered,
 * say), so no live match is ended by a configuration change. New tables are refused until the
 * count is back under the cap. On the memory repositories and (with DATABASE_URL_TEST) Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { TablePersister } from '../src/persist';
import { createMemoryRepos, createPgRepos, type TableSnapshotsRepo } from '../src/repos';
import { RoomLimitError, RoomRegistry } from '../src/rooms';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();

function contract(name: string, repo: () => TableSnapshotsRepo) {
  describe(name, () => {
    it('restores every live table when there are more than the cap allows, and opens no new one until under it', async () => {
      const first = new RoomRegistry({ allowHosted: true, botDelayMs: 0, maxHostedTables: 3 });
      const writer = new TablePersister(first, repo(), { log: () => undefined });
      writer.start();
      const prefix = randomHex(2).toUpperCase();
      const codes = [1, 2, 3].map((i) => first.createHostedRoom({ code: `R${prefix}${i}`, createdBy: `owner-${i}` }));
      await writer.flush();
      writer.stop();
      first.shutdown();

      // The cap is lowered to one table before the next boot.
      const logs: string[] = [];
      const second = new RoomRegistry({ allowHosted: true, botDelayMs: 0, maxHostedTables: 1 });
      const reader = new TablePersister(second, repo(), { log: (m) => logs.push(m) });
      const restored = await reader.restore();
      expect(restored.filter((c) => codes.includes(c)).sort()).toEqual([...codes].sort());
      for (const c of codes) {
        expect(second.hasRoom(c)).toBe(true);
        expect((await repo().get(c))?.status).not.toBe('finished');
      }
      expect(logs.some((m) => m.includes('marking it finished'))).toBe(false);
      // Opening a new table is still refused while the count is over the cap.
      expect(() => second.createHostedRoom({ createdBy: 'someone' })).toThrow(RoomLimitError);
      second.shutdown();
    });
  });
}

contract('restoring over the hosted-table cap (memory)', (() => {
  const repo = createMemoryRepos().tableSnapshots;
  return () => repo;
})());

describe.skipIf(!PG_URL)('restoring over the hosted-table cap (postgres)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(PG_URL!);
    await migrate(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  contract('contract', () => createPgRepos(pool).tableSnapshots);
});
