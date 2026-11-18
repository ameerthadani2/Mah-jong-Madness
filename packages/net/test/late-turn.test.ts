/**
 * A server that wants to cut a seat's turn short without failing the hand can hold back the state
 * that shows the seat its turn, and keep the link looking alive meanwhile with pongs and clock
 * frames whose stamps creep forward a millisecond at a time, or run slow; or it can delay all it
 * sends, under honest stamps. The phone measures the table's stamps against its own clock (the
 * least arrival offset seen since the table's clock began), so stamps that fall behind count as
 * silence: the link is dropped, and the time without it is judged as a drop. And it judges the
 * state that first showed the seat each move: on a link it already held, that state must give the
 * whole turn clock by its own deadline and stamp; on a live link it may reach the phone at most
 * 17 s late; later than that, or later than the round trips of the seat's own moves allow, the
 * table's move is judged as made while the seat had no link (amber at best). A turn skipped on a
 * link that stayed open fails. Honest links that are slow, stall or slow down for good, phones
 * that sleep, and servers whose wall clock is set back, stay green.
 */
import { describe, expect, it, vi } from 'vitest';
import { chooseAction, legalActions, withRules, type Action, type GameState } from '@mjm/engine';
import { caveatKey, CLOCK_FRAME_MS, LoopbackHub, SILENT_ANSWER_MS, TableClient, TableHost, transportLink, type HostMessage, type SerializedClient } from '../src/index';
import { LATE_MS } from '../src/clientclock';
import type { PlayRecord, SeenState } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { holdTurn, stampOf, T0, wire, type Line, type Wire } from './wire';

type StateMsg = Extract<HostMessage, { t: 'state' }>;

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
/** The longest a link whose stamps stand still stays up while the watch runs once a second. */
const SILENT_BOUND = 2 * CLOCK_FRAME_MS + 2_000 + SILENT_ANSWER_MS + 1_000;
const green = (w: Wire) => expect(w.verdict()).toEqual({ status: 'ok', failures: [], caveats: [] });

describe('held frames: stamps that crawl while the turn state is held', () => {
  for (const all of [false, true]) {
    it.each([25_000, 40_000, 44_000])(`a hold of %i ms, the clock frames and pongs crawling a millisecond at a time${all ? ', every other frame held too' : ''}: the link is dropped, and the hand is amber`, (ms) =>
      scenario((i) => {
        const h = holdTurn({ code: `CR${ms}${all}${i}`, think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600) }, { all });
        need(h.arm());
        const from = h.w.clock.now;
        h.w.until(() => h.w.clock.now - from >= ms);
        need(h.w.host.phase === 'playing');
        h.release();
        h.w.finish();
        need(h.w.judged().includes(h.st.heldTc));
        expect(h.w.drops.length).toBeGreaterThan(0);
        expect(h.w.drops[0] - from).toBeLessThanOrEqual(SILENT_BOUND);
        const v = h.w.verdict();
        expect(v.status).toBe('partial');
        // The table played for the seat with its link down (a 25 s hold: the turn comes first on the new link), or on a
        // turn that reached the phone too late for its stamp to be believed (40 s and more): either is said, as it was.
        expect(v.caveats).toEqual(expect.arrayContaining([ms < 40_000 ? 'tableMoved' : 'tableMovedLate']));
      }),
    );
  }

  it('inside the bound: a 12 s hold released with its own stamp, the seat timed out, is green', () =>
    scenario((i) => {
      const h = holdTurn({ code: `CB12${i}`, think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600) });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 12_000);
      h.release();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      green(h.w);
    }));

  it('past the bound: an 18 s hold released with its own stamp, the seat timed out, is not green', () =>
    scenario((i) => {
      const h = holdTurn({ code: `CB18${i}`, think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600) });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 18_000);
      h.release();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.verdict().status).not.toBe('ok');
      expect(h.w.verdict().caveats).toContain('tableMoved');
    }));

  const slow = (base: number, _k: number, since: number, now: number) => base + 0.9 * (now - since);

  it('stamps at 0.9 of real time, the turn state held 40 s and released with its own stamp, the seat moving at once: red lateTurn', () =>
    scenario((i) => {
      const h = holdTurn({ code: `CS9m${i}`, think: (_k, tc) => (tc === h.st.heldTc ? 0 : 600) }, { stamp: slow });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 40_000);
      h.release();
      h.w.finish();
      expect(h.w.drops).toEqual([]);
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['lateTurn'] });
      expect(h.w.c.state.auditFailures).toContain(`The host showed this seat its turn late, on a link that stayed open (turn ${h.st.heldTc})`);
    }));

  for (const after of ['restart', 'kick'] as const) {
    it(`the same hold, the seat moving at once, then ${after === 'kick' ? 'the server says the seat was opened on another device and the user resumes the table from Home 3 s later' : 'the app restarted 2 s after the move'}: still red, lateTurn among its reasons (a turn the seat answered before the restart is judged by the state the saved record kept)`, () =>
      scenario((i) => {
        const h = holdTurn({ code: `CS9${after}${i}`, think: (_k, tc) => (tc === h.st.heldTc ? 0 : 600) }, { stamp: slow });
        need(h.arm());
        const from = h.w.clock.now;
        h.w.until(() => h.w.clock.now - from >= 40_000);
        h.release();
        need(h.w.until(() => h.w.host.game!.turnCounter > h.st.heldTc));
        h.w.step(2_000);
        if (after === 'kick') {
          h.w.line.inject({ t: 'disconnected' });
          h.w.step(3_000);
        }
        h.w.restart();
        h.w.finish();
        expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: expect.arrayContaining(['lateTurn']) });
      }));
  }

  it('stamps at 0.9 of real time, the same hold, the seat timed out: red heldFrame', () =>
    scenario((i) => {
      const h = holdTurn({ code: `CS9i${i}`, think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600) }, { stamp: slow });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 40_000);
      h.release();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));
});

describe('held frames: a turn state released without its time stamp', () => {
  /** The stamp is optional on the wire; an honest host always sends it. */
  const bare = (m: HostMessage): HostMessage => {
    if (m.t !== 'state') return m;
    const { now: _now, ...rest } = m;
    void _now;
    return rest as HostMessage;
  };

  it.each([25_000, 40_000])('the turn state held %i ms on a link that stays open, the clock frames freshly stamped meanwhile, then released without its stamp: red heldFrame when the seat is timed out, red lateTurn when it moves', (ms) =>
    scenario((i) => {
      for (const moves of [false, true]) {
        const h = holdTurn({ code: `NS${ms}${moves}${i}`, think: (_k, tc) => (tc === h.st.heldTc ? (moves ? 1_000 : Infinity) : 600) }, { stamp: (_b, _k, _s, now) => now });
        need(h.arm());
        const from = h.w.clock.now;
        h.w.until(() => h.w.clock.now - from >= ms);
        need(h.w.host.phase === 'playing');
        h.release(bare);
        h.w.finish();
        expect(h.w.drops).toEqual([]);
        if (moves) expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['lateTurn'] });
        else {
          need(h.w.judged().includes(h.st.heldTc));
          expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
        }
      }
    }),
  );
});

describe('held frames: forged pongs', () => {
  it('pongs that echo an old ping, freshly stamped, while the turn state is held 40 s and then released: red heldFrame', () =>
    scenario((i) => {
      const pings: number[] = [];
      const h = holdTurn({
        code: `PO${i}`,
        think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600),
        onTick: (w) => {
          if (h.st.holding && pings.length > 0 && w.clock.now % 2_000 === 0) w.line.inject({ t: 'pong', at: pings[0], now: w.clock.now });
        },
      });
      // The pings the phone sends (the server answers the first one over and over).
      const send = h.w.c.ping.bind(h.w.c);
      h.w.c.ping = () => {
        pings.push(h.w.clock.now);
        send();
      };
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 40_000);
      h.release();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it('the same, with the app restarted 2 s after the release: still red heldFrame (the state came in behind fresher stamps, which the phone noted then and its saved record keeps; the stamps restored with the record are not what fails it)', () =>
    scenario((i) => {
      const pings: number[] = [];
      const h = holdTurn({
        code: `PR${i}`,
        think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600),
        onTick: (w) => {
          if (h.st.holding && pings.length > 0 && w.clock.now % 2_000 === 0) w.line.inject({ t: 'pong', at: pings[0], now: w.clock.now });
        },
      });
      const send = h.w.c.ping.bind(h.w.c);
      h.w.c.ping = () => {
        pings.push(h.w.clock.now);
        send();
      };
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 40_000);
      h.release();
      need(h.w.host.game!.turnCounter === h.st.heldTc);
      h.w.step(2_000);
      h.w.restart();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it('pongs that echo an old ping, stamped at the crawl: the link is dropped, and the hand is amber', () =>
    scenario((i) => {
      const h = holdTurn({
        code: `PC${i}`,
        think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600),
        onTick: (w) => {
          if (h.st.holding && w.clock.now % 2_000 === 0) w.line.inject({ t: 'pong', at: h.st.since, now: h.crawl() });
        },
      });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 40_000);
      h.release();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.drops.length).toBeGreaterThan(0);
      expect(h.w.verdict()).toMatchObject({ status: 'partial' });
      expect(h.w.verdict().caveats).toContain('tableMovedLate');
    }));
});

describe('clock: the state that starts a turn must give the whole turn clock', () => {
  const nearly = (base: number, _k: number, since: number, now: number) => base + 0.99 * (now - since);

  it('stamps at 0.99 of real time, the turn state held 12 s and released re-stamped to the crawl, its deadline untouched, the seat moving at once: red lateTurn', () =>
    scenario((i) => {
      const h = holdTurn({ code: `AR${i}`, think: (_k, tc) => (tc === h.st.heldTc ? 0 : 600) }, { stamp: nearly });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 12_000);
      h.release((m) => (m.t === 'state' ? { ...m, now: h.crawl() } : m));
      h.w.finish();
      expect(h.w.drops).toEqual([]);
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['lateTurn'] });
    }));

  it('the same, with the deadline moved as far as the stamp and the seat timed out: red playedEarly', () =>
    scenario((i) => {
      const h = holdTurn({ code: `AS${i}`, think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600) }, { stamp: nearly });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 12_000);
      h.release((m) => {
        if (m.t !== 'state') return m;
        const now = h.crawl();
        return { ...m, now, deadline: m.deadline === null ? null : m.deadline + (now - (m.now ?? now)) };
      });
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('an honest host whose process stands still 2 s while it writes the broadcast that starts a seat’s turn (a garbage-collection pause): the state still gives exactly the turn clock, and the hand is green', () =>
    scenario((i) => {
      // Two players, at seats 0 and 1 (the victim), and two bots; a network with no delay. The host keeps
      // time by a clock that never steps back; in the broadcast that starts the victim's second turn, the
      // process stands still 2 s right after it wrote seat 0's frame, before it builds the victim's.
      const clock = { now: T0 };
      const hub = new LoopbackHub();
      const ht = hub.create('host');
      const host = new TableHost(ht, { roomCode: `GC${i}`, rules: withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 }), now: () => clock.now, matchId: `m-GC${i}` });
      const game = () => (host as unknown as { game: GameState | null }).game;
      const owes = (seat: number) => host.phase === 'playing' && !!game() && legalActions(game()!, seat).length > 0;
      let turns = 0;
      let shownOwing = false;
      let stalled = false;
      const gaps: number[] = [];
      const send = ht.send.bind(ht);
      ht.send = (to, msg) => {
        const m = msg as HostMessage;
        send(to, msg);
        if (m.t !== 'state') return;
        if (to === 'p0' && owes(1) && !shownOwing && ++turns === 2) {
          stalled = true;
          clock.now += 2_000;
        }
        if (to === 'p1') {
          if (owes(1) && !shownOwing && typeof m.now === 'number' && m.deadline !== null) gaps.push(m.deadline - m.now);
          shownOwing = owes(1);
        }
      };
      const players = [0, 1].map((seat) => new TableClient(transportLink(hub.create(`p${seat}`), 'host'), `P${seat}`, undefined, {}, { now: () => clock.now }));
      players.forEach((c, seat) => c.join(seat));
      host.start();
      const acted = [-1, -1];
      const since = [0, 0];
      for (let g = 0; g < 20_000 && host.phase === 'playing'; g++) {
        clock.now += 500;
        host.tick();
        players.forEach((c, seat) => {
          const s = c.localState();
          if (!s || host.phase !== 'playing' || legalActions(s, seat).length === 0 || acted[seat] === s.turnCounter) return;
          if (since[seat] === 0) since[seat] = clock.now;
          if (clock.now - since[seat] < 1_500) return;
          acted[seat] = s.turnCounter;
          since[seat] = 0;
          c.act(chooseAction(s, seat, { seed: 'p' })!);
        });
      }
      need(stalled && host.phase === 'hand_over' && players[1].state.lastResult !== null);
      expect(gaps.length).toBeGreaterThanOrEqual(2);
      expect(new Set(gaps)).toEqual(new Set([15_000]));
      expect(players[1].state.auditFailures).toEqual([]);
      expect(players[1].state.auditStatus).toBe('ok');
    }));
});

describe('held frames: a turn skipped on a link that stays open', () => {
  /** The server never sends the states `skip` picks (the clock frames meanwhile carry the turn before); the seat is timed out of that turn. */
  function skipped(code: string, skip: (w: Wire, m: Extract<HostMessage, { t: 'state' }>) => boolean, arm: (w: Wire) => boolean) {
    let armed = false;
    let tc = -1;
    let done = false;
    const w: Wire = wire({
      code,
      think: (_k, t) => (t === tc ? Infinity : 600),
      map: (m) => {
        if (!armed || done) return m;
        const g = w.host.game!;
        if (tc < 0 && m.t === 'state' && g.turnCounter === m.view.turnCounter && skip(w, m)) tc = m.view.turnCounter;
        if (tc < 0) return m;
        if (g.turnCounter > tc) {
          done = true;
          return m;
        }
        if (m.t === 'state') return null;
        return m.t === 'clock' ? { ...m, tc: tc - 1 } : m;
      },
    });
    armed = arm(w);
    w.finish();
    return { w, tc: () => tc };
  }

  it('a discard turn: red heldFrame', () =>
    scenario((i) => {
      const s = skipped(`SK${i}`, (w) => w.discardTurn(), (w) => w.toDiscard(2));
      need(s.tc() >= 0 && s.w.judged().includes(s.tc()));
      expect(s.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it('a claim window offering a Pong, a Chow or a Kong: red heldFrame', () =>
    scenario((i) => {
      const s = skipped(
        `SC${i}`,
        (w) => w.host.game!.phase === 'claim' && legalActions(w.host.game!, 0).some((a) => a.type !== 'pass' && a.type !== 'hu'),
        (w) => w.toDiscard(1),
      );
      need(s.tc() >= 0 && s.w.judged().includes(s.tc()));
      expect(s.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  /** Every state and clock frame of hand `hand` is kept off the link until the table has played for the seat. */
  function opening(code: string, hand: number) {
    let done = false;
    const w: Wire = wire({
      code,
      rules: withRules({ handsPerMatch: hand + 1, turnSeconds: 15, timeBankSeconds: 30 }),
      map: (m) => {
        if (done || (m.t !== 'state' && m.t !== 'clock') || w.host.game?.handNumber !== hand) return m;
        if (w.tableMoves().length === 0) return null;
        done = true;
        return m;
      },
    });
    for (let g = 0; g < 7_200 && !(w.host.phase === 'playing' && w.host.game?.handNumber === hand); g++) w.step();
    w.finish();
    return { w, done: () => done };
  }

  it('the opening of the match, on the link this device revealed its share over: red heldFrame', () =>
    scenario((i) => {
      const o = opening(`SO${i}`, 0);
      need(o.done());
      expect(o.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it('the opening of the next hand, on the link that brought the hand before it: red heldFrame', () =>
    scenario((i) => {
      const o = opening(`SN${i}`, 1);
      need(o.done() && o.w.c.state.audits.length === 2 && o.w.c.state.audits[0].status === 'ok');
      expect(o.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));
});

describe('clock: a delay present from the start', () => {
  /** Every stamped frame waits `ms` from the first state of the match on (the ceremony before it is prompt); the seat moves on two turns in three. */
  function delayed(code: string, ms: number) {
    let on = false;
    const w = wire({
      code,
      think: (k) => (k % 3 === 0 ? Infinity : 800),
      delay: (m) => {
        if (m.t === 'state') on = true;
        return on && stampOf(m) !== undefined ? ms : 0;
      },
    });
    w.finish();
    return w;
  }

  it('25 s from the start: amber, the table played for the seat and its turn was shown late, never green', () =>
    scenario((i) => {
      const w = delayed(`DL25${i}`, 25_000);
      need(w.judged().length > 0);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
      // The link never dropped, and the player is not told it did: not 'tableMoved', and no claim passed 'while the connection was down'.
      expect(w.drops).toEqual([]);
      expect(w.verdict().caveats).not.toContain('tableMoved');
      for (const k of ['passedPong', 'passedChow', 'passedKong']) expect(w.verdict().caveats).not.toContain(k);
      expect(w.c.state.claimsPassedAway.every((p) => p.late === true)).toBe(true);
    }));

  it('25 s from the start, claims the table passed for the seat: named as passed on a turn that reached the phone late, and counted so over the match, across an app restart', () =>
    scenario((i) => {
      const w = delayed(`DC25${i}`, 25_000);
      const passed = w.c.state.claimsPassedAway;
      need(passed.length > 0);
      expect(w.drops).toEqual([]);
      expect(passed.every((p) => p.late === true)).toBe(true);
      const named = { pong: 'passedPongLate', chow: 'passedChowLate', kong: 'passedKongLate' } as const;
      for (const k of new Set(passed.map((p) => p.claim))) expect(w.verdict().caveats).toContain(named[k]);
      const saved = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
      const back = TableClient.restore(saved, transportLink(new LoopbackHub().create('elsewhere'), 'host'), 'Victim', undefined, { token: saved.state.token ?? undefined });
      expect(back.state.claimsPassedAway).toEqual(passed);
      // Anything but `true` in a saved record reads as a claim passed while the link was down.
      saved.state.claimsPassedAway = passed.map((p) => ({ ...p, late: 'yes' as unknown as boolean }));
      const odd = TableClient.restore(saved, transportLink(new LoopbackHub().create('odd'), 'host'), 'Victim', undefined, { token: saved.state.token ?? undefined });
      expect(odd.state.claimsPassedAway.some((p) => 'late' in p)).toBe(false);
    }));

  it.each([15_000, 19_000])('%i ms from the start: green', (ms) =>
    scenario((i) => {
      const w = delayed(`DL${ms}${i}`, ms);
      need(w.judged().length > 0);
      green(w);
    }),
  );

  /** The server waits for the seat's commitment and secret however late they come (as a server may). */
  const waitForShare = (seat: number) => (w: Wire) => {
    const h = w.host as unknown as { phase: string; deadline: number | null; seats: Array<{ commit?: string; secret?: string }>; now: () => number };
    const s = h.seats[seat];
    if (((h.phase === 'commit' && !s.commit) || (h.phase === 'reveal' && !s.secret)) && h.deadline !== null) h.deadline = Math.max(h.deadline, h.now() + 5_000);
  };

  /**
   * The same delay, with the stamp of the match's first stamped frame, the deal (the answer to this
   * device's share), moved back `back` ms, so that the fixed point the deal makes would cancel the
   * delay; at seat `seat`, over a match of `hands` (the server waits for the seat's late shares).
   */
  function backdated(code: string, ms: number, back: number, seat: number, hands = 1) {
    let on = false;
    let moved = false;
    const w = wire({
      code,
      seat,
      rules: withRules({ handsPerMatch: hands, turnSeconds: 15, timeBankSeconds: 30 }),
      think: (k) => (k % 3 === 0 ? Infinity : 800),
      map: (m) => {
        const s = stampOf(m);
        if (moved || s === undefined) return m;
        moved = true;
        return { ...m, now: s - back } as HostMessage;
      },
      delay: (m) => {
        if (m.t === 'state') on = true;
        return on && stampOf(m) !== undefined ? ms : 0;
      },
      onTick: waitForShare(seat),
    });
    for (let g = 0; g < 7_200 * hands && !w.c.state.matchOver; g++) w.step();
    return w;
  }
  const byTable = (w: Wire, seat: number, a: { audit: { log: Array<{ seat: number; source?: string }> } }) => a.audit.log.some((e) => e.seat === seat && e.source !== 'player');

  it.each([1, 2, 3])('seat %i: 25 s from the start, the deal stamped 25 s back so that its fixed point would cancel the delay: amber, never green', (seat) =>
    scenario((i) => {
      const w = backdated(`DB${seat}${i}`, 25_000, 25_000, seat);
      need(w.c.state.audits.length === 1 && w.judged().length > 0);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
    }),
  );

  it('seat 0, the dealer: the same over two hands, the second measured against the first hand’s fixed points: amber in both, never green', () =>
    scenario((i) => {
      const w = backdated(`DB0${i}`, 25_000, 25_000, 0, 2);
      const audits = w.c.state.audits;
      need(audits.length >= 2 && audits.every((a) => byTable(w, 0, a)));
      for (const a of audits) {
        expect(a.status).toBe('partial');
        expect(a.caveats.map(caveatKey)).toContain('lateShown');
      }
    }));

  it('seat 1, 25 s from the start: a move the seat sent again after the table had played its first copy, the second dropped unanswered, counts from its first copy: amber, never green', () =>
    scenario((i) => {
      const seat = 1;
      let on = false;
      let last: string | null = null;
      let dropped = 0;
      const w = wire({
        code: `DM${i}`,
        seat,
        rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
        delay: (m) => {
          if (m.t === 'state') on = true;
          return on && stampOf(m) !== undefined ? 25_000 : 0;
        },
        onTick: waitForShare(seat),
      });
      // The server plays a late move on the seat's next turn when it is legal there (as an honest table
      // does), and drops a second copy of the move it just played without a word (no honest table does):
      // the log then credits the seat with a move this device sent twice, the second time after the
      // table had played the first.
      const h = w.host as unknown as { handle: (from: string, msg: unknown) => void; game: GameState | null; phase: string; seats: Array<{ peerId: string | null }> };
      const handle = h.handle.bind(w.host);
      h.handle = (from, msg) => {
        const m = msg as { t?: string; action?: Action };
        if (m?.t === 'action' && from === h.seats[seat].peerId && h.phase === 'playing' && h.game) {
          const key = JSON.stringify(m.action);
          if (!legalActions(h.game, seat).some((a) => JSON.stringify(a) === key)) {
            if (key === last) return void dropped++;
          } else last = key;
        }
        handle(from, msg);
      };
      for (let g = 0; g < 7_200 * 2 && !w.c.state.matchOver; g++) w.step();
      const audits = w.c.state.audits;
      need(dropped > 0 && audits.length >= 2 && audits.every((a) => byTable(w, seat, a)));
      for (const a of audits) expect(a.status).not.toBe('ok');
    }));

  it('seat 1, which makes no move of its own, 25 s from the start: amber, and still amber when the server asks for its share again, a second before the deal reaches the phone, a second after, or on a new link once the deal has been shown (the share’s fixed point is measured from the first time it was sent)', () =>
    scenario((i) => {
      for (const again of [null, 'beforeDeal', 'afterDeal', 'newLink'] as const) {
        /** When the host sent the deal. */
        let dealt: number | null = null;
        let asked = false;
        const w = wire({
          code: `DA${again}${i}`,
          seat: 1,
          think: () => Infinity,
          delay: (m, now) => {
            if (m.t === 'state' && dealt === null) dealt = now;
            return dealt !== null && stampOf(m) !== undefined ? 25_000 : 0;
          },
          onTick: (w) => {
            // No honest server asks again for a share over the link that brought it, nor once it has dealt from it.
            if (again === null || again === 'newLink' || asked || dealt === null || !w.host.game) return;
            const at = again === 'beforeDeal' ? dealt + 24_000 : (w.shown.get(0) ?? Infinity) + 1_000;
            if (w.clock.now < at) return;
            asked = true;
            w.line.inject({ t: 'reveal_request', handNumber: w.host.game.handNumber });
          },
          onReconnect: (w) => {
            if (again !== 'newLink' || asked || !w.host.game) return;
            asked = true;
            w.line.inject({ t: 'reveal_request', handNumber: w.host.game.handNumber });
          },
        });
        if (again === 'newLink') {
          // The link ends a second after the phone was shown the deal; the server asks again on the next one.
          w.dealt();
          w.until(() => w.shown.has(0) && w.clock.now >= w.shown.get(0)! + 1_000);
          w.dropNow(1_000);
        }
        w.finish();
        need(w.judged().length > 0 && asked === (again !== null));
        expect(w.verdict().status).toBe('partial');
        expect(w.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
      }
    }));

  it('seat 0 or 1, idle or making its own moves, 25 s from the start through the server’s own relay, which drops the link before the deal reaches the phone and asks for the share again on the next link, half a second before the deal arrives there: amber in both hands, and the second hand’s late turns are counted (the share’s fixed point stays where it first went out, on any link)', () =>
    scenario((i) => {
      for (const seat of [0, 1]) for (const think of [Infinity, 1_200]) {
        const Q: Array<{ at: number; m: HostMessage }> = [];
        let dealt: number | null = null;
        let dropped = false;
        let asked = false;
        const w = wire({
          code: `DN${seat}${think}${i}`,
          seat,
          rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
          think: () => think,
          // The relay: every frame is held 25 s, and goes out on whatever link is up then (a lost link's frames too).
          map: (m, w) => {
            if (m.t === 'state' && dealt === null) dealt = w.clock.now;
            Q.push({ at: Math.max(w.clock.now + 25_000, Q.length ? Q[Q.length - 1].at : 0), m });
            return null;
          },
          onTick: (w) => {
            // The server waits for the phone's commitment and share, which it asked for 25 s late.
            waitForShare(seat)(w);
            if (!dropped && dealt !== null && w.clock.now >= dealt + 2_000) {
              dropped = true;
              w.dropNow(1_000);
              return;
            }
            if (w.pendingReconnectAt !== null) return;
            const next = Q.find((e) => e.m.t === 'state');
            if (dropped && !asked && next?.m.t === 'state' && next.m.view.handNumber === 0 && w.clock.now >= next.at - 500) {
              asked = true;
              w.line.inject({ t: 'reveal_request', handNumber: 0 });
            }
            while (Q.length && Q[0].at <= w.clock.now) w.line.inject(Q.shift()!.m);
          },
        });
        for (let e = 0; e < 1_200_000 && w.c.state.audits.length < 2 && !w.c.state.matchOver; e += 500) w.step();
        need(asked && w.c.state.audits.length >= 2);
        for (const a of w.c.state.audits) expect(a.status).toBe('partial');
        const second = w.c.state.turnsShownLate.find((r) => r.hand === 1);
        expect(second?.late.length ?? 0).toBeGreaterThan(0);
      }
    }));

  it('an honest host that seats the phone again on a new link while the phone’s share is still on its way over the old one, and so asks for the share again and deals there: the hand is amber for the lost link only, as before, and the next hand green', () =>
    scenario((i) => {
      for (const seat of [0, 1]) {
        let lost = false;
        let asks = 0;
        const w = wire({
          code: `DL${seat}${i}`,
          seat,
          rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
          think: (k) => (k % 3 === 0 ? Infinity : 800),
          up: () => 1_000,
          map: (m) => {
            if (m.t === 'reveal_request' && m.handNumber === 0) asks++;
            return m;
          },
          onTick: (w) => {
            // The phone joins again on a new link before the server has noticed the old one is gone: the share
            // sent over the old one never arrives, and the host asks for it again on the new one.
            const sent = w.c.serialize().records.some((r) => r.hand === 0 && r.attempts.some((a) => a.revealed));
            const h = w.host as unknown as { phase: string; seats: Array<{ secret?: string }> };
            if (!lost && h.phase === 'reveal' && !h.seats[seat].secret && sent) {
              lost = true;
              w.reconnect();
            }
          },
        });
        for (let e = 0; e < 1_200_000 && w.c.state.audits.length < 2 && !w.c.state.matchOver; e += 500) w.step();
        need(lost && asks >= 2 && w.c.state.audits.length >= 2);
        expect(w.c.state.audits.map((a) => a.status)).toEqual(['partial', 'ok']);
        expect(w.c.state.audits[0].caveats.map(caveatKey)).toEqual(['linkLost']);
      }
    }));

  it('an honest round trip, 4 s each way from before the deal at seat 2, and a deal stamped 15 s back with a 15 s delay at seat 1: green', () =>
    scenario((i) => {
      const slow = wire({ code: `DH${i}`, seat: 2, think: (k) => (k % 3 === 0 ? Infinity : 800), up: () => 4_000, delay: () => 4_000 });
      slow.finish();
      need(slow.judged().length > 0);
      green(slow);
      const inside = backdated(`DI${i}`, 15_000, 15_000, 1);
      need(inside.judged().length > 0);
      green(inside);
    }));
});

describe('the Fair play count of turns that reached the phone late (never a verdict)', () => {
  const HYPER = withRules({ handsPerMatch: 1, turnSeconds: 4, timeBankSeconds: 0 });
  const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
  /** Every stamped frame `ms` late from the hand's first state, under honest stamps; the seat moves 0.8 s after its phone shows a turn. */
  function slowed(code: string, rules: ReturnType<typeof withRules>, ms: number) {
    let on = false;
    const w = wire({
      code,
      rules,
      think: () => 800,
      delay: (m) => {
        if (m.t === 'state') on = true;
        return on && stampOf(m) !== undefined ? ms : 0;
      },
    });
    w.finish();
    const late = w.c.state.turnsShownLate.reduce((n, r) => n + r.late.length, 0);
    const of = w.c.state.turnsShownLate.reduce((n, r) => n + r.of, 0);
    return { w, late, of };
  }

  it('Hyper, 5 s from the start, inside the 17 s the audit allows: the hand is green and the table plays every turn, and every turn the phone measured is counted', () =>
    scenario((i) => {
      const { w, late, of } = slowed(`FC5${i}`, HYPER, 5_000);
      need(of > 0);
      green(w);
      expect(w.judged().length).toBeGreaterThan(0);
      expect(late).toBe(of);
    }));

  it('Hyper, an honest link: nothing counted', () =>
    scenario((i) => {
      const { w, late, of } = slowed(`FC0${i}`, HYPER, 0);
      need(of > 0);
      green(w);
      expect(late).toBe(0);
    }));

  it('the bar is half the turn clock: 5 s late from the start costs a third of a Normal turn and is not counted; 9 s is', () =>
    scenario((i) => {
      const five = slowed(`FN5${i}`, NORMAL, 5_000);
      need(five.of > 0);
      green(five.w);
      expect(five.late).toBe(0);
      const nine = slowed(`FN9${i}`, NORMAL, 9_000);
      need(nine.of > 0);
      green(nine.w);
      expect(nine.late).toBe(nine.of);
    }));

  it('is kept across an app restart, and a saved count that is not one is dropped', () =>
    scenario((i) => {
      const { w, late, of } = slowed(`FCR${i}`, HYPER, 5_000);
      need(of > 0 && late > 0);
      const saved = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
      const back = TableClient.restore(saved, transportLink(new LoopbackHub().create('elsewhere'), 'host'), 'Victim', undefined, { token: saved.state.token ?? undefined });
      expect(back.state.turnsShownLate).toEqual(w.c.state.turnsShownLate);
      saved.state.turnsShownLate = [{ hand: 0, late: [1, 2, 3], of: 2 }, { hand: 1, late: ['x' as unknown as number], of: 4 }, { hand: 2, late: [5], of: 3 }];
      const odd = TableClient.restore(saved, transportLink(new LoopbackHub().create('odd'), 'host'), 'Victim', undefined, { token: saved.state.token ?? undefined });
      expect(odd.state.turnsShownLate).toEqual([{ hand: 2, late: [5], of: 3 }]);
      // A record saved before the count was kept restores with none.
      delete (saved.state as Partial<typeof saved.state>).turnsShownLate;
      expect(TableClient.restore(saved, transportLink(new LoopbackHub().create('older'), 'host'), 'Victim').state.turnsShownLate).toEqual([]);
    }));
});

describe('clock: a delay held for hours', () => {
  it('from the second hand, every stamped frame slowed by 0.1 s a second up to 18 s and held there: the seat’s turns, 18 s late, are still amber after two hours', () => {
    let start: number | null = null;
    const w = wire({
      code: 'DH18',
      rules: withRules({ handsPerMatch: 60, turnSeconds: 30, timeBankSeconds: 60 }),
      think: () => 800,
      delay: (m, now) => (start === null || stampOf(m) === undefined ? 0 : Math.min(18_000, (now - start) / 10)),
      onTick: (w) => {
        if (start === null && w.c.state.audits.length > 0) start = w.clock.now;
      },
    });
    const ended: Array<{ at: number; status: string; caveats: string[] }> = [];
    for (let g = 0; g < 40_000 && !w.c.state.matchOver && (start === null || w.clock.now < start + 2.2 * 3_600_000); g++) {
      w.step();
      for (const a of w.c.state.audits.slice(ended.length)) ended.push({ at: w.clock.now, status: a.status, caveats: a.caveats.map((c) => caveatKey(c) ?? c) });
    }
    expect(start).not.toBeNull();
    const late = ended.filter((h) => h.at > (start as number) + 3 * 60_000);
    const afterTwoHours = late.filter((h) => h.at > (start as number) + 2 * 3_600_000);
    expect(afterTwoHours.length).toBeGreaterThan(0);
    expect(w.drops).toEqual([]);
    for (const h of late) expect(h).toMatchObject({ status: 'partial', caveats: expect.arrayContaining(['lateShown']) });
  }, 60_000);
});

describe('honest links stay green', () => {
  /** Every frame from the host waits 50 ms; from the moment the table sends the seat the state of its 4th move, the network stalls `ms`; the seat is timed out of that move. */
  function stalled(code: string, ms: number) {
    let from = -1;
    let tc = -1;
    let k = 0;
    const w: Wire = wire({
      code,
      think: (_k, t) => (t === tc ? Infinity : 800),
      delay: (m, now) => {
        if (from < 0 && m.t === 'state' && w.owes() && w.host.game!.turnCounter === m.view.turnCounter && ++k === 4) {
          from = now;
          tc = m.view.turnCounter;
        }
        return 50 + (from >= 0 && now >= from && now < from + ms ? from + ms - now : 0);
      },
    });
    w.finish();
    need(tc >= 0 && w.judged().includes(tc));
    return w;
  }

  it.each([3_000, 6_000, 9_000])('a %i ms stall of the network as the seat is sent its turn, the seat timed out: green, no drop', (ms) =>
    scenario((i) => {
      const w = stalled(`HS${ms}${i}`, ms);
      expect(w.drops).toEqual([]);
      green(w);
    }),
  );

  it('a 12 s stall of the network as the seat is sent its turn, the seat timed out: green', () =>
    scenario((i) => {
      const w = stalled(`HS12${i}`, 12_000);
      green(w);
    }));

  it('a latency that rises by 5 s and stays up: green, no drop', () =>
    scenario((i) => {
      const t1 = T0 + 40_000 + 9_000 * i;
      const w = wire({ code: `HR5${i}`, think: (k) => (k % 3 === 0 ? Infinity : 800), delay: (_m, now) => 50 + (now >= t1 ? 5_000 : 0) });
      w.finish();
      need(w.judged().length > 0);
      expect(w.drops).toEqual([]);
      green(w);
    }));

  it('a latency that rises in one step by 11 s each way and stays up (a round trip of 22 s, too slow to connect again): the link is kept, as frames keep coming at the pace of their stamps, and nothing fails', () =>
    scenario((i) => {
      const t1 = T0 + 40_000 + 9_000 * i;
      const step = (now: number) => 50 + (now >= t1 ? 11_000 : 0);
      /** When the host sent its last frame before the step, and its first after. */
      let before = 0;
      let after = 0;
      const w = wire({
        code: `HS11${i}`,
        think: (k) => (k % 3 === 0 ? Infinity : 800),
        // The bots take a second over each move, so frames come a second apart before the step as well as 3 s apart after it.
        botDelayMs: 1_000,
        delay: (_m, now) => {
          if (now < t1) before = now;
          else if (after === 0) after = now;
          return step(now);
        },
        up: step,
      });
      w.finish();
      // The frames stop for the 11 s and the gap between those two: a gap of 13 s or more is a link that brought nothing, and dropped.
      need(w.judged().length > 0 && after > 0 && after - before <= 1_500);
      expect(w.drops).toEqual([]);
      expect(w.verdict().failures).toEqual([]);
    }));

  it('a server that slows every stamped frame in steps of 11 s, 25 s apart, up to 33 s, each taken where its frames come a second apart (a delay that rose and stayed, which the watch keeps): the seat’s turns shown more than 17 s late are never green', () =>
    scenario((i) => {
      /** When the first state was sent, the last step was taken and the last stamped frame was sent; how many steps were taken. */
      let first: number | null = null;
      let stepAt = Number.NEGATIVE_INFINITY;
      let prev = Number.NEGATIVE_INFINITY;
      let steps = 0;
      const w = wire({
        code: `HST${i}`,
        think: (k) => (k % 3 === 0 ? Infinity : 800),
        botDelayMs: 1_000,
        delay: (m, now) => {
          if (stampOf(m) === undefined) return 50 + 11_000 * steps;
          if (first === null && m.t === 'state') first = now;
          if (first !== null && m.t === 'state' && steps < 3 && now >= first + 20_000 + 1_000 * i && now - stepAt >= 25_000 && now - prev <= 1_000) {
            steps++;
            stepAt = now;
          }
          prev = now;
          return 50 + 11_000 * steps;
        },
      });
      w.finish();
      const late = [...w.created].filter(([tc, at]) => (w.shown.get(tc) ?? 0) - at > LATE_MS + 1_000 && w.judged().includes(tc));
      need(steps === 3 && late.length > 0 && w.drops.length === 0);
      expect(w.verdict().status).not.toBe('ok');
    }));

  it('a latency that rises by 8 s over 30 s and stays up, then a 6 s stall of the network a minute later: green, no drop', () =>
    scenario((i) => {
      const t1 = T0 + 30_000 + 7_000 * i;
      const t2 = t1 + 90_000;
      const w = wire({
        code: `HL8${i}`,
        think: (k) => (k % 3 === 0 ? Infinity : 800),
        delay: (_m, now) => 50 + Math.min(1, Math.max(0, (now - t1) / 30_000)) * 8_000 + (now >= t2 && now < t2 + 6_000 ? t2 + 6_000 - now : 0),
      });
      w.finish();
      need(w.judged().length > 0 && Math.max(...w.shown.values()) > t2 + 15_000);
      expect(w.drops).toEqual([]);
      green(w);
    }));

  it('a latency that rises by 20 s over two minutes and stays up, the seat timed out now and then: its turns shown late are noted, never failed', () =>
    scenario((i) => {
      const t1 = T0 + 30_000 + 7_000 * i;
      const w = wire({ code: `HL20${i}`, think: (k) => (k % 3 === 0 ? Infinity : 800), delay: (_m, now) => 50 + Math.min(1, Math.max(0, (now - t1) / 120_000)) * 20_000 });
      w.finish();
      const late = [...w.created].filter(([tc, at]) => (w.shown.get(tc) ?? 0) - at > LATE_MS + 1_000 && w.judged().includes(tc));
      need(late.length > 0);
      expect(w.drops).toEqual([]);
      const v = w.verdict();
      expect(v.failures).toEqual([]);
      expect(v.caveats).toContain('lateShown');
    }));

  it('a 20 s stall of the network from the deal of the next hand, the seat’s first turn of it coming in the same burst and the seat timed out: never red', () =>
    scenario((i) => {
      let stallFrom = -1;
      let tc = -1;
      const w: Wire = wire({
        code: `HD${i}`,
        rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
        think: (_k, t) => {
          if (w.c.state.view?.handNumber !== 1 || (tc >= 0 && t !== tc)) return 800;
          tc = t;
          return Infinity;
        },
        // While the phone shows the first hand's result, nothing of the next hand reaches it for 20 s.
        delay: (m, now) => {
          if (stallFrom < 0 && m.t === 'state' && m.view.handNumber === 1) stallFrom = now;
          return 50 + (stallFrom >= 0 && now < stallFrom + 20_000 ? stallFrom + 20_000 - now : 0);
        },
      });
      w.finish();
      need(w.c.state.lastAudit?.handNumber === 0);
      w.shown.clear();
      w.created.clear();
      for (let e = 0; e < 600_000 && !(w.host.phase === 'playing' && w.host.game?.handNumber === 1); e += 500) w.step();
      w.finish();
      need(w.c.state.lastAudit?.handNumber === 1 && tc >= 0 && w.judged().includes(tc));
      need((w.shown.get(tc) ?? 0) - (w.created.get(tc) ?? Number.POSITIVE_INFINITY) > LATE_MS);
      const v = w.verdict();
      expect(v.failures).toEqual([]);
      expect(v.status).not.toBe('failed');
    }));

  it.each([-2_000, -10_000, -60_000, 2_000])('the server’s wall clock stepped %i ms mid-hand, the table keeping its default clock: green, no drop', (step) => {
    vi.useFakeTimers();
    try {
      scenario((i) => {
        const t1 = T0 + 60_000 + 11_000 * i;
        const w = wire({ code: `HW${step}${i}`, hostClock: 'real', think: (k) => (k % 3 === 0 ? Infinity : 800), hostSkew: (now) => (now >= t1 ? step : 0) });
        w.finish();
        need(w.judged().length > 0 && Math.max(...w.shown.values()) > t1 + 10_000);
        expect(w.drops).toEqual([]);
        green(w);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('4 s each way from before the deal, and a 12 s stall as the seat is sent its turn, the seat timed out: never red', () =>
    scenario((i) => {
      let stallFrom = -1;
      let tc = -1;
      let k = 0;
      const w: Wire = wire({
        code: `HY${i}`,
        think: (_k, t) => (t === tc ? Infinity : 800),
        up: () => 4_050,
        delay: (m, now) => {
          if (stallFrom < 0 && m.t === 'state' && w.owes() && w.host.game!.turnCounter === m.view.turnCounter && m.view.turnCounter !== tc && ++k === 4 + i) {
            stallFrom = now;
            tc = m.view.turnCounter;
          }
          return 4_050 + (stallFrom >= 0 && now >= stallFrom && now < stallFrom + 12_000 ? stallFrom + 12_000 - now : 0);
        },
      });
      w.finish();
      need(tc >= 0 && w.judged().includes(tc));
      expect(w.verdict().status).not.toBe('failed');
    }));
});

describe('reconnect: a server that forces the phone onto new links', () => {
  /** The server crawls its stamps until the phone drops the link, and on each new link sends the last state the phone was shown, with its old stamp, ahead of what it holds; the seat is timed out. */
  function staleResend(code: string, ms: number) {
    let shown: Extract<HostMessage, { t: 'state' }> | null = null;
    const h = holdTurn({
      code,
      think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600),
      onReconnect: (w) => {
        if (!h.st.holding) return;
        shown ??= w.lastState;
        if (shown) w.line.inject(shown);
      },
    });
    need(h.arm());
    const from = h.w.clock.now;
    h.w.until(() => h.w.clock.now - from >= ms);
    expect(h.w.drops.length).toBeGreaterThanOrEqual(2);
    h.release();
    h.w.finish();
    need(h.w.judged().includes(h.st.heldTc));
    return h.w;
  }

  it.each([30_000, 40_000])('stamps crawling until the phone drops the link, the last state it was shown re-sent with its old stamp on each new link, the turn released after %i ms on a later one: red playedEarly', (ms) =>
    scenario((i) => {
      const w = staleResend(`RS${ms}${i}`, ms);
      expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }),
  );

  it('the same, the hold lasting until just after a drop, so the turn comes on a fresh link: judged as a drop, amber', () =>
    scenario((i) => {
      const w = staleResend(`RT${i}`, 44_000);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('tableMoved');
    }));

  /**
   * The server closes the link as the seat comes to owe a move, holds everything on the new link (its
   * welcome too) for 40 s, then lets it through freshly stamped; the seat is timed out. Just before
   * what it held, the server may send on the new link, freshly stamped, a frame of its own (`first`):
   * an unasked pong, a clock frame, or the last hand's result again (in the second hand of a match).
   * With `bare`, the first state it held (the one that shows the seat its turn) goes without its
   * stamp; with `moves`, the seat moves 1 s after it is shown the turn.
   */
  function dropTurn(code: string, first: 'none' | 'pong' | 'clock' | 'hand_over', opts: { bare?: boolean; moves?: boolean } = {}) {
    let armed = false;
    let turn = -1;
    let since = 0;
    let back = false;
    let ended: HostMessage | null = null;
    const w: Wire = wire({
      code,
      rules: withRules({ handsPerMatch: first === 'hand_over' ? 2 : 1, turnSeconds: 15, timeBankSeconds: 30 }),
      reconnectMs: 500,
      think: (_k, tc) => (tc === turn ? (opts.moves ? 1_000 : Infinity) : 600),
      map: (m) => {
        if (m.t === 'hand_over') ended = m;
        return m;
      },
      hold: (m, w) => {
        if (!armed || back) return false;
        if (turn < 0 && m.t === 'state' && w.owes() && w.host.game!.turnCounter === m.view.turnCounter) {
          turn = m.view.turnCounter;
          since = w.clock.now;
          // The state that shows the seat its turn is never sent on the link it was meant for.
          w.dropNow(500);
          return true;
        }
        return turn >= 0 && w.line.id !== 'p0';
      },
      onTick: (w) => {
        if (back || turn < 0 || w.line.id === 'p0' || w.clock.now - since < 40_000) return;
        back = true;
        const g = w.host.game!;
        const now = w.clock.now;
        if (first === 'pong') w.line.inject({ t: 'pong', at: 0, now });
        if (first === 'clock') w.line.inject({ t: 'clock', now, hand: g.handNumber, tc: g.turnCounter });
        if (first === 'hand_over' && ended) w.line.inject({ ...ended, now } as HostMessage);
        let strip = !!opts.bare;
        w.line.release((m) => {
          if (stampOf(m) === undefined) return m;
          if (!strip || m.t !== 'state') return { ...m, now } as HostMessage;
          strip = false;
          const { now: _now, ...rest } = m;
          void _now;
          return rest as HostMessage;
        });
      },
    });
    if (first === 'hand_over') {
      w.finish();
      for (let g = 0; g < 7_200 && !(w.host.phase === 'playing' && w.host.game?.handNumber === 1); g++) w.step();
      need(w.c.state.audits.length === 1 && ended !== null);
    }
    need(w.toDiscard(2));
    armed = true;
    w.finish();
    need(back && (opts.moves ? !w.judged().includes(turn) : w.judged().includes(turn)));
    const play = (w.c as unknown as { plays: Array<{ seen: Array<{ tc: number; working?: boolean; onLink?: boolean }> }> }).plays.at(-1)!;
    return { w, shown: play.seen.find((f) => f.tc === turn)! };
  }

  it('the link closed as the seat comes to owe a move, the new one held 40 s (its welcome too) and then let through freshly stamped, the seat timed out: amber', () =>
    scenario((i) => {
      const { w } = dropTurn(`RC${i}`, 'none');
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('tableMoved');
    }));

  it.each(['pong', 'clock'] as const)('the same, with an unasked %s sent freshly stamped on the new link before what was held: it vouches for no state, and the hand is amber', (first) =>
    scenario((i) => {
      const { w, shown } = dropTurn(`RP${first}${i}`, first);
      expect(shown).toMatchObject({ working: false, onLink: false });
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('tableMoved');
    }),
  );

  it('the same, the state that shows the turn let through on the new link without its stamp: amber, whether the table times the seat out or the seat moves (its turn shown late)', () =>
    scenario((i) => {
      const timedOut = dropTurn(`RB${i}`, 'none', { bare: true }).w;
      expect(timedOut.verdict().status).toBe('partial');
      expect(timedOut.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
      const moved = dropTurn(`RM${i}`, 'none', { bare: true, moves: true }).w;
      expect(moved.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(moved.verdict().caveats).toContain('lateShown');
    }));

  it('the same in a second hand, with the first hand’s result sent again freshly stamped on the new link: the turn’s state still came first on a new link, and the hand is amber', () =>
    scenario((i) => {
      const { w, shown } = dropTurn(`RH${i}`, 'hand_over');
      expect(shown).toMatchObject({ onLink: false });
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('tableMoved');
    }));

  it('a slow reconnect: the watch drops a crawling link, joining again takes 10 s, and the held turn state comes at once on the new link with its own stamp: amber, never green', () =>
    scenario((i) => {
      let first: Line | null = null;
      const h = holdTurn({
        code: `RW${i}`,
        reconnectMs: 10_000,
        think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600),
        onReconnect: (w) => {
          if (!h.st.holding || !first) return;
          h.st.holding = false;
          h.st.released = true;
          for (const m of first.held.splice(0)) w.line.inject(m);
        },
      });
      need(h.arm());
      first = h.w.line;
      h.w.finish();
      need(h.st.released && h.w.judged().includes(h.st.heldTc));
      expect(h.w.drops).toHaveLength(1);
      expect(h.w.verdict().status).toBe('partial');
      expect(h.w.verdict().caveats).toContain('tableMovedLate');
    }));

  it('no storm: after a stall drops a link with 8 s each way, the new link, whose first frame takes 16 s, is kept', () =>
    scenario((i) => {
      let stallFrom = -1;
      let tc = -1;
      let k = 0;
      const w: Wire = wire({
        code: `RN${i}`,
        think: (_k, t) => (t === tc ? Infinity : 800),
        up: () => 8_050,
        delay: (m, now) => {
          if (stallFrom < 0 && m.t === 'state' && w.owes() && w.host.game!.turnCounter === m.view.turnCounter && ++k === 4) {
            stallFrom = now;
            tc = m.view.turnCounter;
          }
          return 8_050 + (stallFrom >= 0 && now >= stallFrom && now < stallFrom + 12_000 ? stallFrom + 12_000 - now : 0);
        },
      });
      w.finish();
      need(tc >= 0);
      expect(w.drops).toHaveLength(1);
      expect(w.c.state.lastResult).not.toBeNull();
    }));
});

describe('device clock: frames that waited in the device', () => {
  /** 10 s turns and a 10 s bank, so the table times the seat out while the app is not running. */
  const QUICK = withRules({ handsPerMatch: 1, turnSeconds: 10, timeBankSeconds: 10 });

  /** The app stops running for 30 s just as the seat's next move is sent it; the seat is timed out meanwhile. */
  function pausedAcrossTurn(code: string, how: 'background' | 'asleep') {
    let from = Number.POSITIVE_INFINITY;
    let move = Number.POSITIVE_INFINITY;
    const paused = (now: number) => now >= from && now < from + 30_000;
    const w: Wire = wire({ code, rules: QUICK, [how]: paused, checkFirst: true, think: (_k, tc) => (tc > move ? Infinity : 600) });
    need(w.toDiscard(2));
    // The seat makes this move; the table answers with the seat's next turn in the same tick, which the app no longer handles.
    move = w.host.game!.turnCounter;
    need(w.until(() => w.host.game!.turnCounter > move, 10_000));
    from = w.clock.now + 1;
    const turn = w.owes() ? w.host.game!.turnCounter : -1;
    w.finish();
    return { w, turn };
  }

  it('background 30 s across the seat’s turn start, the link checked before the frames that waited are handled: green', () =>
    scenario((i) => {
      const { w, turn } = pausedAcrossTurn(`DB${i}`, 'background');
      need(turn >= 0 && w.judged().includes(turn));
      expect(w.drops).toEqual([]);
      green(w);
    }));

  it('background 30 s across the seat’s turn start, what the server sent meanwhile held in the network until after the watch’s grace on waking, the seat timed out: never red', () =>
    scenario((i) => {
      let move = Number.POSITIVE_INFINITY;
      let from = -1;
      const w: Wire = wire({
        code: `DN${i}`,
        rules: QUICK,
        background: (now) => from >= 0 && now > from && now <= from + 30_000,
        think: (_k, tc) => (tc > move ? Infinity : 600),
        // From the table's answer to the seat's move, everything waits in the network until 12 s after the app is back.
        delay: (m, now) => {
          if (from < 0 && m.t === 'state' && m.view.turnCounter > move) from = now;
          return 50 + (from >= 0 && now < from + 42_000 ? from + 42_000 - now : 0);
        },
      });
      need(w.toDiscard(2));
      move = w.host.game!.turnCounter;
      w.finish();
      const late = [...w.created].filter(([tc, at]) => at >= from && at < from + 30_000 && (w.shown.get(tc) ?? 0) >= from + 42_000 && w.judged().includes(tc));
      need(from >= 0 && late.length > 0);
      const v = w.verdict();
      expect(v.failures).toEqual([]);
      expect(v.status).not.toBe('failed');
    }));

  it('asleep 30 s across the seat’s turn start (the monotonic clock stands still, the wall clock runs): green, no drop', () =>
    scenario((i) => {
      const { w, turn } = pausedAcrossTurn(`DS${i}`, 'asleep');
      need(turn >= 0 && w.judged().includes(turn));
      expect(w.drops).toEqual([]);
      green(w);
    }));
});

describe('match record: what a saved record keeps of each frame', () => {
  const NEW_FIELDS = ['atLo', 'ref', 'wref', 'live', 'working', 'seg', 'run', 'onLink'] as const;

  /**
   * The link drops just as the seat's turn begins and comes back 20 s later, so the phone is first
   * shown its turn on the new link with 25 s of its clock left; the table times the seat out. Then
   * the app restarts, restored from its saved record (`edit` may change it), and the hand is played out.
   */
  function shownLateThenRestart(code: string, edit?: (saved: SerializedClient) => SerializedClient) {
    let turn = Number.POSITIVE_INFINITY;
    const w = wire({ code, think: (_k, tc) => (tc === turn ? Infinity : 600) });
    need(w.toDiscard(2));
    const move = w.host.game!.turnCounter;
    need(w.until(() => w.host.game!.turnCounter > move, 10_000) && w.owes());
    turn = w.host.game!.turnCounter;
    // The state that shows the seat its turn is lost with the link.
    w.dropNow(20_000);
    need(w.until(() => w.host.game!.turnCounter > turn));
    w.step(2_000);
    let saved: SerializedClient | null = null;
    w.restart((s) => {
      saved = s;
      return edit ? edit(JSON.parse(JSON.stringify(s)) as SerializedClient) : s;
    });
    w.finish();
    need(w.judged().includes(turn));
    return { w, saved: saved as unknown as SerializedClient, turn };
  }

  it('a save keeps the new fields of every frame and move, and the restored client judges by them: the turn shown late on the new link makes the hand amber', () =>
    scenario((i) => {
      const { w, saved, turn } = shownLateThenRestart(`MR${i}`);
      const play = saved.plays.find((p) => p.seen.some((f) => f.tc === turn))!;
      const shown = play.seen.filter((f) => f.tc === turn);
      expect(shown.length).toBeGreaterThan(0);
      for (const f of play.seen) for (const k of NEW_FIELDS) expect(f).toHaveProperty(k);
      expect(shown[0]).toMatchObject({ working: false, onLink: false, live: false });
      for (const x of play.sent) {
        expect(typeof x.run).toBe('string');
        expect(typeof x.seg).toBe('number');
      }
      // Saved again by the restored client, the frames before the restart keep them too.
      const again = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
      const kept = again.plays.find((p) => p.hand === play.hand);
      if (kept) expect(kept.seen.find((f) => f.tc === turn)).toMatchObject({ working: false, onLink: false });
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('tableMoved');
    }));

  it('a record saved by an older build, without those fields, judges as before: green', () =>
    scenario((i) => {
      const strip = (s: SerializedClient) => {
        for (const p of s.plays) {
          for (const f of p.seen) for (const k of NEW_FIELDS) delete f[k];
          for (const x of p.sent) {
            delete x.run;
            delete x.seg;
          }
        }
        return s;
      };
      const { w } = shownLateThenRestart(`MO${i}`, strip);
      green(w);
    }));

  /**
   * The app restarts 2 s after the phone was shown one of the seat's turns over a live link (the next
   * one after its sixth discard, when the watch has measured the link for a while), and a client
   * restored from the saved record, which `edit` may damage, joins at once on a new link. The table times the seat out of that turn, or (`moves`) the
   * seat makes it 6 s after it was shown.
   */
  function restartOnLiveTurn(code: string, moves: boolean, edit?: (play: PlayRecord, r0: SeenState) => void, twice = false) {
    let armed = false;
    let turn = -1;
    const w = wire({
      code,
      think: (_k, tc) => {
        if (!armed) return 600;
        if (turn < 0) turn = tc;
        return tc === turn ? (moves ? 6_000 : Infinity) : 600;
      },
    });
    need(w.toDiscard(6));
    armed = true;
    need(w.until(() => turn >= 0 && w.current(), 120_000));
    for (let t = 0; t < 4; t++) w.step();
    need(w.host.game!.turnCounter === turn);
    w.restart((s) => {
      const play = s.plays[s.plays.length - 1];
      const r0 = play.seen.find((f) => f.tc === turn);
      need(r0?.live === true);
      edit?.(play, r0 as SeenState);
      return s;
    });
    if (twice) {
      // The restored client saves its record, and the app restarts once more on the same turn.
      for (let t = 0; t < 4; t++) w.step();
      need(w.host.game!.turnCounter === turn);
      w.restart();
    }
    w.finish();
    need(w.judged().includes(turn) !== moves);
    return w;
  }

  /** What storage damage can leave in a saved record: NaN (null once the record is JSON), strings, huge and negative numbers, the wrong types. */
  const JUNK: unknown[] = [NaN, 'x', '17', 1e300, -1e300, -5, true, false, {}, [], null, 99_999_999_999_999];
  const DAMAGE: Array<[string, (play: PlayRecord, r0: SeenState) => void]> = [
    [
      'junk in every new field of every frame and move',
      (play) => {
        let k = 0;
        for (const f of play.seen) for (const key of NEW_FIELDS) (f as unknown as Record<string, unknown>)[key] = JUNK[k++ % JUNK.length];
        for (const x of play.sent) Object.assign(x, { run: JUNK[k++ % JUNK.length], seg: JUNK[k++ % JUNK.length] });
      },
    ],
    ['its earliest arrival far in the future', (_p, r0) => (r0.atLo = 1e300)],
    ['its earliest arrival 20 s after it arrived', (_p, r0) => (r0.atLo = r0.at + 20_000)],
    ['the watch’s reference far below zero', (_p, r0) => (r0.wref = -1e300)],
    ['the watch’s reference 20 s below the least offset', (_p, r0) => (r0.wref = (r0.ref as number) - 20_000)],
    ['both references two hours below its own offset', (_p, r0) => (r0.ref = r0.wref = (r0.atLo as number) - (r0.now as number) - 7_200_000)],
    ['its stamp far in the past', (_p, r0) => (r0.now = -1e300)],
    ['its stamp far in the future', (_p, r0) => (r0.now = 1e300)],
    ['its deadline far in the past', (_p, r0) => (r0.deadline = -1e300)],
    ['live and working that are not booleans', (_p, r0) => Object.assign(r0, { live: 'x', working: 7 })],
  ];

  it('a restart on a turn shown over a live link, from an undamaged record: green, whether the table times the seat out or the seat moves', () => {
    scenario((i) => green(restartOnLiveTurn(`MD${i}`, false)));
    scenario((i) => green(restartOnLiveTurn(`MP${i}`, true)));
  });

  /** Move the stamp of the frame that first showed the seat its turn by `by` ms in the saved record, every other field left as it was. */
  const moveStamp = (by: number) => (play: PlayRecord, shown: SeenState) => {
    // The seat may have owed a move since a frame before it (a claim it let pass): the first of those.
    let k = play.seen.indexOf(shown);
    while (k > 0 && play.seen[k - 1].owes) k--;
    const r0 = play.seen[k];
    need(r0.live === true);
    r0.now = (r0.now as number) + by;
  };

  it.each([20_000, 70_000, 300_000])('a saved record in which the frame that first showed the seat its turn has its stamp moved back %i ms and every other field left as it was (damage that stays consistent, as one changed digit can): a frame restored from storage is not held to a live link’s bound, so the turn counts as shown late, amber, never red, whether the table times the seat out or the seat moves', (back) => {
    for (const moves of [false, true]) {
      const w = scenario((i) => restartOnLiveTurn(`MC${back}${moves ? 'P' : 'D'}${i}`, moves, moveStamp(-back)));
      expect(w.verdict().failures).toEqual([]);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('lateShown');
    }
  });

  it.each([3_000, 20_000])('the same with the stamp moved forward %i ms, the seat moving: the state seems not to give the whole turn clock, which a restored frame is not failed for either, so the turn counts as shown late, amber, never red', (fwd) => {
    const w = scenario((i) => restartOnLiveTurn(`MF${fwd}${i}`, true, moveStamp(fwd)));
    expect(w.verdict().failures).toEqual([]);
    expect(w.verdict().status).toBe('partial');
    expect(w.verdict().caveats).toContain('lateShown');
  });

  const moveDeadline = (by: number) => (play: PlayRecord, shown: SeenState) => {
    let k = play.seen.indexOf(shown);
    while (k > 0 && play.seen[k - 1].owes) k--;
    const r0 = play.seen[k];
    need(r0.live === true && typeof r0.deadline === 'number');
    r0.deadline = (r0.deadline as number) + by;
  };

  it('the same with its deadline moved 5 s earlier: the state seems not to give the whole turn clock, which a restored frame is not failed for, so the turn counts as shown late, amber, never red, whether the table times the seat out or the seat moves', () => {
    for (const moves of [false, true]) {
      const w = scenario((i) => restartOnLiveTurn(`MK${moves ? 'P' : 'D'}${i}`, moves, moveDeadline(-5_000)));
      expect(w.verdict().failures).toEqual([]);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('lateShown');
    }
  });

  it('the same, and the app restarts once more on that turn: the restored client saves the damaged state without a check figure, so it is read back as damaged again, amber, never red', () => {
    for (const moves of [false, true]) {
      const w = scenario((i) => restartOnLiveTurn(`ML${moves ? 'P' : 'D'}${i}`, moves, moveDeadline(-5_000), true));
      expect(w.verdict().failures).toEqual([]);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('lateShown');
    }
  });

  /**
   * The state that shows the seat its third turn cuts its clock to 5 s (its deadline 5 s after its stamp,
   * or as `cut` writes it), on a link the phone held (`cut`); the table times the seat out of it, or
   * (`moves`) the seat makes it in 0.8 s. Three seconds later the app restarts by itself, or (`kick`) the
   * server says the seat was opened on another device and the user resumes the table from Home 5 s after
   * that: a client restored from the saved record, as it was saved, joins on a new link.
   */
  function cutThenResume(code: string, cut: boolean | ((m: StateMsg) => StateMsg), moves: boolean, kick: boolean) {
    let cutTc = -1;
    let owed = 0;
    let answered: number | null = null;
    let done = false;
    const w = wire({
      code,
      think: (_k, tc) => (tc === cutTc && !moves ? Infinity : tc === cutTc ? 800 : 600),
      map: (m, w) => {
        if (cutTc >= 0 || m.t !== 'state' || !w.owes() || w.host.game!.turnCounter !== m.view.turnCounter || typeof m.now !== 'number' || m.inTimeBank) return m;
        if (++owed < 3 || !legalActions(w.host.game!, 0).every((a) => a.type === 'discard')) return m;
        cutTc = m.view.turnCounter;
        return typeof cut === 'function' ? cut(m) : cut ? { ...m, deadline: m.now + 5_000 } : m;
      },
      onTick: (w) => {
        if (cutTc >= 0 && answered === null && w.host.game && w.host.game.turnCounter > cutTc) answered = w.clock.now;
        if (done || answered === null || w.clock.now < answered + 3_000 || w.host.phase !== 'playing') return;
        done = true;
        if (kick) w.line.inject({ t: 'disconnected' });
      },
    });
    w.dealt();
    need(w.until(() => done));
    if (kick) for (let t = 0; t < 10; t++) w.step();
    need(w.host.phase === 'playing');
    w.restart();
    w.finish();
    need(w.judged().includes(cutTc) !== moves);
    return w;
  }

  it('a state that cut the seat’s turn clock to 5 s on a link the phone held, restored as it was saved (its check figure matches): red lateTurn, as in the run that saw it, whether the app restarted by itself or the server said the seat was opened on another device and the user resumed the table from Home, and whether the table timed the seat out or the seat moved', () => {
    for (const kick of [false, true])
      for (const moves of [false, true]) {
        const w = scenario((i) => cutThenResume(`MU${kick ? 'K' : 'R'}${moves ? 'P' : 'D'}${i}`, true, moves, kick));
        expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['lateTurn'] });
      }
  });

  it.each<[string, (m: StateMsg) => StateMsg]>([
    ['sent as the text -1e400, which reads as -Infinity (a saved record would write it as null: no deadline at all)', (m) => ({ ...m, deadline: Number.NEGATIVE_INFINITY })],
    ['two days before its stamp (no honest host sends one, and a record’s range checks would take it for damage)', (m) => ({ ...m, deadline: (m.now as number) - 2 * 86_400_000 })],
    ['5 s after a stamp 1.1e13 ms ahead of this device’s clock (a stamp no clock makes)', (m) => ({ ...m, now: (m.now as number) + 1.1e13, deadline: (m.now as number) + 1.1e13 + 5_000 })],
  ])('the same cut with the deadline %s: the state is read back as it was seen, so it is red after the resume as before it', (what, cut) => {
    for (const kick of [false, true])
      for (const moves of [false, true]) {
        const w = scenario((i) => cutThenResume(`MW${kick ? 'K' : 'R'}${moves ? 'P' : 'D'}${i}`, cut, moves, kick));
        expect(w.verdict().status).toBe('failed');
        // A stamp far ahead also leaves the next frame stamped long before it, so the table's move after it fails as held back.
        if (moves || !what.includes('ahead')) expect(w.verdict().failures).toEqual(expect.arrayContaining(['lateTurn']));
      }
  });

  it('the same with no cut: green, whether the app restarted by itself or the server said the seat was opened on another device', () => {
    for (const kick of [false, true])
      for (const moves of [false, true]) green(scenario((i) => cutThenResume(`MV${kick ? 'K' : 'R'}${moves ? 'P' : 'D'}${i}`, false, moves, kick)));
  });

  for (const [what, edit] of DAMAGE)
    it(`a damaged saved record (the turn’s first frame with ${what}) is read as one saved before those fields were kept: never red, whether the table times the seat out or the seat moves`, () => {
      for (const moves of [false, true]) {
        const w = scenario((i) => restartOnLiveTurn(`MX${moves ? 'P' : 'D'}${i}`, moves, edit));
        expect(w.verdict().status).not.toBe('failed');
        expect(w.verdict().failures).toEqual([]);
      }
    });
});
