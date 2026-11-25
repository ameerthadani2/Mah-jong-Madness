import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, string>();
/** Which of the phone's writes fail: `set` (a full storage), or `set` and `remove` (a storage that writes nothing). */
const failing = { set: false, remove: false, delayMs: 0 };
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => stored.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (failing.delayMs > 0) await new Promise((r) => setTimeout(r, failing.delayMs));
      if (failing.set) throw new Error('storage full');
      stored.set(key, value);
    },
    removeItem: async (key: string) => {
      if (failing.remove) throw new Error('storage broken');
      stored.delete(key);
    },
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

  it('hands a stale online record that holds a match to be kept before it deletes it; nothing else is handed over', async () => {
    const old = Date.now() - 13 * 3600_000;
    const online = { kind: 'online', signalUrl: 'wss://example.test', roomCode: 'AB12', token: 'tok', name: 'Tester', avatar: 'auntie', savedAt: old, client: { version: 2, state: { matchId: 'm-1' } } };
    stored.set(KEY, JSON.stringify(online));
    const kept: unknown[] = [];
    expect(
      await storage.loadActiveSession(async (s) => {
        // Still stored while it is being kept.
        expect(stored.has(KEY)).toBe(true);
        kept.push(s);
      }),
    ).toBeNull();
    expect(kept).toEqual([online]);
    expect(stored.has(KEY)).toBe(false);
    // One with no match, or a local one: deleted, nothing kept.
    for (const rec of [{ ...online, client: { version: 2, state: { matchId: null } } }, { ...online, kind: 'local' }]) {
      stored.set(KEY, JSON.stringify(rec));
      kept.length = 0;
      expect(await storage.loadActiveSession((s) => void kept.push(s))).toBeNull();
      expect(kept).toEqual([]);
      expect(stored.has(KEY)).toBe(false);
    }
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
    stored.set('mjm.tableArchive', JSON.stringify([entry('OLD', now - 31 * 24 * 3600_000), { junk: true }, entry('B', now)]));
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

describe('the red hands kept apart from the records', () => {
  beforeEach(() => stored.clear());

  it('are written under their own key and read back, damaged entries left out', async () => {
    const good = { signalUrl: 'wss://example.test', roomCode: 'AB12', matchId: 'm-1', hand: 1, failures: ['Host sent a malformed frame'] };
    await storage.saveRedHands([good]);
    expect(await storage.loadRedHands()).toEqual([good]);
    stored.set('mjm.redHands', JSON.stringify([good, { junk: true }]));
    expect(await storage.loadRedHands()).toEqual([good]);
    stored.set('mjm.redHands', '[{');
    expect(await storage.loadRedHands()).toEqual([]);
  });
});

describe('the journal of moves', () => {
  const KEY_J = 'mjm.moveJournal';
  const j = (seq: number) => [{ signalUrl: 'wss://example.test', matchId: 'm-1', entries: [{ seq, matchId: 'm-1' }] }];
  beforeEach(() => {
    stored.clear();
    Object.assign(failing, { set: false, remove: false, delayMs: 0 });
  });

  it('on a phone: written through AsyncStorage, the move going once the write is done, and read back', async () => {
    const wrote = storage.writeJournal(j(1));
    expect(wrote).toBeInstanceOf(Promise);
    await wrote;
    expect(JSON.parse(stored.get(KEY_J)!)).toEqual(j(1));
    expect(await storage.loadJournal()).toEqual(j(1));
    stored.set(KEY_J, '[{');
    expect(await storage.loadJournal()).toEqual([]);
  });

  it('on a phone: writes land in the order they were asked for, a slow one included', async () => {
    failing.delayMs = 20;
    const first = storage.writeJournal(j(1));
    failing.delayMs = 0;
    const second = storage.writeJournal(j(2));
    await Promise.all([first, second]);
    expect(JSON.parse(stored.get(KEY_J)!)).toEqual(j(2));
  });

  it('on a phone: a write that fails takes the journal off the device and lets the move go; when that fails too, the move is kept back', async () => {
    stored.set(KEY_J, JSON.stringify(j(1)));
    failing.set = true;
    await expect(storage.writeJournal(j(2))).resolves.toBeUndefined();
    expect(stored.has(KEY_J)).toBe(false);
    stored.set(KEY_J, JSON.stringify(j(1)));
    failing.remove = true;
    await expect(storage.writeJournal(j(2))).rejects.toThrow();
    // The next write is not held up by the one that failed.
    Object.assign(failing, { set: false, remove: false });
    await storage.writeJournal(j(3));
    expect(JSON.parse(stored.get(KEY_J)!)).toEqual(j(3));
  });

  it('on the web: written at once to the browser\'s storage (the move goes in the same turn), or taken off it when the write fails', () => {
    const web = new Map<string, string>();
    const ls = {
      full: false,
      setItem(k: string, v: string) {
        if (ls.full) throw new Error('QuotaExceededError');
        web.set(k, v);
      },
      removeItem: (k: string) => void web.delete(k),
    };
    vi.stubGlobal('localStorage', ls);
    try {
      expect(storage.writeJournal(j(1))).toBeUndefined();
      expect(JSON.parse(web.get(KEY_J)!)).toEqual(j(1));
      ls.full = true;
      expect(storage.writeJournal(j(2))).toBeUndefined();
      expect(web.has(KEY_J)).toBe(false);
      // Not a phone's write.
      expect(stored.has(KEY_J)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
