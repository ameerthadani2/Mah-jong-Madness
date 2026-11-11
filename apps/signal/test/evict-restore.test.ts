/**
 * An eviction outlives a restart: the accounts taken off a table are written with its snapshot
 * and rebuilt when the table is restored, so the evicted player still cannot come back.
 */
import { describe, expect, it } from 'vitest';
import { TablePersister } from '../src/persist';
import { createMemoryRepos } from '../src/repos';
import { ROOM_UNAVAILABLE_CODE, RoomRegistry, type Socket } from '../src/rooms';

type Out = { t: string; code?: string; room?: string };

function peer(rooms: RoomRegistry, userId: string) {
  const out: Out[] = [];
  const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined };
  const id = rooms.hello(rooms.connect(socket), userId);
  return { id, out, last: () => out[out.length - 1] };
}

const sit = (rooms: RoomRegistry, id: string, code: string) => rooms.handle(id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg: { t: 'join', name: 'x' } } });

describe('evictions and restarts', () => {
  it('keeps an evicted account out of the table after the table is restored from its snapshot', async () => {
    const repo = createMemoryRepos().tableSnapshots;
    const before = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const writer = new TablePersister(before, repo, { log: () => undefined });
    writer.start();
    const code = before.createHostedRoom();
    const griefer = peer(before, 'user-griefer-1');
    before.handle(griefer.id, { t: 'join', room: code });
    sit(before, griefer.id, code);
    // One evicted from a seat, one evicted before ever sitting down (nothing at the table changes for that one).
    expect(before.evictFromTable(code, 'user-griefer-1')).toBe(1);
    expect(before.evictFromTable(code, 'user-lurker-1')).toBe(0);
    before.handle(griefer.id, { t: 'join', room: code });
    expect(griefer.last()).toMatchObject({ t: 'error', code: ROOM_UNAVAILABLE_CODE });
    await writer.flush();
    expect(((await repo.get(code))!.snapshot as { evicted?: string[] }).evicted).toEqual(['user-griefer-1', 'user-lurker-1']);
    writer.stop();
    before.shutdown();

    const after = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const reader = new TablePersister(after, repo, { log: () => undefined });
    expect(await reader.restore()).toEqual([code]);
    expect(after.evictedOf(code)).toEqual(['user-griefer-1', 'user-lurker-1']);
    for (const id of ['user-griefer-1', 'user-lurker-1']) {
      const back = peer(after, id);
      after.handle(back.id, { t: 'join', room: code });
      expect(back.last()).toMatchObject({ t: 'error', code: ROOM_UNAVAILABLE_CODE });
    }
    const friend = peer(after, 'user-friend-1');
    after.handle(friend.id, { t: 'join', room: code });
    expect(friend.last()).toMatchObject({ t: 'room', room: code });
    sit(after, friend.id, code);
    expect(after.hostedTable(code)!.seatInfo().filter((s) => s.userId).map((s) => s.userId)).toEqual(['user-friend-1']);
    // Written again after the restart, the snapshot still names them.
    reader.start();
    await reader.flush();
    expect(((await repo.get(code))!.snapshot as { evicted?: string[] }).evicted).toEqual(['user-griefer-1', 'user-lurker-1']);
    reader.stop();
  });

  it('writes the snapshot when an account that held no seat is evicted', async () => {
    const repo = createMemoryRepos().tableSnapshots;
    const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const persister = new TablePersister(rooms, repo, { debounceMs: 1, minIntervalMs: 1, log: () => undefined });
    persister.start();
    const code = rooms.createHostedRoom();
    rooms.evictFromTable(code, 'user-lurker-1');
    await new Promise((r) => setTimeout(r, 30));
    expect(((await repo.get(code))?.snapshot as { evicted?: string[] } | undefined)?.evicted).toEqual(['user-lurker-1']);
    persister.stop();
  });
});
