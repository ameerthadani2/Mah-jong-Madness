/**
 * A server that wants to cut a seat's turn short without failing the hand can hold back the state
 * that shows the seat its turn, and keep the link looking alive meanwhile with pongs and clock
 * frames whose stamps creep forward a millisecond at a time, or run slow; or it can delay all it
 * sends, under honest stamps. The phone measures the table's stamps against its own clock (the
 * least arrival offset seen since the table's clock began), so stamps that fall behind count as
 * silence: the link is dropped, and the time without it is judged as a drop. The phone pings the
 * table once a second, and each answer is a fixed point between the two clocks: pongs whose stamps
 * crawl make the table's honest stamps after them look early (red). And it judges the state that
 * first showed the seat each move: on a link it already held, that state must give the whole turn
 * clock by its own deadline and stamp; on a live link it may reach the phone at most 17 s late
 * against the watch's reference; later than half the turn clock (at least 2 s) against the fixed
 * points, the hand is amber, and the table's move is judged as made while the seat had no link. A
 * turn skipped on a link that stayed open fails. Honest links that are slow or slow down for good,
 * stalls that leave a turn less than half its clock late, phones that sleep, and servers whose wall
 * clock is set back, stay green; a stall or a slow link that costs a turn more than that is amber.
 */
import { describe, expect, it, vi } from 'vitest';
import { chooseAction, legalActions, withRules, type Action, type BotSkill, type GameState, type RuleSet } from '@mjm/engine';
import { caveatKey, CLOCK_FRAME_MS, failureKey, LoopbackHub, SILENT_ANSWER_MS, TableClient, TableHost, tableRule, transportLink, type HostMessage, type SerializedClient } from '../src/index';
import { LATE_MS } from '../src/clientclock';
import { keepSeen, MAX_SEEN, type PlayRecord, type SeenState } from '../src/clientrecords';
import { Missed, scenario, scenarioAsync, seededDeals } from './support';
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
    it.each([25_000, 40_000, 44_000])(`a hold of %i ms, the clock frames and pongs crawling a millisecond at a time${all ? ', every other frame held too' : ''}: the link is dropped, and the hand is red (${all ? 'the crawled pongs are fixed points that the table’s later stamps contradict' : 'on the new link the table answers a ping before the state it owes there'})`, (ms) =>
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
        // On the new link the hold goes on: the table welcomes the phone and answers its pings, but sends the state it owes
        // the seat only at the release, though an honest host sends it right behind the welcome (`heldFrame`).
        // Holding every other frame holds the new link's welcome too, while the crawling clock frames go out on that link:
        // frames about the table on a link it never welcomed (`unseatedFrame`). A pong answered a second after its ping
        // and stamped a millisecond after the last is a fixed point: this device's clock is that far ahead of the table's,
        // and every honest stamp after it then calls the table's move early (`playedEarly`).
        expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: all ? ['unseatedFrame', 'playedEarly'] : ['heldFrame'] });
      }),
    );
  }

  it('a 12 s hold under crawling pongs, released with its own stamp, the seat timed out: red playedEarly', () =>
    scenario((i) => {
      const h = holdTurn({ code: `CB12${i}`, think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600) });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 12_000);
      h.release();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('an 18 s hold under crawling pongs, released with its own stamp, the seat timed out: red heldFrame (the watch drops the link, and on the new one the table answers a ping before the state it owes there)', () =>
    scenario((i) => {
      const h = holdTurn({ code: `CB18${i}`, think: (_k, tc) => (tc === h.st.heldTc ? Infinity : 600) });
      need(h.arm());
      const from = h.w.clock.now;
      h.w.until(() => h.w.clock.now - from >= 18_000);
      h.release();
      h.w.finish();
      need(h.w.judged().includes(h.st.heldTc));
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
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

  it('pongs that echo an old ping, stamped at the crawl: the link is dropped, and the hand is red (on the new link the table sends a pong before the state it owes there)', () =>
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
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
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

  it.each([15_000, 19_000])('%i ms from the start, the pongs as late as the rest: amber (the round trips put every turn more than half its clock late), never green', (ms) =>
    scenario((i) => {
      const w = delayed(`DL${ms}${i}`, ms);
      need(w.judged().length > 0);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
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
            // Behind the new link's welcome, as a server that asks there does.
            w.line.pump();
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
          // The relay: every frame is held 25 s, and goes out on whatever link is up then (a lost link's frames too),
          // behind that link's welcome, which goes first (a server welcomes a link before it sends it anything else).
          map: (m, w) => {
            if (m.t === 'welcome') return m;
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

  it('an honest round trip from before the deal: 3 s each way (6 s, inside the 7.5 s a Normal turn may be late) is green; 4 s each way (8 s) is amber, never red', () =>
    scenario((i) => {
      const fast = wire({ code: `DG${i}`, seat: 2, think: (k) => (k % 3 === 0 ? Infinity : 800), up: () => 3_000, delay: () => 3_000 });
      fast.finish();
      need(fast.judged().length > 0);
      green(fast);
      const slow = wire({ code: `DH${i}`, seat: 2, think: (k) => (k % 3 === 0 ? Infinity : 800), up: () => 4_000, delay: () => 4_000 });
      slow.finish();
      need(slow.judged().length > 0);
      expect(slow.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(slow.verdict().caveats).toContain('lateShown');
    }));

  it('seat 1, a deal stamped 15 s back with a 15 s delay: amber, never green', () =>
    scenario((i) => {
      const inside = backdated(`DI${i}`, 15_000, 15_000, 1);
      need(inside.judged().length > 0);
      expect(inside.verdict().status).toBe('partial');
      expect(inside.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
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

  it('Hyper, 5 s from the start, more than the 2 s a Hyper turn may be late: the table plays every turn, the hand is amber, and every turn the phone measured is counted', () =>
    scenario((i) => {
      const { w, late, of } = slowed(`FC5${i}`, HYPER, 5_000);
      need(of > 0);
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
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

  it('the bar is half of the 7.5 s a Normal turn may be late: 3 s late from the start is green and not counted, 5 s is green and counted, 9 s is amber and counted', () =>
    scenario((i) => {
      const three = slowed(`FN3${i}`, NORMAL, 3_000);
      need(three.of > 0);
      green(three.w);
      expect(three.late).toBe(0);
      const five = slowed(`FN5${i}`, NORMAL, 5_000);
      need(five.of > 0);
      green(five.w);
      expect(five.late).toBe(five.of);
      const nine = slowed(`FN9${i}`, NORMAL, 9_000);
      need(nine.of > 0);
      expect(nine.w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(nine.w.verdict().caveats).toContain('lateShown');
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

  it.each([3_000, 6_000])('a %i ms stall of the network as the seat is sent its turn, the seat timed out: green, no drop', (ms) =>
    scenario((i) => {
      const w = stalled(`HS${ms}${i}`, ms);
      expect(w.drops).toEqual([]);
      green(w);
    }),
  );

  it.each([9_000, 12_000])('a %i ms stall of the network as the seat is sent its turn, more than the 7.5 s a Normal turn may be late, the seat timed out: amber (the turn reached the phone late), never red', (ms) =>
    scenario((i) => {
      const w = stalled(`HS${ms}${i}`, ms);
      expect(w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(w.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
    }),
  );

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

  it('a latency that rises by 8 s over 30 s and stays up (every turn more than the 7.5 s a Normal turn may be late), then a 6 s stall of the network a minute later: amber, never red, no drop', () =>
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
      expect(w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(w.verdict().caveats).toContain('lateShown');
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
        // Behind the new link's welcome.
        w.line.pump();
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

  it('the same, the hold lasting until just after a drop, so the turn comes on a fresh link: judged as a drop, and red: by the crawled pongs, the clock cannot have run out while the link was down', () =>
    scenario((i) => {
      const w = staleResend(`RT${i}`, 44_000);
      expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['playedWhileDown'] });
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
        // The welcome it held goes first: a frame about the table before it would be one on a link it never welcomed.
        const k = w.line.held.findIndex((m) => m.t === 'welcome');
        if (k >= 0) w.line.inject(w.line.held.splice(k, 1)[0]);
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

  it('the same, with an unasked clock frame sent freshly stamped on the new link before what was held: it vouches for no state, and the hand is amber', () =>
    scenario((i) => {
      const { w, shown } = dropTurn(`RPclock${i}`, 'clock');
      expect(shown).toMatchObject({ working: false, onLink: false });
      expect(w.verdict().status).toBe('partial');
      expect(w.verdict().caveats).toContain('tableMoved');
    }));

  it('the same, with an unasked pong sent freshly stamped on the new link before what was held: red, the table answered (as it says) before it sent the state it owed behind its welcome', () =>
    scenario((i) => {
      const { w, shown } = dropTurn(`RPpong${i}`, 'pong');
      expect(shown).toMatchObject({ working: false, onLink: false });
      expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

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

  it('a slow reconnect: the watch drops a crawling link, joining again takes 10 s, and the held turn state comes at once on the new link with its own stamp: red playedEarly (the crawled pongs contradict it), never green', () =>
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
          // Behind the new link's welcome.
          w.line.pump();
          for (const m of first.held.splice(0)) w.line.inject(m);
        },
      });
      need(h.arm());
      first = h.w.line;
      h.w.finish();
      need(h.st.released && h.w.judged().includes(h.st.heldTc));
      expect(h.w.drops).toHaveLength(1);
      expect(h.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('no storm: a stall with 8 s each way drops the link at most once (a pong a second keeps the watch fed), and the new link, whose first frame takes 16 s, is kept', () =>
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
      expect(w.drops.length).toBeLessThanOrEqual(1);
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

describe('device clock: the phone’s wall clock set while the app was closed', () => {
  /**
   * An honest table over two hands. After the seat's second discard the app restarts, and while it was
   * closed the phone's wall clock was set `step` ms (back or forward): the restored app's clock reads that
   * much off from the clock the record was kept by. The table times the seat out of one discard before the
   * restart (`before`) or after it, and of one in the second hand; the seat plays every other turn.
   */
  function stepWhileClosed(code: string, step: number, before: boolean) {
    let restarted = false;
    const out: number[] = [];
    let owed = 0;
    const w = wire({
      code,
      rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
      devSkew: () => (restarted ? step : 0),
      think: (_k, tc) => {
        // The first hand: its second owed turn (before the restart) or the first one after it; the second hand: its first.
        const h = w.host.game?.handNumber ?? 0;
        if (h === 0 && !out.length && (before ? ++owed === 2 : restarted)) {
          out.push(tc);
          return Infinity;
        }
        if (h === 1 && out.length === 1) {
          out.push(tc);
          return Infinity;
        }
        return 600;
      },
    });
    w.dealt();
    if (before) need(w.until(() => out.length === 1 && w.tableMoves().includes(out[0])));
    need(w.toDiscard(2));
    restarted = true;
    w.restart();
    w.finish();
    need(out.length === 1 && w.judged().includes(out[0]));
    const first = w.verdict();
    for (let e = 0; e < 600_000 && w.host.phase === 'hand_over'; e += 500) w.step();
    w.finish();
    need(w.c.state.lastAudit?.handNumber === 1 && out.length === 2 && w.judged().includes(out[1]));
    return { first, second: w.verdict() };
  }

  it.each([-10_000, -60_000])('set back %i ms, the table timing the seat out after the restart and in the next hand: the timeout after the restart is early only by what the run before it measured, so that hand is amber with the reason, and the next one, measured by this run alone, green; never red', (step) => {
    const { first, second } = scenario((i) => stepWhileClosed(`SW${step}${i}`, step, false));
    expect(first).toEqual({ status: 'partial', failures: [], caveats: ['appClock'] });
    expect(second).toEqual({ status: 'ok', failures: [], caveats: [] });
  });

  it.each([10_000, 60_000])('set forward %i ms, the table timing the seat out after the restart and in the next hand: green', (step) => {
    const { first, second } = scenario((i) => stepWhileClosed(`SW${step}${i}`, step, false));
    expect(first).toEqual({ status: 'ok', failures: [], caveats: [] });
    expect(second).toEqual({ status: 'ok', failures: [], caveats: [] });
  });

  it.each([10_000, 60_000])('set forward %i ms, the table timing the seat out before the restart: the fixed points made after it call that timeout early, which they cannot tell (amber with the reason), never red', (step) => {
    const { first, second } = scenario((i) => stepWhileClosed(`SB${step}${i}`, step, true));
    expect(first).toEqual({ status: 'partial', failures: [], caveats: ['appClock'] });
    expect(second).toEqual({ status: 'ok', failures: [], caveats: [] });
  });

  /**
   * A server whose clock leaps 20 s forward 2 s into the seat's first turn after its fourth discard, which
   * the seat leaves to run out, so the table times it out 20 s early by real time while its stamps hold
   * together; it keeps the lead from then on. Between the two the app restarts (`restart`), or not: the
   * seat makes no move in the new run before that turn.
   */
  function leap(code: string, restart: boolean) {
    let armed = false;
    let target = -1;
    let shownAt: number | null = null;
    let lead = 0;
    const w = wire({
      code,
      // The bots take a second over each move, so there are moments when the seat owes nothing.
      botDelayMs: 1_000,
      hostSkew: () => lead,
      think: (_k, tc) => {
        if (armed && target < 0) target = tc;
        return tc === target ? Infinity : 600;
      },
      onTick: (w) => {
        if (target >= 0 && shownAt === null && w.shown.has(target)) shownAt = w.shown.get(target) as number;
        if (shownAt !== null && lead === 0 && w.clock.now >= shownAt + 2_000) lead = 20_000;
      },
    });
    need(w.toDiscard(4));
    // The seat makes that discard first, and owes nothing when the app restarts.
    need(w.until(() => !w.owes() && !w.current(), 20_000));
    if (restart) w.restart();
    armed = true;
    w.finish();
    need(lead > 0 && w.judged().includes(target));
    return w;
  }

  it('the phone’s wall clock set 20 s forward while the app runs, after the table timed the seat out: the fixed points made after it (a new run of the device’s clock) call that timeout early, which they cannot tell, so the hand is amber with the reason, not red', () => {
    const verdict = scenario((i) => {
      let stepped = false;
      let out = -1;
      let owed = 0;
      const w = wire({
        code: `SG${i}`,
        // The monotonic clock runs on, so the client sees the wall clock run ahead of it and starts a new run of its clock.
        asleep: () => false,
        devSkew: () => (stepped ? 20_000 : 0),
        think: (_k, tc) => {
          if (out < 0 && ++owed === 2) {
            out = tc;
            return Infinity;
          }
          return 600;
        },
      });
      w.dealt();
      need(w.until(() => out >= 0 && w.tableMoves().includes(out)));
      for (let t = 0; t < 4; t++) w.step();
      stepped = true;
      w.finish();
      need(w.judged().includes(out));
      return w.verdict();
    });
    expect(verdict).toEqual({ status: 'partial', failures: [], caveats: ['appClock'] });
  });

  it('a server whose clock leaps 20 s forward on the seat’s first turn after an app restart: red with or without the restart (the new run pings the table within a second, and its answer is a fixed point the leap contradicts)', () => {
    expect(scenario((i) => leap(`SL${i}`, false)).verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    expect(scenario((i) => leap(`SL${i}`, true)).verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
  });
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

  it('the same cut with the deadline sent as the text -1e400, which reads as -Infinity: no clock gives that figure, so the state is malformed, never shown, and the hand is red', () => {
    for (const kick of [false, true]) {
      // (The seat is never shown the turn, so it cannot move on it: the table times it out.)
      const w = scenario((i) => cutThenResume(`MWI${kick ? 'K' : 'R'}${i}`, (m) => ({ ...m, deadline: Number.NEGATIVE_INFINITY }), false, kick));
      expect(w.verdict().status).toBe('failed');
      expect(w.verdict().failures).toEqual(expect.arrayContaining(['malformedFrame']));
    }
  });

  it.each<[string, (m: StateMsg) => StateMsg]>([
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

  /**
   * An honest table over two hands. After the seat's second discard the app restarts from a record in
   * which storage changed the stamp of the hand's deal (`edit`), every other field left as it was; then
   * the table times the seat out of its next discard, and once more in the second hand.
   */
  function damagedDeal(code: string, edit: (deal: SeenState) => void) {
    let armed = false;
    const out: number[] = [];
    const w = wire({
      code,
      rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
      think: (_k, tc) => {
        // One timeout in each hand once the app has restarted: the first turn owed after it, and the first of hand 1.
        if (!armed || out.length > (w.host.game?.handNumber ?? 0)) return 600;
        out.push(tc);
        return Infinity;
      },
    });
    need(w.toDiscard(2));
    w.restart((s) => {
      const deal = s.plays[s.plays.length - 1].seen.find((f) => f.tc === 0);
      need(typeof deal?.now === 'number');
      edit(deal as SeenState);
      return s;
    });
    armed = true;
    w.finish();
    need(out.length > 0 && w.judged().includes(out[0]));
    const first = w.verdict();
    for (let e = 0; e < 600_000 && w.host.phase === 'hand_over'; e += 500) w.step();
    w.finish();
    need(w.c.state.lastAudit?.handNumber === 1 && out.length > 1 && w.judged().includes(out[1]));
    return { first, second: w.verdict() };
  }

  it.each<[string, (deal: SeenState) => void]>([
    ['moved back 20 s', (deal) => (deal.now = (deal.now as number) - 20_000)],
    ['with one digit changed (moved back about 1 000 s)', (deal) => (deal.now = (deal.now as number) - 1_000_000)],
  ])('a saved record in which the stamp of the hand’s deal was %s: the deal’s fixed point is not taken from a damaged state, so neither the timeout after the restart nor one in the next hand fails', (_what, edit) => {
    const { first, second } = scenario((i) => damagedDeal(`MD${_what.length}${i}`, edit));
    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);
    expect(second.status).toBe('ok');
  });

  /**
   * An honest table times the seat out of its third discard; a few seconds later the app restarts from a
   * record in which storage moved back by 20 s the stamp of the state that followed the table's move (every
   * other field left as it was), and the hand is played out.
   */
  function damagedAfterTimeout(code: string) {
    let turn = -1;
    let owed = 0;
    const w = wire({
      code,
      think: (_k, tc) => {
        if (turn < 0 && ++owed === 3) turn = tc;
        return tc === turn ? Infinity : 600;
      },
    });
    w.dealt();
    need(w.until(() => turn >= 0 && w.tableMoves().includes(turn)));
    for (let t = 0; t < 6; t++) w.step();
    need(w.host.phase === 'playing');
    w.restart((s) => {
      const after = s.plays[s.plays.length - 1].seen.find((f) => f.tc > turn && typeof f.now === 'number');
      need(after !== undefined);
      (after as SeenState).now = ((after as SeenState).now as number) - 20_000;
      return s;
    });
    w.finish();
    need(w.judged().includes(turn));
    return w;
  }

  it('a saved record in which the stamp of the state after a table move for the seat was moved back 20 s: the move seems early by it, but a damaged state fails nothing, so the hand is amber with the reason, never red', () => {
    const w = scenario((i) => damagedAfterTimeout(`MT${i}`));
    expect(w.verdict().failures).toEqual([]);
    expect(w.verdict().status).toBe('partial');
    expect(w.verdict().caveats).toContain('damaged');
  });

  it('a saved record with one digit of a state’s hash changed: that state is not compared with the replay, so the hand does not fail, whether the table times the seat out or the seat moves', () => {
    for (const moves of [false, true]) {
      const w = scenario((i) =>
        restartOnLiveTurn(`MH${moves ? 'P' : 'D'}${i}`, moves, (_p, r0) => {
          const k = r0.hash.search(/[0-9]/);
          need(k >= 0);
          r0.hash = r0.hash.slice(0, k) + String((Number(r0.hash[k]) + 1) % 10) + r0.hash.slice(k + 1);
        }),
      );
      expect(w.verdict().failures).toEqual([]);
    }
  });
});

describe('a seat opened on another device while the phone’s link was down', () => {
  /**
   * After the seat's third discard the phone's link drops for `away` ms. Meanwhile the player opens the
   * seat on a tablet, with the phone's token, and plays it there (the phone hears nothing of it, the
   * notice included). The phone then joins again on its token, which takes the seat back. If it stops
   * (`kicked`), the player resumes the table from Home on it 5 s later; the hand is played out.
   */
  function playedElsewhere(code: string, away = 40_000) {
    const w = wire({ code, botDelayMs: 1_000 });
    need(w.toDiscard(3));
    w.dropNow(away);
    w.step();
    const tablet = new TableClient(transportLink(w.hub.create('tablet'), 'host'), 'Tablet', undefined, { token: w.c.state.token ?? undefined });
    tablet.join();
    let played = 0;
    let acted = -1;
    while (w.pendingReconnectAt !== null && w.host.phase === 'playing') {
      const s = tablet.localState();
      if (!tablet.state.kicked && s && s.turnCounter !== acted && legalActions(s, 0).length > 0) {
        acted = s.turnCounter;
        tablet.act(chooseAction(s, 0, { seed: 'tablet' }) ?? legalActions(s, 0)[0]);
        played++;
      }
      w.step();
    }
    need(played > 0 && w.host.phase === 'playing');
    // The phone is back on its token.
    for (let t = 0; t < 4; t++) w.step();
    const kicked = w.c.state.kicked;
    if (kicked) {
      for (let t = 0; t < 10; t++) w.step();
      w.restart();
    }
    w.finish();
    return { w, kicked };
  }

  it('the phone, back on its token, is told the seat was held elsewhere and stops as if the lost notice had come; resumed from Home, the moves the tablet made are not taken for moves forged in the player’s name, so the hand is not red', () => {
    const { w, kicked } = scenario((i) => playedElsewhere(`SE${i}`));
    expect(w.verdict().failures).toEqual([]);
    expect(kicked).toBe(true);
  });

  /**
   * The link drops just as the phone is shown its seat's fourth discard, and the server's clock leaps a
   * minute, so the table times the seat out at once, long before its clock could have run out. The phone
   * joins again 3 s later and is welcomed with no word of another device; the server states the seat's
   * whole bank, so only the drop is judged. Once the phone has been shown the table's move on the new
   * link, the server says the seat was taken: with `notice` ('disconnected'), or with a second welcome on
   * the same link that says another device held the seat (`welcome`). The user resumes the table from
   * Home 5 s later and the hand is played out. With `relabel`, the hand's record writes the moves the
   * table made for the seat before the phone was back as the player's own.
   */
  function noticeAfterReturn(code: string, notice: 'welcome' | 'notice', relabel = false) {
    let lead = 0;
    let target = -1;
    let discards = 0;
    let back = false;
    let returnedAt = Number.POSITIVE_INFINITY;
    const last: { welcome: Extract<HostMessage, { t: 'welcome' }> | null } = { welcome: null };
    const w: Wire = wire({
      code,
      botDelayMs: 1_000,
      hostSkew: () => lead,
      // The seat never makes its fourth discard, from the moment it is shown it.
      think: (_k, tc) => {
        if (target < 0 && w.discardTurn() && w.host.game!.turnCounter === tc && ++discards === 4) target = tc;
        return tc === target ? Infinity : 600;
      },
      map: (m) => {
        if (m.t === 'welcome') last.welcome = m;
        if (relabel && m.t === 'hand_over') return { ...m, audit: { ...m.audit, log: m.audit.log.map((e) => (e.seat === 0 && e.source !== 'player' && e.n >= target && e.n < returnedAt ? { ...e, source: 'player' as const } : e)) } };
        return lead > 0 && m.t === 'state' ? { ...m, timeBank: 30 } : m;
      },
    });
    w.dealt();
    need(w.until(() => target >= 0));
    lead = 60_000;
    w.dropNow(3_000);
    need(w.until(() => w.pendingReconnectAt === null && (w.c.state.view?.turnCounter ?? -1) > target && w.tableMoves().includes(target), 20_000));
    need(last.welcome !== null);
    returnedAt = w.c.state.view!.turnCounter;
    back = true;
    w.line.inject(notice === 'notice' || !last.welcome ? { t: 'disconnected' } : { ...last.welcome, elsewhere: true });
    for (let t = 0; t < 10; t++) w.step();
    if (w.c.state.kicked) w.restart();
    w.finish();
    need(back && (w.c.state.lastAudit?.log ?? []).some((e) => e.seat === 0 && e.n === target && (relabel || e.source !== 'player')));
    return w;
  }

  it('a notice that the seat was taken, sent after the phone was back and shown the table’s move, does not excuse a move made inside the drop: red, whether a second welcome on the same link says it or a ‘disconnected’ does', () => {
    for (const notice of ['welcome', 'notice'] as const) expect(scenario((i) => noticeAfterReturn(`NA${notice}${i}`, notice)).verdict()).toMatchObject({ status: 'failed', failures: ['playedWhileDown'] });
  });

  it('the same notice, and the hand’s record writes the table’s moves inside the drop as the player’s own: the ledger still vouches for every turn before the last state the phone was shown while it held the seat, so the hand is red, not green', () => {
    for (const notice of ['welcome', 'notice'] as const) expect(scenario((i) => noticeAfterReturn(`NR${notice}${i}`, notice, true)).verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
  });

  /**
   * Honest: after the seat's fourth discard the player opens the seat on a tablet, with the phone's token,
   * while the phone's link is up; the server tells the phone at once. The tablet plays the seat for 20 s,
   * then the player resumes the table from Home on the phone, which takes the seat back. `edit` may change
   * the record the phone saved before it is restored; `kicked` runs on the phone's wire just before that, and
   * `resumed` right after the restored client has joined (`vouched` is then what its record vouches for).
   */
  function tabletWhileUp(code: string, edit?: (saved: SerializedClient) => SerializedClient, kicked?: (w: Wire) => void, resumed?: (w: Wire) => void) {
    const w = wire({ code, botDelayMs: 1_000 });
    need(w.toDiscard(4));
    need(w.until(() => !w.owes() && !w.current(), 20_000));
    const tablet = new TableClient(transportLink(w.hub.create('tablet'), 'host'), 'Tablet', undefined, { token: w.c.state.token ?? undefined });
    tablet.join();
    let played = 0;
    let acted = -1;
    for (let t = 0; t < 40 && w.host.phase === 'playing'; t++) {
      const s = tablet.localState();
      if (!tablet.state.kicked && s && s.turnCounter !== acted && legalActions(s, 0).length > 0) {
        acted = s.turnCounter;
        tablet.act(chooseAction(s, 0, { seed: 'tablet' }) ?? legalActions(s, 0)[0]);
        played++;
      }
      w.step();
    }
    need(w.c.state.kicked && played > 0 && w.host.phase === 'playing');
    kicked?.(w);
    let vouched = w.c.serialize().plays.at(-1)?.vouched ?? [];
    w.restart(edit);
    if (resumed) {
      resumed(w);
      vouched = w.c.serialize().plays.at(-1)?.vouched ?? [];
    }
    w.finish();
    return { w, vouched };
  }

  it('honest: a seat opened on a tablet while the phone’s link was up, played there, then taken back from Home: the ledger vouches for the turns before the notice, which are all the phone’s own, and the tablet’s moves after it are not held against the hand', () => {
    const { w, vouched } = scenario((i) => tabletWhileUp(`TU${i}`));
    expect(vouched).toHaveLength(1);
    expect(w.verdict().failures).toEqual([]);
  });

  it('a server restart that resumes the hand before the notice: the turns from there are played again, perhaps by the other device, so the ledger stops vouching where the hand resumed', () => {
    let before: Array<{ from: number; to: number }> = [];
    let r = -1;
    // (A restart drops every link: the notice reaches the phone when it is back, as the restored table's first word on the new link.)
    const { vouched } = scenario((i) =>
      tabletWhileUp(
        `TR${i}`,
        undefined,
        (w) => {
          before = w.c.serialize().plays.at(-1)?.vouched ?? [];
          need(before.length === 1 && before[0].to - before[0].from >= 3);
          r = before[0].to - 2;
          w.afterWelcome({ t: 'restored', handNumber: w.host.game!.handNumber, turnCounter: r });
        },
        (w) => w.line.pump(),
      ),
    );
    expect(vouched).toEqual([{ from: before[0].from, to: r }]);
  });

  it('honest: the same, with one move the phone sent changed in the record it saved (storage damage): the record no longer vouches for those turns, so the hand is not red', () => {
    const { w, vouched } = scenario((i) =>
      tabletWhileUp(`TD${i}`, (saved) => {
        const play = saved.plays[saved.plays.length - 1];
        const x = play.sent[play.sent.length - 1];
        x.tc += 1_000;
        return saved;
      }),
    );
    expect(vouched).toHaveLength(1);
    expect(w.verdict().failures).toEqual([]);
  });
});

describe('time bank: taken as the phone comes back in a new run of the app', () => {
  const banksOf = (host: TableHost) => (host as unknown as { banks: number[] }).banks;
  /**
   * After the seat's fourth discard, once it owes nothing, the app stops: the server says the seat was
   * opened on another device and the user resumes the table from Home 7 s later (`kick`), or the app is
   * closed for 7 s and opens again by itself. Either way a client restored from the saved record joins on
   * a new link, a new run of the app with no fixed point of its own. As it comes back the server takes the
   * seat's whole time bank (`take`), which every later state then states, and the seat leaves every later
   * turn to run out, so the table times it out after the turn clock alone. The bots take 12 s over each
   * move, so the seat's turns start more than 30 s apart. While the app is closed the phone's wall clock
   * may be set `step` ms.
   */
  function bankOnResume(code: string, kick: boolean, take: boolean, step = 0) {
    let back = false;
    let closedAt: number | null = null;
    const w = wire({
      code,
      botDelayMs: 12_000,
      think: () => (back ? Infinity : 600),
      background: (now) => closedAt !== null && !back && now >= closedAt,
      devSkew: () => (back ? step : 0),
    });
    need(w.toDiscard(4));
    need(w.until(() => !w.owes() && !w.current(), 20_000));
    if (kick) {
      w.line.inject({ t: 'disconnected' });
      need(w.c.state.kicked);
      for (let t = 0; t < 4; t++) w.step();
    }
    closedAt = w.clock.now;
    for (let t = 0; t < 14; t++) w.step();
    need(w.host.phase === 'playing');
    const from = w.host.game!.turnCounter;
    if (take) banksOf(w.host)[0] = 0;
    back = true;
    w.restart();
    w.finish();
    need(w.judged().some((n) => n > from));
    return w;
  }

  it('a server that takes the whole bank as the seat resumes from Home, or as the app restarts, and then times the seat out by its turn clock alone: red bankTaken (the new run pings the table within a second of joining, and its answer measures the time away)', () => {
    for (const kick of [true, false]) {
      const w = scenario((i) => bankOnResume(`BR${kick ? 'K' : 'R'}${i}`, kick, true));
      expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['bankTaken'] });
    }
  });

  it('honest: the same with the bank left as it was: green', () => {
    for (const kick of [true, false]) green(scenario((i) => bankOnResume(`BH${kick ? 'K' : 'R'}${i}`, kick, false)));
  });

  /**
   * Honest: the app is closed for 50 s while the seat owes its fourth discard, so the table runs out the
   * seat's turn clock and its whole bank and times it out; meanwhile the phone's wall clock may be set
   * `step` ms. The app opens again by itself and the seat plays every later turn.
   */
  function closedThroughBank(code: string, step: number) {
    let closedAt: number | null = null;
    let back = false;
    const w = wire({
      code,
      background: (now) => closedAt !== null && !back && now >= closedAt,
      devSkew: () => (back ? step : 0),
    });
    need(w.toDiscard(4));
    const owed = w.host.game!.turnCounter;
    closedAt = w.clock.now;
    for (let t = 0; t < 100; t++) w.step();
    need(w.host.phase === 'playing' && banksOf(w.host)[0] === 0 && w.tableMoves().includes(owed));
    back = true;
    w.restart();
    w.finish();
    need(w.judged().includes(owed));
    return w;
  }

  it.each([0, -60_000])('honest: the bank run out while the app was closed, the phone’s wall clock set %i ms meanwhile: never red; set back, only the run before can measure the time away, so the bank the server states may seem taken (amber with the reason)', (step) => {
    const v = scenario((i) => closedThroughBank(`BC${step}${i}`, step)).verdict();
    expect(v.status).toBe('partial');
    expect(v.failures).toEqual([]);
    if (step < 0) expect(v.caveats).toContain('appClock');
    else expect(v.caveats).not.toContain('appClock');
  });
});

describe('a flood of states sent again', () => {
  /**
   * The server shows the seat its third owed turn with its clock cut to 5 s (`cut`), or as it is, and the
   * seat leaves it to run out, so the table times it out. Then the server sends the state on show `n`
   * times more, freshly stamped, a hundred every half second: more than the record of a hand keeps.
   */
  function floodAfterTurn(code: string, cut: boolean, n = 650) {
    let owed = 0;
    let cutTc = -1;
    const last: { state: StateMsg | null } = { state: null };
    const w = wire({
      code,
      botDelayMs: 1_000,
      think: (_k, tc) => (tc === cutTc ? Infinity : 600),
      map: (m, w) => {
        if (m.t !== 'state') return m;
        let out = m;
        if (cutTc < 0 && w.owes() && w.host.game!.turnCounter === m.view.turnCounter && typeof m.now === 'number' && !m.inTimeBank && legalActions(w.host.game!, 0).every((a) => a.type === 'discard') && ++owed === 3) {
          cutTc = m.view.turnCounter;
          if (cut) out = { ...m, deadline: m.now + 5_000 };
        }
        last.state = out;
        return out;
      },
    });
    w.dealt();
    need(w.until(() => cutTc >= 0 && w.tableMoves().includes(cutTc) && w.host.game!.turnCounter > cutTc + 1));
    for (let sent = 0; sent < n && w.host.phase === 'playing'; ) {
      for (let k = 0; k < 100 && sent < n; k++, sent++) w.line.inject({ ...last.state!, now: w.clock.now });
      w.step();
    }
    w.finish();
    const play = (w.c as unknown as { plays: PlayRecord[] }).plays.find((p) => p.hand === 0);
    need(w.judged().includes(cutTc) && play !== undefined);
    return { w, play: play! };
  }

  it('the turn cut to 5 s before the flood still fails its hand: a state sent again for a turn already held gives way first, so the cut state is kept, and the hand also says its record ran over', () => {
    const { w, play } = scenario((i) => floodAfterTurn(`FL${i}`, true));
    expect(play.seen.length).toBe(600);
    expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['lateTurn'], caveats: ['overflow'] });
  });

  it('the same flood after a turn shown as it was: the record ran over, so the hand is amber with the reason, never green', () => {
    const { w } = scenario((i) => floodAfterTurn(`FN${i}`, false));
    expect(w.verdict()).toEqual({ status: 'partial', failures: [], caveats: ['overflow'] });
  });

  it('the record keeps the first and the latest copy of a state sent again over one link, and drops the oldest state only when there is no copy to drop', () => {
    const f = (tc: number, at: number, epoch = 1): SeenState => ({ tc, epoch, era: 0, at, owes: false, deadline: null, timeBank: 0, inBank: false, hash: `h${tc}` });
    // Turn 0, then turn 5 again and again over one link: a copy between the first and the latest gives way.
    const copies: PlayRecord = { hand: 0, seen: [f(0, 0), ...Array.from({ length: MAX_SEEN }, (_, i) => f(5, i + 1))], sent: [], ledgerFrom: 0 };
    keepSeen(copies);
    expect(copies.seen.length).toBe(MAX_SEEN);
    expect(copies.seen.map((x) => x.at).slice(0, 3)).toEqual([0, 1, 3]);
    expect(copies.seen.at(-1)!.at).toBe(MAX_SEEN);
    expect(copies.overflow).toBe(true);
    // The same turn over another link is a state of its own: with no copy left to drop, the oldest goes.
    const links: PlayRecord = { hand: 0, seen: Array.from({ length: MAX_SEEN + 1 }, (_, i) => f(5, i, i)), sent: [], ledgerFrom: 0 };
    keepSeen(links);
    expect(links.seen.map((x) => x.at)[0]).toBe(1);
    expect(links.seen.length).toBe(MAX_SEEN);
    // Within the limit nothing is dropped, and the record is whole.
    const few: PlayRecord = { hand: 0, seen: [f(1, 1), f(1, 2), f(1, 3)], sent: [], ledgerFrom: 0 };
    keepSeen(few);
    expect([few.seen.length, few.overflow]).toEqual([3, undefined]);
  });

  it('honest: the same hand without the flood keeps every state it was shown, and is green', () => {
    const { w, play } = scenario((i) => floodAfterTurn(`FH${i}`, false, 0));
    expect(play.seen.length).toBeLessThan(150);
    expect(play.overflow).toBeUndefined();
    green(w);
  });
});

describe('the table’s answers to the phone’s pings: how late a turn may come, a move in flight, the app’s pauses', () => {
  const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
  const HYPER = withRules({ handsPerMatch: 1, turnSeconds: 4, timeBankSeconds: 0 });
  const TURBO = withRules({ handsPerMatch: 1, turnSeconds: 7, timeBankSeconds: 10 });
  const counts = (w: Wire) => w.c.state.turnsShownLate.reduce((n, r) => ({ late: n.late + r.late.length, of: n.of + r.of }), { late: 0, of: 0 });
  const internals = (w: Wire) => w.host as unknown as { handle: (from: string, msg: unknown) => void; banks: number[]; botSkill: BotSkill; matchId: string };

  /**
   * From the state that shows the seat its second discard on, the server holds every frame it sends the
   * phone (pongs and clock frames too) for `ms`, then lets them go in order, as made: a stall of its own
   * making. The seat moves 600 ms after it is shown a move, or (`idle`) leaves the held one to run out.
   */
  function stall(code: string, rules: RuleSet, ms: number, idle: boolean) {
    const st = { from: -1, tc: -1, done: false };
    const turns = new Set<number>();
    const w: Wire = wire({
      code,
      rules,
      think: (_k, tc) => (idle && tc === st.tc ? Infinity : 600),
      hold: (m, w) => {
        if (st.done) return false;
        if (st.from < 0 && m.t === 'state' && w.discardTurn() && w.host.game!.turnCounter === m.view.turnCounter && !turns.has(m.view.turnCounter)) {
          turns.add(m.view.turnCounter);
          if (turns.size === 2) {
            st.from = w.clock.now;
            st.tc = m.view.turnCounter;
          }
        }
        return st.from >= 0;
      },
      onTick: (w) => {
        if (st.from >= 0 && !st.done && w.clock.now - st.from >= ms) {
          st.done = true;
          w.line.release();
        }
      },
    });
    w.finish();
    need(st.done && w.c.state.lastAudit !== null);
    return { w, st };
  }

  it('a turn the server holds, as made, for half its clock and a second more is amber: 8.5 s at Normal, 3 s at Hyper (it was 17 s at every speed) (T8)', () =>
    scenario((i) => {
      for (const [rules, ms] of [
        [NORMAL, 8_500],
        [HYPER, 3_000],
      ] as const) {
        const { w } = stall(`G8a${ms}${i}`, rules, ms, false);
        expect(w.verdict()).toMatchObject({ status: 'partial', failures: [] });
        expect(w.verdict().caveats).toContain('lateShown');
      }
    }));

  it('held a second less than half its clock: green, and counted when later than half of that (Normal: 6.5 s counted, 3 s not) (T8)', () =>
    scenario((i) => {
      const near = stall(`G8b${i}`, NORMAL, 6_500, false);
      green(near.w);
      expect(counts(near.w).late).toBe(1);
      const short = stall(`G8c${i}`, NORMAL, 3_000, false);
      green(short.w);
      expect(counts(short.w).late).toBe(0);
    }));

  it('every frame held 12 s as made (a stall the server makes), the seat timed out, Normal: amber, the table moved on a turn that reached the phone late (it was green) (T9)', () =>
    scenario((i) => {
      const { w, st } = stall(`G9${i}`, NORMAL, 12_000, true);
      need(w.judged().includes(st.tc));
      expect(w.drops).toEqual([]);
      expect(w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(w.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
    }));

  /** The server waits for the seat's commitment and secret however late they come (as a server may). */
  const waitForShare = (seat: number) => (w: Wire) => {
    const h = w.host as unknown as { phase: string; deadline: number | null; seats: Array<{ commit?: string; secret?: string }>; now: () => number };
    const s = h.seats[seat];
    if (((h.phase === 'commit' && !s.commit) || (h.phase === 'reveal' && !s.secret)) && h.deadline !== null) h.deadline = Math.max(h.deadline, h.now() + 5_000);
  };

  /**
   * The eighth assessment's item 2: the first stamped frame the phone gets is sent at once with its stamp
   * moved back `d` ms; every frame after it reaches the phone `d` late under its honest stamp, pongs
   * included. Seat 1, two hands, the seat moving 1.2 s after it is shown a move.
   */
  function backThenLate(code: string, d: number, turnSeconds: number, timeBankSeconds: number, followOwn = false) {
    let stamped = 0;
    const w: Wire = wire({
      code,
      seat: 1,
      rules: withRules({ handsPerMatch: 2, turnSeconds, timeBankSeconds }),
      // With `followOwn` the seat follows the app's own clock: it moves 1.2 s after it is shown a move, or half a second
      // before that clock runs out if sooner, and not at all when it shows half a second or less.
      think: () => {
        const o = followOwn ? w.c.ownClock() : null;
        const left = o ? o.bankEnd - w.c.clockNow() : Number.POSITIVE_INFINITY;
        return left <= 500 ? Infinity : Math.min(1_200, left - 500);
      },
      map: (m) => {
        const s = stampOf(m);
        if (s === undefined) return m;
        stamped++;
        return stamped === 1 ? ({ ...m, now: s - d } as HostMessage) : m;
      },
      delay: () => (stamped > 1 ? d : 0),
      onTick: waitForShare(1),
    });
    return w;
  }
  const playOut = (w: Wire) => {
    for (let g = 0; g < 14_400 && !w.c.state.matchOver; g++) w.step();
  };
  const noGreen = (w: Wire) => {
    const audits = w.c.state.audits;
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(a.status).not.toBe('ok');
    // Red only by the 30 s a move may lie unanswered.
    expect(new Set(audits.flatMap((a) => a.failures).map((f) => failureKey(f)))).toEqual(new Set(audits.some((a) => a.failures.length > 0) ? ['moveIgnored'] : []));
  };

  it('item 2, as the app plays it: the ping behind the join goes out first, so the frame stamped back is its answer; then every frame 25 s late at Normal, or 20 s at Turbo: no green hand, and every turn the phone measured is counted (T10)', () =>
    scenarioAsync(async (i) => {
      for (const [d, turn, bank] of [
        [25_000, 15, 30],
        [20_000, 7, 10],
      ] as const) {
        const w = backThenLate(`I2a${d}${i}`, d, turn, bank);
        await Promise.resolve();
        playOut(w);
        need(w.c.state.audits.length >= 2);
        noGreen(w);
        const { late, of } = counts(w);
        expect(of).toBeGreaterThan(0);
        expect(late).toBe(of);
      }
    }));

  it('item 2 with the deal itself as the frame stamped back 25 s: the deal says the table’s clock is 25 s behind, and the audit and the app’s own clock both take it so; a seat that follows that clock moves with time on it, the table playing over that move is noted, no hand is green, and the Fair play count, which measures against the answers to the pings alone, counts every turn (T10)', () =>
    scenario((i) => {
      const w = backThenLate(`I2b${i}`, 25_000, 15, 30, true);
      playOut(w);
      need(w.c.state.audits.length >= 2);
      noGreen(w);
      for (const a of w.c.state.audits) expect(a.failures.length > 0 || a.caveats.map((c) => caveatKey(c)).includes('inFlight')).toBe(true);
      const { late, of } = counts(w);
      expect(of).toBeGreaterThan(0);
      expect(late).toBe(of);
    }));

  /** Every frame `ms` late from the hand's first state on, under honest stamps; the seat moves 0.8 s after it is shown a move. */
  function lateFromStart(code: string, rules: RuleSet, ms: number) {
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
    return w;
  }

  it.each([
    ['Turbo', TURBO],
    ['Hyper', HYPER],
  ] as const)('item 3, %s: every frame 15 s late from the start under honest stamps is amber (it was green); with no delay, green (T11)', (_name, rules) =>
    scenario((i) => {
      const late = lateFromStart(`I3a${rules.turnSeconds}${i}`, rules, 15_000);
      need(late.judged().length > 0);
      expect(late.verdict().status).toBe('partial');
      expect(late.verdict().caveats).toEqual(expect.arrayContaining(['tableMovedLate', 'lateShown']));
      green(lateFromStart(`I3b${rules.turnSeconds}${i}`, rules, 0));
    }),
  );

  /**
   * The server never sends the seat the state that starts its turn on the link it has (after the deal): it
   * closes that link instead (up to three times). The phone joins again; the server holds the join until `left` ms
   * before the seat's clock runs out (null: it lets it through at once), then answers as an honest host
   * answers a rejoin: the welcome, and the state stamped then, its deadline still running. The seat
   * moves `think` ms after it is shown a move.
   */
  function kickAtTurn(code: string, rules: RuleSet, left: number | null, think: number) {
    let holdUntil = Number.NEGATIVE_INFINITY;
    let dead: string | null = null;
    let closeNow = false;
    const kicked = new Set<number>();
    const w: Wire = wire({
      code,
      rules,
      think: () => think,
      // The bots take 0.7 s over each move, as the server's do.
      botDelayMs: 700,
      up: (now) => Math.max(0, holdUntil - now),
      map: (m, w) => {
        if (dead === w.line.id) return null;
        // (Not the deal itself: a link lost before the hand's first state was the deal's.)
        if (m.t === 'state' && m.view.turnCounter > 0 && kicked.size < 3 && w.discardTurn() && w.host.game!.turnCounter === m.view.turnCounter && !kicked.has(m.view.turnCounter) && w.clock.now >= holdUntil) {
          kicked.add(m.view.turnCounter);
          holdUntil = left === null ? w.clock.now : w.clock.now + rules.turnSeconds * 1_000 + internals(w).banks[0] - left;
          dead = w.line.id;
          closeNow = true;
          return null;
        }
        return m;
      },
      onTick: (w) => {
        if (!closeNow) return;
        closeNow = false;
        w.dropNow(Math.max(500, holdUntil - 200 - w.clock.now));
      },
    });
    w.finish();
    need(kicked.size > 0);
    return w;
  }

  it.each([
    ['Hyper', HYPER, 800, 1_500],
    ['Turbo', TURBO, 1_500, 3_000],
  ] as const)('a reconnect forced as the turn starts, the turn let through on the new link %s with too little of its clock left: amber, the table played while the link was down (it was green); a rejoin let through at once: green (T12)', (_name, rules, left, think) =>
    scenario((i) => {
      const kicked = kickAtTurn(`KT${rules.turnSeconds}${i}`, rules, left, think);
      need(kicked.judged().length > 0);
      expect(kicked.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(kicked.verdict().caveats).toContain('tableMoved');
      green(kickAtTurn(`KC${rules.turnSeconds}${i}`, rules, null, think));
    }),
  );

  /**
   * Normal turns, no bank. On the seat's third discard the seat moves `think` ms after it is shown the
   * turn, with a discard other than the one the table's timeout rule plays (`illegal`: a tile it does not
   * hold), and the server drops that move unseen, so the table times the seat out.
   */
  function dropMove(code: string, think: number, illegal = false) {
    const rules = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 0 });
    const st = { tc: -1, discards: 0, dropped: 0 };
    const w: Wire = wire({
      code,
      rules,
      think: (_k, tc) => {
        const s = w.c.localState();
        const discard = !!s && legalActions(s, 0).every((a) => a.type === 'discard');
        if (discard && st.tc < 0 && ++st.discards === 3) st.tc = tc;
        return tc === st.tc ? think : 600;
      },
    });
    const act = w.c.act.bind(w.c);
    w.c.act = (a: Action) => {
      const s = w.c.localState();
      if (!s || s.turnCounter !== st.tc) return act(a);
      const own = tableRule(s, 0, 'timeout', internals(w).botSkill, internals(w).matchId);
      const other = legalActions(s, 0).find((x) => x.type === 'discard' && own?.type === 'discard' && x.tile !== own.tile);
      // A tile the seat does not hold: the table refuses the move at once.
      if (illegal) return act({ type: 'discard', tile: [...Array(144).keys()].find((t) => !s.players[0].hand.includes(t))! });
      return act(other ?? a);
    };
    const h = internals(w);
    const handle = h.handle.bind(w.host);
    h.handle = (from, msg) => {
      const m = msg as { t?: string; turnCounter?: number };
      if (!illegal && m?.t === 'action' && m.turnCounter === st.tc && from.startsWith('p0')) return void st.dropped++;
      handle(from, msg);
    };
    w.finish();
    need(st.tc >= 0 && w.judged().includes(st.tc) && (illegal || st.dropped === 1));
    return w;
  }

  it('a move sent with 6 s of its clock left that the server drops, the table playing its own: amber, the move was in flight (it was green) (T13)', () =>
    scenario((i) => {
      const w = dropMove(`IF6${i}`, 9_000);
      expect(w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(w.verdict().caveats).toContain('inFlight');
    }));

  it('the same with 1 s left: green (a move made in the last 1.5 s may honestly arrive too late); a move refused as illegal: nothing in flight (T13)', () =>
    scenario((i) => {
      green(dropMove(`IF1${i}`, 14_000));
      const bad = dropMove(`IFX${i}`, 9_000, true);
      expect(bad.verdict().caveats).not.toContain('inFlight');
      expect(bad.verdict().failures).toEqual([]);
    }));

  /**
   * The run-behind: every frame but a pong reaches the phone 10 s after the table made it, under its honest
   * stamp; every pong goes back at once, stamped 10 s back, so that every fixed point agrees with a clock
   * 10 s behind. Normal turns, no bank. On every move the seat waits `wait(left)` ms, `left` being what the
   * app's own clock shows when the move is shown.
   */
  function runBehind(code: string, wait: (left: number) => number) {
    const D = 10_000;
    const w: Wire = wire({
      code,
      rules: withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 0 }),
      map: (m, w) => {
        if (m.t !== 'pong') return m;
        w.line.inject({ ...m, now: m.now - D });
        return null;
      },
      delay: () => D,
      onTick: waitForShare(0),
      think: () => {
        const o = w.c.ownClock();
        return o ? wait(o.bankEnd - w.c.clockNow()) : 600;
      },
    });
    w.finish();
    return w;
  }

  it('a server that runs its clock 10 s behind and answers every ping at once: a seat that moves 1 s after its own clock starts is green; one that moves with 3 s left on its own clock, which the table plays over, is amber; the count sees nothing (a stated limit) (T14)', () =>
    scenario((i) => {
      const quick = runBehind(`RB1${i}`, () => 1_000);
      need(quick.c.state.lastAudit !== null);
      green(quick);
      expect(counts(quick).late).toBe(0);
      const slow = runBehind(`RB3${i}`, (left) => left - 3_000);
      need(slow.judged().length > 0);
      expect(slow.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(slow.verdict().caveats).toContain('inFlight');
      expect(counts(slow).late).toBe(0);
    }));

  /**
   * On the seat's third discard the seat moves at once and the server drops the move unseen; the app then
   * does not run for `asleep` ms (0: it runs on). Normal, 15 + 30 s: the table times the seat out 45 s after
   * the turn began, on the link that stayed up.
   */
  function lyingMove(code: string, asleep: number) {
    const st = { tc: -1, discards: 0, at: Number.POSITIVE_INFINITY };
    const w: Wire = wire({
      code,
      asleep: (now) => now >= st.at && now < st.at + asleep,
      think: (_k, tc) => {
        const s = w.c.localState();
        if (s && legalActions(s, 0).every((a) => a.type === 'discard') && st.tc < 0 && ++st.discards === 3) st.tc = tc;
        return 600;
      },
    });
    // A discard other than the one the table's timeout rule plays.
    const act = w.c.act.bind(w.c);
    w.c.act = (a: Action) => {
      const s = w.c.localState();
      if (!s || s.turnCounter !== st.tc) return act(a);
      const own = tableRule(s, 0, 'timeout', internals(w).botSkill, internals(w).matchId);
      return act(legalActions(s, 0).find((x) => x.type === 'discard' && own?.type === 'discard' && x.tile !== own.tile) ?? a);
    };
    const h = internals(w);
    const handle = h.handle.bind(w.host);
    h.handle = (from, msg) => {
      const m = msg as { t?: string; turnCounter?: number };
      if (m?.t === 'action' && m.turnCounter === st.tc && from.startsWith('p0')) {
        st.at = w.clock.now;
        return;
      }
      handle(from, msg);
    };
    w.finish();
    need(st.tc >= 0 && w.judged().includes(st.tc));
    return w;
  }

  it('a move the app sent just before the phone slept 50 s, which never reached the table: amber (in flight), not red: the 30 s a move may lie unanswered leave out the time the app did not run (T15)', () =>
    scenario((i) => {
      const w = lyingMove(`SL50${i}`, 50_000);
      expect(w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(w.verdict().caveats).toContain('inFlight');
    }));

  it('the same with the app running all along, the move left lying 44 s on a live link: red, as before (T15)', () =>
    scenario((i) => {
      const w = lyingMove(`SL0${i}`, 0);
      expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['moveIgnored'] });
    }));

  /**
   * After the seat's third discard the app goes to the background for 40 s (its clock runs on); the bots
   * take 2 s over each move, so the seat's next turn is sent while the app is not running. The server
   * lets the frames sent in that time reach the phone `extra` ms after the app is back.
   */
  function sentWhilePaused(code: string, extra: number) {
    const st = { discards: 0, from: Number.POSITIVE_INFINITY, tc: -1 };
    const away = (now: number) => now >= st.from && now < st.from + 40_000;
    const w: Wire = wire({
      code,
      botDelayMs: 2_000,
      background: away,
      think: (_k, tc) => {
        const s = w.c.localState();
        if (s && legalActions(s, 0).every((a) => a.type === 'discard') && st.tc < 0 && ++st.discards === 3) st.tc = tc;
        return 600;
      },
      delay: (_m, now) => (away(now) ? st.from + 40_000 + extra - now : 0),
      onTick: (w) => {
        if (st.tc >= 0 && st.from === Number.POSITIVE_INFINITY && w.c.localState()?.turnCounter !== st.tc) st.from = w.clock.now;
      },
    });
    w.finish();
    need(st.from < Number.POSITIVE_INFINITY && [...w.created.keys()].some((tc) => away(w.created.get(tc)!)));
    return w;
  }

  it('a turn sent while the app was in the background for 40 s: handled as it comes back, or held 4 s more (past the grace for frames that waited in the device), green: the pause is not the server’s doing; held 9 s more after it is back, amber (T16)', () =>
    scenario((i) => {
      green(sentWhilePaused(`PW0${i}`, 0));
      green(sentWhilePaused(`PW4${i}`, 4_000));
      const held = sentWhilePaused(`PW9${i}`, 9_000);
      expect(held.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(held.verdict().caveats).toContain('lateShown');
    }));
});
