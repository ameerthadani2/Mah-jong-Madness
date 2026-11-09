/**
 * A quick-match table admits only the accounts the matchmaker seated there. That rule travels in
 * the table's snapshot, so a server restart does not turn a stranger-proof table into one anyone
 * with the code can join.
 */
import { describe, expect, it } from 'vitest';
import { TablePersister } from '../src/persist';
import { createMemoryRepos } from '../src/repos';
import { RoomRegistry } from '../src/rooms';

describe('a quick-match table after a restart', () => {
  it('keeps its matched-players-only rule', async () => {
    const repo = createMemoryRepos().tableSnapshots;
    const first = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const writer = new TablePersister(first, repo, { log: () => undefined });
    writer.start();
    const code = first.createHostedRoom({ quickMatch: { players: ['user-a', 'user-b'] } });
    expect(first.quickPlayersOf(code)).toEqual(['user-a', 'user-b']);
    await writer.flush();
    writer.stop();
    first.shutdown();

    const second = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const reader = new TablePersister(second, repo, { log: () => undefined });
    expect(await reader.restore()).toEqual([code]);
    expect(second.quickPlayersOf(code)).toEqual(['user-a', 'user-b']);
    second.shutdown();
  });

  it('leaves an ordinary table open to anyone with the code', async () => {
    const repo = createMemoryRepos().tableSnapshots;
    const first = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const writer = new TablePersister(first, repo, { log: () => undefined });
    writer.start();
    const code = first.createHostedRoom({});
    await writer.flush();
    writer.stop();
    first.shutdown();

    const second = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    await new TablePersister(second, repo, { log: () => undefined }).restore();
    expect(second.quickPlayersOf(code)).toBeUndefined();
    second.shutdown();
  });
});
