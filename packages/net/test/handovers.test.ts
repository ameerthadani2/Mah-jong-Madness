/**
 * The table counts the seat's moves from one device to another (`welcome.handovers`), and every welcome says the count.
 * A phone that took the seat back from another device is told so by its welcome (`elsewhere`), but that one frame can be
 * lost: with a link that breaks before it arrives, or with an app that stops first. The count comes again in every later
 * welcome, so the phone still learns that the moves credited to the player meanwhile may be the other device's. Without
 * it, a phone that keeps the app's journal of moves would take that device's moves for ones forged in the player's name,
 * and an honest table would go red.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules } from '@mjm/engine';
import { caveatKey, failureKey, LoopbackHub, TableClient, TableHost, transportLink, type HostMessage, type Link, type SerializedClient } from '../src/index';
import { seededDeals } from './support';

// The same deals every run.
seededDeals();

const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

/** A table on a fake clock; links whose frames a test may lose (`lose(m)` true: the frame never reaches the phone). */
function table(code: string) {
  let now = 9_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, matchId: `m-${code}`, now: () => now, botDelayMs: 400, schedule: (fn, ms) => void timers.push({ at: now + ms, fn }), intermissionSeconds: 3 });
  let n = 0;
  const open = (lose: (m: HostMessage) => boolean = () => false): Link => {
    const base = transportLink(hub.create(`p${n++}`), 'host');
    return { ...base, onMessage: (cb) => base.onMessage((m) => (lose(m as HostMessage) ? undefined : cb(m))) };
  };
  const clientOpts = (journal: unknown[]) => ({ now: () => now, monotonic: () => now, writeAhead: (e: unknown) => void journal.push(e) });
  const t = {
    host,
    open,
    clientOpts,
    /** Who plays: each client makes the move its screen offers 600 ms after it is shown a decision. */
    players: [] as TableClient[],
    owed: new Map<TableClient, { key: string; since: number }>(),
    step() {
      now += 100;
      for (const x of timers.filter((y) => y.at <= now)) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
      host.tick();
      for (const c of t.players) {
        const s = c.localState();
        if (!s || c.state.kicked || legalActions(s, 0).length === 0) continue;
        const key = `${s.handNumber}:${s.turnCounter}`;
        const o = t.owed.get(c);
        if (!o || o.key !== key) t.owed.set(c, { key, since: now });
        else if (o.since >= 0 && now - o.since >= 600) {
          t.owed.set(c, { key, since: -1 });
          c.act(chooseAction(s, 0)!);
        }
      }
    },
    run(until: () => boolean, limit = 6000) {
      for (let i = 0; i < limit && !until(); i++) t.step();
    },
    mine: () => (host.game ? host.game.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length : 0),
  };
  return t;
}

const hand0 = (c: TableClient) => c.state.audits.filter((a) => a.audit.handNumber === 0).map((a) => ({ status: a.status, failures: a.failures.map((f) => failureKey(f) ?? f), caveats: a.caveats.map((x) => caveatKey(x) ?? x) }));

/**
 * The player's phone plays part of hand 0 and saves its record; the app stops; the player plays on from another device
 * (`moves` moves); then the phone comes back from its record and its journal. `loseFirstWelcome`: the welcome of the
 * phone's first link back never arrives (the link breaks), and it joins again on a second link.
 */
function otherDeviceThenBack(code: string, loseFirstWelcome: boolean) {
  const t = table(code);
  const journal: unknown[] = [];
  const phone = new TableClient(t.open(), 'A', undefined, {}, t.clientOpts(journal));
  t.players = [phone];
  phone.join();
  t.host.start();
  t.run(() => t.mine() >= 2 && t.host.game !== null && legalActions(t.host.game, 0).length === 0);
  const rec = JSON.parse(JSON.stringify(phone.serialize())) as SerializedClient;
  // The app stops: its link goes with it.
  t.players = [];
  (phone as unknown as { link: Link }).link.close();
  // The player opens the table on another phone, with the seat's token, and plays two of its turns there.
  const other = new TableClient(t.open(), 'A', undefined, { token: rec.state.token ?? undefined }, { now: () => 0 });
  t.players = [other];
  other.join();
  const before = t.mine();
  t.run(() => t.mine() >= before + 2 || t.host.phase !== 'playing');
  t.players = [];
  (other as unknown as { link: Link }).link.close();
  // Back on the first phone, from its record and its journal.
  const opts = { ...t.clientOpts(journal), journal: journal.slice() };
  let first = loseFirstWelcome;
  // The link breaks before the welcome arrives: nothing the table sends on it reaches the phone.
  const lostLink = t.open(() => first);
  const back = TableClient.restore(rec, lostLink, 'A', undefined, { token: rec.state.token ?? undefined }, opts);
  back.join();
  if (loseFirstWelcome) {
    // The link breaks before the welcome arrived; the session joins again on a new one, with the same client.
    first = false;
    lostLink.close();
    back.rebind(t.open());
    back.join();
  }
  t.players = [back];
  t.run(() => t.host.phase !== 'playing');
  for (let i = 0; i < 40; i++) t.step();
  return { back, otherMoved: t.mine() > before };
}

describe('the table counts the seat\'s moves between devices', () => {
  it('every welcome says the count: one more for each device that takes the seat from another', () => {
    const t = table('HC1');
    const seen: number[] = [];
    const watch = (): Link => t.open((m) => (m.t === 'welcome' && seen.push(m.handovers ?? -1), false));
    const a = new TableClient(watch(), 'A', undefined, {}, { now: () => 0 });
    a.join();
    const token = a.state.token!;
    // The same device joining again: no move.
    a.rebind(watch());
    a.join();
    // Another device, then the first again.
    const b = new TableClient(watch(), 'A', undefined, { token }, { now: () => 0 });
    b.join();
    a.rebind(watch());
    a.join();
    expect(seen).toEqual([0, 0, 1, 2]);
  });
});

describe('a phone back from another device learns it from the count when the welcome that said so was lost', () => {
  it('an honest table: the other device\'s moves are amber (another device held the seat), not red', () => {
    const { back, otherMoved } = otherDeviceThenBack('HC2', true);
    expect(otherMoved).toBe(true);
    const v = hand0(back);
    expect(v.map((x) => x.status)).toEqual(['partial']);
    expect(v[0].caveats).toContain('otherDevice');
  });

  it('the same with the welcome that says so arriving (control)', () => {
    const { back } = otherDeviceThenBack('HC3', false);
    expect(hand0(back).map((x) => x.status)).toEqual(['partial']);
  });

  it('the count is saved with the record: a client restored from it compares with what it last took', () => {
    const t = table('HC4');
    const a = new TableClient(t.open(), 'A', undefined, {}, { now: () => 0 });
    a.join();
    expect(a.serialize().handovers).toBe(0);
    const b = new TableClient(t.open(), 'A', undefined, { token: a.state.token! }, { now: () => 0 });
    b.join();
    expect(b.serialize().handovers).toBe(1);
  });
});
