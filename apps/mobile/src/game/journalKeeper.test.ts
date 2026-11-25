/**
 * The app's journal of moves (game/journalKeeper.ts, logic/moveJournal.ts) with the real table client and table: every
 * move goes to the journal before it goes out, and a client restored from the record the app saved is given back what the
 * journal holds, so a move written in the player's name while the app was not running is caught, however close to the
 * app's last save it was made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAction, legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { failureKey, LoopbackHub, TableClient, TableHost, transportLink, type JournalEntry, type Link, type SerializedClient } from '@mjm/net';
import { journalKeeper, type JournalStore } from './journalKeeper';
import type { MoveJournal } from '../logic/moveJournal';

const URL = 'wss://game.example/ws';

// The same deals every run (xorshift32 over the random source the deal draws from, as the table package's tests do).
beforeEach(() => {
  let state = 20261125;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      buf[i] = (state >>> 0) & 0xff;
    }
    return buf;
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});
const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
type HostInside = { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };

/** What the device holds: the journal as last written (`written`), and every write in order. */
function deviceStore(fail: () => 'ok' | 'write' | 'both' = () => 'ok'): JournalStore & { written: MoveJournal | null; writes: number } {
  const store = {
    written: null as MoveJournal | null,
    writes: 0,
    write(j: MoveJournal) {
      const f = fail();
      if (f === 'both') throw new Error('storage broken');
      store.writes++;
      // A write that fails takes the journal off the device (src/storage.ts), and the move still goes.
      store.written = f === 'write' ? null : (JSON.parse(JSON.stringify(j)) as MoveJournal);
    },
  };
  return store;
}

/**
 * A table on a fake clock: seat 0 is the player's phone (a table client with the app's journal), the others the host's
 * bots. The player makes the move its phone suggests 600 ms after it is shown a decision.
 */
function table(code: string, store: JournalStore) {
  let now = 5_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, matchId: `m-${code}`, now: () => now, botDelayMs: 400, schedule: (fn, ms) => void timers.push({ at: now + ms, fn }), intermissionSeconds: 5 });
  const keeper = journalKeeper(store);
  let links = 0;
  const open = (): Link => transportLink(hub.create(`p${links++}`), 'host');
  const opts = () => ({ now: () => now, monotonic: () => now, writeAhead: keeper.writeAhead(URL) });
  const first = open();
  const t = {
    host,
    keeper,
    link: first,
    client: new TableClient(first, 'A', undefined, {}, opts()),
    running: true,
    owedSince: new Map<string, number>(),
    get now() {
      return now;
    },
    inside: host as unknown as HostInside,
    /** The seat owes a decision on the table now. */
    owes: () => host.game !== null && host.phase === 'playing' && legalActions(host.game, 0).length > 0,
    step(ms = 100) {
      now += ms;
      for (const x of timers.filter((y) => y.at <= now)) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
      host.tick();
      if (!t.running) return;
      const s = t.client.localState();
      if (!s || legalActions(s, 0).length === 0) return;
      const key = `${s.handNumber}:${s.turnCounter}`;
      const since = t.owedSince.get(key) ?? now;
      t.owedSince.set(key, since);
      if (now - since >= 600 && since !== -1) {
        t.owedSince.set(key, -1);
        t.client.act(chooseAction(s, 0)!);
      }
    },
    /** The record the app saved last, as it saves it (src/app-state.tsx): and the journal then drops the moves it holds. */
    save(): SerializedClient {
      const rec = JSON.parse(JSON.stringify(t.client.serialize())) as SerializedClient;
      t.keeper.saved(URL, rec.state.matchId!, rec.sentSeq ?? 0);
      return rec;
    },
    /** The app's process stops: its link goes, and nothing of it runs. */
    stop() {
      t.running = false;
      t.link.close();
    },
    /** The app starts again and resumes the table from Home: a client from `rec` and what the journal holds (or nothing). */
    restore(rec: SerializedClient, withJournal: boolean) {
      const journal = withJournal ? t.keeper.journalFor(URL, rec.state.matchId!) : undefined;
      t.link = open();
      t.client = TableClient.restore(rec, t.link, 'A', undefined, { token: rec.state.token ?? undefined }, { ...opts(), journal });
      t.running = true;
      t.client.join();
    },
    /** Until the hand is over (or `until` holds). */
    run(until: () => boolean = () => false, limit = 4000) {
      for (let i = 0; i < limit && host.phase === 'playing' && !until(); i++) t.step();
    },
    /** A legal move of the seat that the table's own timeout rule would not make. */
    other(): Action | undefined {
      const g = host.game!;
      const timeout = t.inside.timeoutAction(g, 0);
      return legalActions(g, 0).find((a) => !sameAction(a, timeout, g, 0));
    },
  };
  t.client.join();
  host.start();
  return t;
}

const verdict = (c: TableClient) => {
  const a = c.state.audits.find((x) => x.audit.handNumber === 0);
  return a ? { status: a.status, failures: a.failures.map((f) => failureKey(f) ?? f) } : null;
};

/**
 * The attack of the eighth assessment (recheck 7 of unit 20f): the app saves its record a moment before the player's
 * move; the move goes out, the app stops before its next save, and while it is not running the server writes a move in
 * the player's name. The phone's journal holds the move it sent after its last save.
 */
function attack(code: string, withJournal: boolean, forge: boolean) {
  const t = table(code, deviceStore());
  let mine = 0;
  t.run(() => {
    const g = t.host.game;
    mine = g ? g.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length : 0;
    return mine >= 2 && t.owes() && t.client.state.view?.turnCounter === g!.turnCounter;
  });
  if (!t.owes()) return null;
  // The app saved a moment ago; the player now makes the move, and the app stops before its next save.
  const rec = t.save();
  const s = t.client.localState()!;
  t.client.act(chooseAction(s, 0)!);
  t.stop();
  const sent = (t.client.serialize().sentSeq ?? 0) > (rec.sentSeq ?? 0);
  // The server writes the seat's next decision in the player's name while the app is down.
  let forged: Action | undefined;
  t.run(() => {
    if (!forge || forged || !t.owes()) return false;
    forged = t.other();
    if (forged) t.inside.apply(0, forged, 'player');
    return false;
  }, 400);
  t.restore(rec, withJournal);
  t.run();
  for (let i = 0; i < 50; i++) t.step();
  return { verdict: verdict(t.client), sent, forged: forged !== undefined };
}

describe('the journal of moves at a table', () => {
  it('writes each move before it goes out, and drops the moves a written record holds', () => {
    const store = deviceStore();
    const t = table('JK1', store);
    t.run(() => (t.client.serialize().sentSeq ?? 0) >= 2);
    const m = t.client.state.matchId!;
    const held = t.keeper.journalFor(URL, m) as JournalEntry[];
    expect(held.map((e) => e.seq)).toEqual([1, 2]);
    // What the device holds is what was written: every move filed so far.
    expect(store.written).toEqual(t.keeper.journal);
    t.save();
    expect(t.keeper.journalFor(URL, m)).toEqual([]);
    expect(store.written).toEqual([{ signalUrl: URL, matchId: m, entries: [] }]);
  });

  it('a move written in the player\'s name while the app was not running, right after its last save: red with the journal', () => {
    let runs = 0;
    for (const code of ['JK2a', 'JK2b', 'JK2c', 'JK2d']) {
      const r = attack(code, true, true);
      if (!r || !r.sent || !r.forged) continue;
      runs++;
      expect(r.verdict).toMatchObject({ status: 'failed', failures: expect.arrayContaining(['moveInvented']) });
    }
    expect(runs).toBeGreaterThan(0);
  });

  it('without the journal the same move is not caught (the stated limit of a record an earlier build saved)', () => {
    let runs = 0;
    for (const code of ['JK2a', 'JK2b', 'JK2c', 'JK2d']) {
      const r = attack(code, false, true);
      if (!r || !r.sent || !r.forged) continue;
      runs++;
      expect(r.verdict?.status).not.toBe('failed');
    }
    expect(runs).toBeGreaterThan(0);
  });

  it('an honest table: the move the player made before the app stopped is played as sent, and the hand is not red', () => {
    let runs = 0;
    for (const code of ['JK3a', 'JK3b', 'JK3c']) {
      const r = attack(code, true, false);
      if (!r || !r.sent) continue;
      runs++;
      expect(r.verdict?.status).not.toBe('failed');
    }
    expect(runs).toBeGreaterThan(0);
  });

  it('a write that fails takes the journal off the device and the move still goes; one that cannot do either keeps the move back', () => {
    let mode: 'ok' | 'write' | 'both' = 'ok';
    const store = deviceStore(() => mode);
    const t = table('JK4', store);
    t.run(() => (t.client.serialize().sentSeq ?? 0) >= 1);
    t.save();
    mode = 'write';
    t.run(() => (t.client.serialize().sentSeq ?? 0) >= 2);
    // The move went (the table played it) and the device holds no journal: a cold start vouches as one without it.
    expect(t.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length).toBeGreaterThanOrEqual(2);
    expect(store.written).toBeNull();
    // This run still knows it.
    expect((t.keeper.journalFor(URL, t.client.state.matchId!) as JournalEntry[]).map((e) => e.seq)).toEqual([2]);
    mode = 'both';
    const before = t.host.game!.actionLog.length;
    const s = t.client.localState();
    t.run(() => t.client.state.lastErrorCode === 'move_unsaved', 400);
    if (s && t.client.state.lastErrorCode === 'move_unsaved') {
      // Not sent, and out of the journal again.
      expect((t.keeper.journalFor(URL, t.client.state.matchId!) as JournalEntry[]).map((e) => e.seq)).toEqual([2]);
      expect(t.host.game === null || t.host.game.actionLog.slice(before).every((e) => e.seat !== 0 || e.source !== 'player')).toBe(true);
    }
  });
});
