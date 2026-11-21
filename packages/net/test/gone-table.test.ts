/**
 * A table the server said was gone, and the same account seated there again.
 *
 * The app keeps its record of such a table for a while, under the room and the match, and a client for that room takes
 * it up (`TableClient.fromArchive`) when the table's welcome names the record's match: a move the server forged in the
 * player's name before it said the table was gone is then judged as after a plain reconnect. A welcome that names another
 * match is another table under the same room code: the record is not taken up there, and the client goes on as one that
 * joined with nothing. A device that comes to a hand part-way with no record has not watched the moves credited to its
 * seat before it was first shown the hand: like the moves of a hand it missed, they keep the end of the match from being
 * shown as verified.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chooseAction, legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { caveatKey, failureKey, LoopbackHub, TableClient, TableHost, transportLink, type SerializedClient } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const USER = 'u-victim';
type HostInside = { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action; verifiedUserIds: boolean; seats: Array<{ userId?: string; token?: string }> };
const inside = (w: Wire) => w.host as unknown as HostInside;
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;
const restore = TableClient.restore;
afterEach(() => {
  TableClient.restore = restore;
});

/**
 * Normal, one hand, a server-hosted table (the account takes its own seat back without the token). Half a second into the
 * seat's third discard turn the server plays a legal discard the seat would not make, as the player's own (`forge`). Once
 * the phone has been shown two turns after it, the link drops and the app is told the table is gone: it keeps the record
 * its client holds then. Five seconds later the account sits at the table again: `back`, the same client (a plain
 * reconnect, the control); `kept`, a client that takes up the kept record; `none`, a client with no record and no token.
 */
function goneThenBack(code: string, mode: 'back' | 'kept' | 'none', forge = true) {
  let target: number | null = null;
  let forged = false;
  let gone = false;
  let backAt: number | null = null;
  let kept: SerializedClient | null = null;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 3_000,
    asleep: () => gone,
    onTick: (w) => {
      const g = w.host.game;
      if (backAt !== null && w.clock.now >= backAt) {
        backAt = null;
        gone = false;
        if (mode === 'back') return void w.reconnect();
        // The account comes back to the room: with the kept record, or with nothing.
        TableClient.restore = (_saved: unknown, link, name, avatar, _identity, opts) =>
          mode === 'kept' ? TableClient.fromArchive(kept, link, name, avatar, { userId: USER }, opts) : new TableClient(link, name, avatar, { userId: USER }, opts);
        try {
          w.restart();
        } finally {
          TableClient.restore = restore;
        }
        return;
      }
      if (!g || w.host.phase !== 'playing' || gone || kept) return;
      if (target === null) {
        if (!w.discardTurn() || !w.current() || mine(w) < 2 || w.clock.now - (w.shown.get(g.turnCounter) ?? Infinity) < 500) return;
        const timeout = inside(w).timeoutAction(g, 0);
        const move = legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
        if (!move) return;
        target = g.turnCounter;
        if (forge) {
          forged = true;
          inside(w).apply(0, move, 'player');
        }
        return;
      }
      if ((w.c.state.view?.turnCounter ?? -1) < target + 2 || w.owes()) return;
      // The link drops, and the app is told the table is gone: it keeps what its client holds now.
      kept = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
      w.line.close();
      w.pendingReconnectAt = null;
      gone = true;
      backAt = w.clock.now + 5_000;
    },
  });
  inside(w).verifiedUserIds = true;
  inside(w).seats[0].userId = USER;
  for (let k = 0; k < 40_000 && !w.c.state.matchOver; k++) w.step();
  need(kept !== null && (forged || !forge));
  const a = w.c.state.audits.find((x) => x.audit.handNumber === 0);
  return { w, hand: a ? { status: a.status, keys: [...new Set(a.failures.map(failureKey))], caveats: a.caveats.map(caveatKey) } : null, verified: w.c.state.matchEndVerified, over: w.c.state.matchOver };
}

describe('a table said to be gone, and the account seated there again', () => {
  it('with the kept record: a move forged in the player\'s name before the drop is red, and the end is not verified (it was amber and verified)', () =>
    scenario((i) => {
      const r = goneThenBack(`GTK${i}`, 'kept');
      expect(r.over).toBe(true);
      expect(r.hand?.status).toBe('failed');
      expect(r.hand?.keys).toContain('moveInvented');
      expect(r.verified).toBe(false);
    }));

  it('control: the same client reconnecting, red as it always was', () =>
    scenario((i) => {
      const r = goneThenBack(`GTB${i}`, 'back');
      expect(r.hand?.status).toBe('failed');
      expect(r.hand?.keys).toContain('moveInvented');
      expect(r.verified).toBe(false);
    }));

  it('with no record: amber (joined part-way), and the end is not shown as verified, since the seat moved before the device was shown the hand', () =>
    scenario((i) => {
      const r = goneThenBack(`GTN${i}`, 'none');
      expect(r.over).toBe(true);
      expect(r.hand?.status).toBe('partial');
      expect(r.hand?.caveats).toContain('joined');
      expect(r.verified).toBe(false);
    }));

  it('what it costs an honest table: the kept record is taken up and nothing is red; with no record, the end is not verified', () =>
    scenario((i) => {
      const kept = goneThenBack(`GHK${i}`, 'kept', false);
      expect(kept.over).toBe(true);
      expect(kept.hand?.status).not.toBe('failed');
      const none = goneThenBack(`GHN${i}`, 'none', false);
      expect(none.hand?.status).toBe('partial');
      expect(none.hand?.caveats).toContain('joined');
      expect(none.verified).toBe(false);
    }));
});

describe('a kept record at a table whose welcome names another match', () => {
  /**
   * The room's code went to a new table (codes are used again once a table is gone), whose match the account is seated in
   * part-way (it holds a seat there by its account). The phone's kept record is for the old table's match.
   */
  function reused(code: string) {
    const rules = withRules({ handsPerMatch: 4, turnSeconds: 15, timeBankSeconds: 30 });
    const clock = { now: 1_000_000 };
    const opts = { now: () => clock.now };
    // The old table: its first hand under way when the record was kept (it holds the end of no hand: `have` -1).
    const hubA = new LoopbackHub();
    const a = new TableHost(hubA.create('host'), { roomCode: code, rules, matchId: `m-old-${code}`, now: () => clock.now, intermissionSeconds: 5 });
    const ca = new TableClient(transportLink(hubA.create('pa'), 'host'), 'Victim', undefined, { userId: USER }, opts);
    ca.join();
    a.start();
    playOut(a, ca, clock, () => a.phase === 'playing' && a.game!.turnCounter >= 6);
    need(a.phase === 'playing' && ca.state.view?.handNumber === 0);
    const kept = JSON.parse(JSON.stringify(ca.serialize())) as SerializedClient;
    a.close();
    // The new table under the same code: the account sat down there on another device, played two hands, and dropped.
    const hubB = new LoopbackHub();
    const b = new TableHost(hubB.create('host'), { roomCode: code, rules, matchId: `m-new-${code}`, verifiedUserIds: true, now: () => clock.now, intermissionSeconds: 5 });
    const cb = new TableClient(transportLink(hubB.create('pb'), 'host'), 'Victim', undefined, { userId: USER }, opts);
    cb.join();
    b.start();
    playOut(b, cb, clock, () => b.phase === 'playing' && b.game!.handNumber === 2);
    need(b.phase === 'playing' && b.game!.handNumber === 2);
    (cb as unknown as { link: { close(): void } }).link.close();
    clock.now += 2_000;
    // This device comes back to the room with the kept record of the old table.
    const c = TableClient.fromArchive(kept, transportLink(hubB.create('pc'), 'host'), 'Victim', undefined, { userId: USER }, opts);
    const sent: Array<{ t?: string; token?: string; have?: number }> = [];
    const send = (c as unknown as { send(m: unknown): void }).send.bind(c);
    (c as unknown as { send(m: unknown): void }).send = (m) => {
      sent.push(m as { t?: string });
      send(m);
    };
    c.join();
    playOut(b, c, clock, () => b.phase === 'match_over');
    return { c, kept, join: sent.find((m) => m.t === 'join') };
  }

  /** The seat plays its own moves (when its client shows it one) on a fake clock until `stop`. */
  function playOut(h: TableHost, c: TableClient, clock: { now: number }, stop: () => boolean) {
    for (let guard = 0; guard < 40_000 && !stop(); guard++) {
      const st = c.localState();
      if (h.phase === 'playing' && st && legalActions(st, 0).length > 0) c.act(chooseAction(st, 0, { seed: 'p' })!);
      else {
        clock.now += 1_000;
        h.tick();
      }
    }
  }

  it('is not taken up: the client joins with the kept token and hands, then goes on as one that joined with nothing, and nothing the new table sends in answer is red', () =>
    scenario((i) => {
      const r = reused(`RU${i}`);
      // The join said what the kept record holds.
      expect(r.join?.token).toBe(r.kept.state.token);
      expect(r.join?.have).toBe(-1);
      // Nothing of the old match is on show, and no hand of the new one is red.
      expect(r.c.state.matchId).toBe(`m-new-RU${i}`);
      expect(r.c.state.audits.some((a) => a.audit.matchId === `m-old-RU${i}`)).toBe(false);
      expect(r.c.state.audits.filter((a) => a.status === 'failed')).toEqual([]);
      expect(r.c.state.matchFailed).toBe(false);
    }));
});
