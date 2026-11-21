import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => stored.get(key) ?? null,
    setItem: async (key: string, value: string) => void stored.set(key, value),
    removeItem: async (key: string) => void stored.delete(key),
  },
}));

import { storage } from './storage';

const KEY = 'mjm.activeSession';

describe('loading the saved table', () => {
  beforeEach(() => stored.clear());

  it("gives no table for the assessor's damaged record, and deletes it", async () => {
    stored.set(KEY, '{"kind":"local","state":{"wall":"oops"}}');
    expect(await storage.loadActiveSession()).toBeNull();
    expect(stored.has(KEY)).toBe(false);
  });

  it('deletes a record that is not JSON', async () => {
    stored.set(KEY, '{"kind":"loc');
    expect(await storage.loadActiveSession()).toBeNull();
    expect(stored.has(KEY)).toBe(false);
  });

  it('returns a sound record and leaves it stored', async () => {
    const record = { kind: 'online', signalUrl: 'wss://example.test', roomCode: 'AB12', token: 'tok', name: 'Tester', avatar: 'auntie', savedAt: Date.now() };
    stored.set(KEY, JSON.stringify(record));
    expect(await storage.loadActiveSession()).toEqual(record);
    expect(stored.has(KEY)).toBe(true);
  });
});

describe('the records of tables that left the saved slot', () => {
  beforeEach(() => stored.clear());
  const entry = (room: string, at: number) => ({ signalUrl: 'wss://example.test', roomCode: room, matchId: `m-${room}`, token: 'tok', client: { version: 2, state: { matchId: `m-${room}` } }, archivedAt: at });

  it('are written under their own key and read back, the expired and damaged ones left out', async () => {
    const now = Date.now();
    await storage.saveArchive([entry('A', now - 1_000)] as never);
    expect(JSON.parse(stored.get('mjm.tableArchive')!)).toHaveLength(1);
    expect((await storage.loadArchive()).map((e) => e.roomCode)).toEqual(['A']);
    stored.set('mjm.tableArchive', JSON.stringify([entry('OLD', now - 2 * 24 * 3600_000), { junk: true }, entry('B', now)]));
    expect((await storage.loadArchive()).map((e) => e.roomCode)).toEqual(['B']);
    stored.set('mjm.tableArchive', '{"not json');
    expect(await storage.loadArchive()).toEqual([]);
  });

  it('an empty list removes the key', async () => {
    stored.set('mjm.tableArchive', '[]');
    await storage.saveArchive([]);
    expect(stored.has('mjm.tableArchive')).toBe(false);
  });
});
