/**
 * Snapshot writes are rate-limited per table while a hand is played: at most one every 2 s, with
 * the end of a hand, the end of a match and the final flush written at once. Every move used to
 * cost a database write half a second later, which is most of the write load of a busy server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, TableHost } from '@mjm/net';
import { TablePersister } from '../src/persist';
import { createMemoryRepos } from '../src/repos';
import type { RoomEvent, RoomRegistry } from '../src/rooms';

/** Just enough of a registry and a playing table for the persister. */
function fakeRegistry() {
  const changes = new Set<(room: string) => void>();
  const events = new Set<(ev: RoomEvent) => void>();
  const host = { phase: 'playing', match: () => ({ handNumber: 1 }), audits: [], serialize: () => ({ version: 1, roomCode: 'TABLE1', phase: 'playing' }) } as unknown as TableHost;
  const rooms = {
    onTableChange: (cb: (room: string) => void) => (changes.add(cb), () => changes.delete(cb)),
    onRoomEvent: (cb: (ev: RoomEvent) => void) => (events.add(cb), () => events.delete(cb)),
    hostedTable: (code: string) => (code === 'TABLE1' ? host : undefined),
    hostedRooms: () => ['TABLE1'],
    clubOf: () => undefined,
    createdByOf: () => undefined,
    quickPlayersOf: () => undefined,
    evictedOf: () => undefined,
  } as unknown as RoomRegistry;
  return {
    rooms,
    change: () => changes.forEach((h) => h('TABLE1')),
    event: (type: HostEvent['type']) => events.forEach((h) => h({ room: 'TABLE1', event: { type, handNumber: 1 } as HostEvent })),
  };
}

describe('snapshot write rate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes a table at most every 2 s while it changes many times a second', async () => {
    const reg = fakeRegistry();
    const persister = new TablePersister(reg.rooms, createMemoryRepos().tableSnapshots, { now: () => Date.now(), log: () => undefined });
    persister.start();
    // Ten moves a second for ten seconds.
    for (let i = 0; i < 100; i++) {
      reg.change();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(persister.writes).toBeGreaterThanOrEqual(5);
    expect(persister.writes).toBeLessThanOrEqual(6);
    persister.stop();
  });

  it('still writes the first change after the short debounce, and a hand or match end at once', async () => {
    const reg = fakeRegistry();
    const persister = new TablePersister(reg.rooms, createMemoryRepos().tableSnapshots, { now: () => Date.now(), log: () => undefined });
    persister.start();
    reg.change();
    await vi.advanceTimersByTimeAsync(500);
    expect(persister.writes).toBe(1);
    reg.change();
    await vi.advanceTimersByTimeAsync(500);
    // Within 2 s of the last write: the move waits...
    expect(persister.writes).toBe(1);
    // ...but the end of the hand does not.
    reg.event('hand_over');
    await vi.advanceTimersByTimeAsync(0);
    expect(persister.writes).toBe(2);
    reg.event('match_over');
    await vi.advanceTimersByTimeAsync(0);
    expect(persister.writes).toBe(3);
    // And the final flush writes whatever is pending without waiting either.
    reg.change();
    await persister.flush();
    expect(persister.writes).toBe(4);
    persister.stop();
  });
});
