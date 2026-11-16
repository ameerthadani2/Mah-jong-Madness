/**
 * The table may move for a connected seat only after its time has run out, and may not turn the
 * seat's own moves away. How long a seat has is worked out by its client from the rules and from
 * what it saw earlier in the hand, not from the clock fields of the frame in front of it; how long
 * it was given is measured on the host's time stamps, which the client believes only as far as
 * its own clock allows. A legal move that is refused, or left lying until the clock runs out,
 * fails the audit. Honest tables with slow links, clocks that disagree and reconnects mid-turn
 * are never flagged.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type Action, type GameState } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink, type HostMessage, type Link } from '../src/index';
import { Missed, scenario, seededDeals } from './support';

seededDeals();

/** A test on a fresh deal, dealt again when the turn it needs does not come up. */
const deal = (name: string, fn: () => void) => it(name, () => scenario(fn));
/** The deal did not bring the situation the test is about. */
const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

type StateMsg = Extract<HostMessage, { t: 'state' }>;

interface HostInternals {
  phase: string;
  game: GameState | null;
  banks: number[];
  stateMsg: (seat: number) => HostMessage;
  apply: (seat: number, action: Action, source: 'player' | 'bot' | 'timeout') => void;
  handle: (from: string, msg: unknown) => void;
  sendTo: (peerId: string, msg: HostMessage) => void;
}
const internals = (host: TableHost) => host as unknown as HostInternals;

const TURN = 15_000;
const BANK = 30_000;
const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

/** A link whose frames from the host wait in `inbox` while `hold` is set, and whose frames to the host wait in `outbox` while `stall` is set. */
function laggy(hub: LoopbackHub, id: string) {
  const t = hub.create(id);
  const base = transportLink(t, 'host');
  const inbox: HostMessage[] = [];
  const outbox: Array<() => void> = [];
  let cb: ((m: HostMessage) => void) | null = null;
  const ctl = {
    hold: false,
    stall: false,
    link: {
      ...base,
      send: (msg) => {
        if (ctl.stall) outbox.push(() => base.send(msg));
        else base.send(msg);
      },
      onMessage: (f) => {
        cb = f;
        return base.onMessage((m) => {
          if (ctl.hold) inbox.push(m);
          else f(m);
        });
      },
    } as Link,
    /** Deliver what the network was holding (both ways). */
    flush() {
      for (const m of inbox.splice(0)) cb?.(m);
      for (const f of outbox.splice(0)) f();
    },
  };
  return ctl;
}

function table(code: string, opts: { skew?: number } = {}) {
  const clock = { now: 1_000_000 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, now: () => clock.now, matchId: `m-${code}` });
  const net = laggy(hub, 'p0');
  // The device's clock is its own: hours away from the host's.
  const c = new TableClient(net.link, 'Victim', undefined, {}, { now: () => clock.now + (opts.skew ?? 0) });
  c.join();
  host.start();
  return { clock, hub, host, h: internals(host), c, net };
}

type T = ReturnType<typeof table>;
const myTurn = (t: T) => {
  const s = t.c.localState();
  return !!s && t.host.phase === 'playing' && legalActions(s, 0).length > 0;
};
const act = (t: T) => t.c.act(chooseAction(t.c.localState()!, 0, { seed: 'p' })!);

/** Let the table's clock run in half-second ticks, as the server does. */
function wait(t: T, ms: number) {
  for (let left = ms; left > 0; left -= 500) {
    t.clock.now += Math.min(500, left);
    t.host.tick();
  }
}

/** Play the hand out: `onTurn(n)` decides what happens on the seat's n-th turn (true: handled). */
function play(t: T, onTurn: (n: number) => boolean | void) {
  let n = 0;
  let guard = 0;
  while (t.host.phase === 'playing' && guard++ < 4000) {
    if (myTurn(t)) {
      if (!onTurn(n++)) act(t);
    } else wait(t, 60_000);
  }
  expect(t.host.phase).toBe('hand_over');
}

const early = (t: T) => t.c.state.auditFailures.filter((f) => f.includes('clock had not run out')).length;

describe('the table plays for a connected seat only after its time has run out', () => {
  deal('clock fields forged in the frame (already in the bank, 100 ms left) do not excuse an early move', () => {
    const t = table('CK1');
    const orig = t.h.stateMsg.bind(t.host);
    t.h.stateMsg = (seat) => {
      const m = orig(seat) as StateMsg;
      return seat === 0 && m.deadline !== null ? { ...m, deadline: t.clock.now + 100, timeBank: 0, inTimeBank: true } : m;
    };
    let forced = 0;
    play(t, (n) => {
      if (n > 2) return false;
      // The server moves for the seat 200 ms after showing it its turn.
      t.clock.now += 200;
      t.h.apply(0, chooseAction(t.host.game!, 0)!, 'timeout');
      forced++;
      return true;
    });
    need(forced > 0);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(early(t)).toBe(forced);
  });

  deal('time stamps that leap ahead of this device’s clock do not excuse it either', () => {
    for (const standIn of [false, true]) {
      const t = table(standIn ? 'CK2S' : 'CK2');
      let leap = 0;
      const orig = t.h.stateMsg.bind(t.host);
      t.h.stateMsg = (seat) => {
        const m = orig(seat) as StateMsg;
        return { ...m, now: (m.now ?? 0) + leap, deadline: m.deadline === null ? null : m.deadline + leap };
      };
      const origSend = t.h.sendTo.bind(t.host);
      t.h.sendTo = (peer, msg) => origSend(peer, msg.t === 'hand_over' ? { ...msg, now: (msg.now ?? 0) + leap } : msg);
      play(t, (n) => {
        if (n !== 1) return false;
        // The host claims 50 s went by; on this device none did.
        leap += 50_000;
        t.h.apply(0, chooseAction(t.host.game!, 0)!, 'timeout');
        return true;
      });
      need(leap > 0);
      expect(early(t)).toBe(1);
    }
  });

  deal('a time bank the seat never used cannot be written off', () => {
    const t = table('CK3');
    let emptied = false;
    play(t, (n) => {
      if (n !== 2) return false;
      // The host empties the bank and times the seat out after the turn clock alone.
      t.h.banks[0] = 0;
      t.h.sendTo('p0', t.h.stateMsg(0));
      wait(t, TURN + 1_000);
      emptied = true;
      return true;
    });
    need(emptied);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(early(t)).toBe(1);
  });

  deal('honest: a bank partly used on one move and run out on a later one is not flagged', () => {
    const t = table('CK4', { skew: 5 * 3_600_000 });
    let timedOut = 0;
    play(t, (n) => {
      if (n === 1) {
        // Ten seconds into the bank, then the move.
        wait(t, TURN + 10_000);
        expect(t.c.state.inTimeBank).toBe(true);
        return false;
      }
      if (n === 3 || n === 5) {
        // Away from the phone: the table waits out the turn clock and what is left of the bank, then moves.
        const before = t.host.game!.turnCounter;
        let guard = 0;
        while (t.host.phase === 'playing' && t.host.game!.turnCounter === before && guard++ < 400) wait(t, 500);
        timedOut++;
        return true;
      }
      return false;
    });
    need(timedOut > 0);
    expect([t.c.state.auditStatus, t.c.state.auditFailures]).toEqual(['ok', []]);
  });

  deal('honest: frames that arrive seconds late, in bursts, over a link that stays up are not flagged', () => {
    const t = table('CK5', { skew: -7 * 3_600_000 });
    let late = 0;
    play(t, (n) => {
      if (n % 2 === 0) return false;
      late++;
      // The frame showing the turn sits in the network for 8 s; the player is away; the timeout's frames then arrive at once.
      t.net.hold = true;
      wait(t, 8_000);
      t.net.hold = false;
      t.net.flush();
      const before = t.host.game!.turnCounter;
      let guard = 0;
      while (t.host.phase === 'playing' && t.host.game!.turnCounter === before && guard++ < 400) wait(t, 500);
      return true;
    });
    need(late > 0);
    expect([t.c.state.auditStatus, t.c.state.auditFailures]).toEqual(['ok', []]);
  });

  deal('honest: the phone sleeps through a whole turn and gets the frames in one burst', () => {
    const t = table('CK6');
    let slept = false;
    play(t, (n) => {
      act(t);
      if (n !== 2 || t.host.phase !== 'playing') return true;
      // Nothing reaches the app until it wakes: its next turn, the bank frame and the timeout all arrive together.
      t.net.hold = true;
      let guard = 0;
      while (t.host.phase === 'playing' && legalActions(t.host.game!, 0).length === 0 && guard++ < 2000) wait(t, 500);
      if (t.host.phase === 'playing') {
        wait(t, TURN + BANK + 1_000);
        slept = true;
      }
      t.net.hold = false;
      t.net.flush();
      return true;
    });
    need(slept);
    expect([t.c.state.auditStatus, t.c.state.auditFailures]).toEqual(['ok', []]);
  });

  deal('honest: a reconnect in the middle of a turn that the host never noticed keeps the old clock and is not flagged', () => {
    const t = table('CK7');
    let swapped = false;
    play(t, (n) => {
      if (n !== 2) return false;
      wait(t, 9_000);
      // The phone moved networks: a new link, the same seat, and the host had not seen the old one drop.
      t.c.rebind(transportLink(t.hub.create('p0b'), 'host'));
      t.c.join();
      swapped = true;
      const before = t.host.game!.turnCounter;
      let guard = 0;
      while (t.host.phase === 'playing' && t.host.game!.turnCounter === before && guard++ < 400) wait(t, 500);
      // The table timed the seat out on the clock it started 9 s before the reconnect.
      return true;
    });
    need(swapped);
    expect(t.c.state.auditFailures).toEqual([]);
    expect(t.c.state.auditStatus).toBe('ok');
  });
});

describe('what the table plays for a seat whose time has run out', () => {
  /** Runs the seat out of time on the first offer that matches, and reports what the table then played for it. */
  function timedOutOffer(code: string, wanted: (offered: Action[], asABot: Action | null) => boolean) {
    const t = table(code);
    const origApply = t.h.apply.bind(t.host);
    const played: Action[] = [];
    t.h.apply = (seat, action, source) => {
      if (seat === 0 && source === 'timeout') played.push(action);
      origApply(seat, action, source);
    };
    let melds = -1;
    let after = -1;
    play(t, () => {
      const s = t.c.localState()!;
      if (melds >= 0 || s.phase !== 'claim' || !wanted(legalActions(s, 0), chooseAction(t.host.game!, 0, { seed: 'timeout:0', skill: 'club' }))) return false;
      melds = t.host.game!.players[0].melds.length;
      wait(t, TURN + BANK + 1_000);
      after = t.host.game?.players[0].melds.length ?? -1;
      return true;
    });
    need(melds >= 0);
    return { t, played, melds, after };
  }

  deal('a Chow, Pong or Kong offered on a discard is passed, never taken: the table does not open a hand for its player', () => {
    // The offer is one a bot in the seat would take, so playing the seat as a bot would open the hand.
    const r = timedOutOffer('TO1', (offered, asABot) => !offered.some((a) => a.type === 'hu') && (asABot?.type === 'chi' || asABot?.type === 'pong' || asABot?.type === 'kong'));
    expect(r.played[0]).toEqual({ type: 'pass' });
    expect(r.after).toBe(r.melds);
    expect([r.t.c.state.auditStatus, r.t.c.state.auditFailures]).toEqual(['ok', []]);
  });

  // A win on a discard comes up in few hands, so this one is given more deals to find it (the deals are seeded: the same one every run).
  it('a win offered on a discard is taken', () =>
    scenario(() => {
      const r = timedOutOffer('TO2', (offered) => offered.some((a) => a.type === 'hu'));
      expect(r.played[0]).toEqual({ type: 'hu' });
      expect(r.t.host.phase).toBe('hand_over');
      expect([r.t.c.state.auditStatus, r.t.c.state.auditFailures]).toEqual(['ok', []]);
    }, 400));

  deal('its own turn is still played as a bot would play it', () => {
    const t = table('TO3');
    const origApply = t.h.apply.bind(t.host);
    const played: Array<{ action: Action; expected: Action | null }> = [];
    t.h.apply = (seat, action, source) => {
      if (seat === 0 && source === 'timeout') played.push({ action, expected: chooseAction(t.host.game!, 0, { seed: 'timeout:0', skill: 'club' }) });
      origApply(seat, action, source);
    };
    let done = false;
    play(t, () => {
      const s = t.c.localState()!;
      if (done || s.phase !== 'discard') return false;
      done = true;
      wait(t, TURN + BANK + 1_000);
      return true;
    });
    need(done && played.length > 0);
    expect(played[0].action).toEqual(played[0].expected);
  });
});

describe('the table may not turn the seat’s own moves away', () => {
  deal('a legal move refused as "illegal", then played by the table after the clock ran out, fails', () => {
    const t = table('RF1');
    const orig = t.h.handle.bind(t.host);
    let refused = 0;
    t.h.handle = (from, msg) => {
      const m = msg as { t?: string; action?: Action; turnCounter?: number };
      if (from === 'p0' && m.t === 'action' && m.action?.type === 'discard' && refused < 2) {
        refused++;
        t.h.sendTo(from, { t: 'error', code: 'illegal', message: 'Not a legal move.', turnCounter: m.turnCounter });
        t.h.sendTo(from, t.h.stateMsg(0));
        return;
      }
      orig(from, msg);
    };
    play(t, () => {
      const tc = t.host.game!.turnCounter;
      act(t);
      // Refused: the honest clock runs out and the table plays its own choice.
      if (t.host.phase === 'playing' && t.host.game!.turnCounter === tc) wait(t, TURN + BANK + 1_000);
      return true;
    });
    need(refused === 2);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures.filter((f) => f.startsWith('The host refused a legal move this seat made')).length).toBe(2);
    expect(early(t)).toBe(0);
  });

  deal('a legal move the table never answered, and replaced with its own when the clock ran out, fails', () => {
    const t = table('RF2');
    const orig = t.h.handle.bind(t.host);
    let dropped = 0;
    let mine: Action | null = null;
    t.h.handle = (from, msg) => {
      const m = msg as { t?: string; action?: Action };
      if (from === 'p0' && m.t === 'action' && m.action?.type === 'discard' && dropped < 1) {
        dropped++;
        mine = m.action;
        return;
      }
      orig(from, msg);
    };
    const origApply = t.h.apply.bind(t.host);
    t.h.apply = (seat, action, source) => {
      // The table's own choice differs from the player's.
      if (seat === 0 && source === 'timeout' && mine && action.type === 'discard') {
        const other = legalActions(t.host.game!, 0).find((a) => a.type === 'discard' && JSON.stringify(a) !== JSON.stringify(mine) && a.tile !== (mine as { tile: number }).tile);
        mine = null;
        if (other) return origApply(seat, other, source);
      }
      origApply(seat, action, source);
    };
    play(t, () => {
      const tc = t.host.game!.turnCounter;
      act(t);
      if (t.host.phase === 'playing' && t.host.game!.turnCounter === tc) wait(t, TURN + BANK + 1_000);
      return true;
    });
    need(dropped === 1);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures.some((f) => f.startsWith('The table ignored a move this seat sent in good time'))).toBe(true);
  });

  deal('honest: a move that reaches the table just after the clock ran out is refused there, and nothing is flagged', () => {
    const t = table('RF3');
    let raced = false;
    play(t, (n) => {
      if (n !== 2) return false;
      // The player moves two seconds before time is up, and the network takes five to carry it.
      wait(t, TURN + BANK - 2_000);
      t.net.stall = true;
      act(t);
      wait(t, 5_000);
      t.net.stall = false;
      t.net.flush();
      raced = true;
      return true;
    });
    need(raced);
    expect([t.c.state.auditStatus, t.c.state.auditFailures]).toEqual(['ok', []]);
  });

  deal('honest: a move that arrives after the clock ran out is played on the seat’s next turn if still legal, and is not flagged', () => {
    const t = table('RF5');
    let late: Action | null = null;
    let playedLate = false;
    play(t, (n) => {
      const s = t.c.localState()!;
      if (n !== 2 || s.phase !== 'discard') return false;
      // The player picks a tile the table's own choice will leave in the hand, two seconds before time is up.
      const tables = chooseAction(t.host.game!, 0, { seed: 'timeout:0', skill: 'club' });
      const mine = legalActions(s, 0).find((a) => a.type === 'discard' && (tables?.type !== 'discard' || a.tile !== tables.tile));
      if (!mine) return false;
      wait(t, TURN + BANK - 2_000);
      t.net.stall = true;
      t.c.act(mine);
      late = mine;
      // The network holds the move until the seat is to discard again.
      let guard = 0;
      wait(t, 3_000);
      while (t.host.phase === 'playing' && !(t.host.game!.phase === 'discard' && t.host.game!.turn === 0) && guard++ < 400) {
        if (myTurn(t)) {
          // A claim in between is answered at once (on another link the stalled move would not block it).
          t.net.stall = false;
          break;
        }
        wait(t, 500);
      }
      const before = t.host.game?.turnCounter;
      const stalled = t.net.stall;
      t.net.stall = false;
      t.net.flush();
      playedLate = stalled && t.host.phase === 'playing' && t.host.game!.turnCounter > (before ?? 0);
      return true;
    });
    need(late !== null && playedLate);
    const mineInLog = t.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player' && JSON.stringify(e.action) === JSON.stringify(late));
    expect(mineInLog.length).toBeGreaterThan(0);
    expect([t.c.state.auditStatus, t.c.state.auditFailures]).toEqual(['ok', []]);
  });

  deal('honest: a tile not in hand, then a legal move on the same turn, and a double tap, are not held against the host', () => {
    const t = table('RF4');
    let done = 0;
    play(t, (n) => {
      const s = t.c.localState()!;
      if (s.phase !== 'discard' || done >= 2) return false;
      if (n % 2 === 0) {
        // Both moves leave before the refusal of the first comes back.
        t.net.hold = true;
        const notMine = [...Array(144).keys()].find((x) => !s.players[0].hand.includes(x))!;
        t.c.act({ type: 'discard', tile: notMine });
        act(t);
        t.net.hold = false;
        t.net.flush();
      } else {
        const a = chooseAction(s, 0, { seed: 'p' })!;
        t.c.act(a);
        t.c.act(a);
      }
      done++;
      return true;
    });
    need(done === 2);
    expect([t.c.state.auditStatus, t.c.state.auditFailures]).toEqual(['ok', []]);
  });
});

/**
 * A seat whose link drops is not a bot. It keeps its turn clock and time bank exactly like a
 * connected seat (it is held); only when that clock runs out does the table move for it, and from
 * then on at bot pace until its player returns (it is away). A player who left on purpose is
 * played at once.
 */
describe('a seat whose link drops keeps its clock', () => {
  interface SeatInternals {
    seats: Array<{ connected: boolean; away?: boolean; left?: boolean }>;
    clocks: Map<number, unknown>;
  }
  const seatsOf = (host: TableHost) => host as unknown as SeatInternals;
  let links = 0;

  /** A table whose bot moves wait in `timers` until the test runs them, so "at once" and "at bot pace" can be told apart. */
  function paced(code: string, humans = 1) {
    const clock = { now: 1_000_000 };
    const hub = new LoopbackHub();
    const timers: Array<() => void> = [];
    const opts = { now: () => clock.now, botDelayMs: 600, schedule: (fn: () => void) => void timers.push(fn) };
    const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, matchId: `m-${code}`, ...opts });
    const clients = Array.from({ length: humans }, (_, i) => new TableClient(transportLink(hub.create(`p${i}`), 'host'), `P${i}`, undefined, {}, { now: () => clock.now }));
    for (const c of clients) c.join();
    host.start();
    const applied: Array<{ action: Action; source: string; offered: Action[]; claim: boolean; asABot: Action | null }> = [];
    const spy = (on: TableHost) => {
      const h = internals(on);
      const orig = h.apply.bind(on);
      h.apply = (seat, action, source) => {
        if (seat === 0) applied.push({ action, source, offered: legalActions(on.game!, 0), claim: on.game!.phase === 'claim', asABot: chooseAction(on.game!, 0, { seed: `${on.matchId}:bot0`, skill: 'club' }) });
        orig(seat, action, source);
      };
    };
    spy(host);
    /** Run the table's next pending bot move; false when none is pending. */
    const step = () => {
      const f = timers.shift();
      if (f) f();
      return !!f;
    };
    const owes = (on: TableHost, seat: number) => on.phase === 'playing' && legalActions(on.game!, seat).length > 0;
    /** The humans play their own moves and the bots theirs until seat 0 is to discard for the `turns`-th time. */
    const toTurn = (turns: number) => {
      let seen = 0;
      for (let guard = 0; guard < 4000 && host.phase === 'playing'; guard++) {
        const mover = clients.find((c, i) => owes(host, i) && c.localState() && legalActions(c.localState()!, i).length > 0);
        if (mover === clients[0] && host.game!.phase === 'discard' && ++seen === turns) return true;
        if (mover) mover.act(chooseAction(mover.localState()!, clients.indexOf(mover), { seed: 'p' })!);
        else if (!step()) break;
      }
      return false;
    };
    /** Let the table's clock run in half-second ticks, as the server does. */
    const run = (on: TableHost, ms: number) => {
      for (let left = ms; left > 0; left -= 500) {
        clock.now += Math.min(500, left);
        on.tick();
      }
    };
    const drop = (i: number) => (clients[i] as unknown as { link: Link }).link.close();
    const rejoin = (i: number, on: LoopbackHub = hub) => {
      clients[i].rebind(transportLink(on.create(`p${i}r${links++}`), 'host'));
      clients[i].join();
    };
    return { clock, hub, host, clients, timers, applied, step, toTurn, run, drop, rejoin, owes, opts, spy };
  }

  it.each([1_000, 10_000])('dropped for %i ms on its own turn, the seat still has the move when it returns, and the hand verifies', (ms) =>
    scenario(() => {
      const t = table(`HD${ms}`);
      let turn = -1;
      play(t, (n) => {
        if (turn >= 0 || n < 2 || t.host.game!.phase !== 'discard') return false;
        turn = t.host.game!.turnCounter;
        t.net.link.close();
        wait(t, ms);
        // Nobody moved for the seat: the turn is where it was and still the seat's own.
        expect(t.host.game!.turnCounter).toBe(turn);
        expect(legalActions(t.host.game!, 0).length).toBeGreaterThan(0);
        t.c.rebind(transportLink(t.hub.create(`p0r${links++}`), 'host'));
        t.c.join();
        expect(myTurn(t)).toBe(true);
        expect(t.c.state.deadline).not.toBeNull();
        act(t);
        expect(t.host.game!.actionLog.find((e) => e.n === turn)).toMatchObject({ seat: 0, source: 'player' });
        return true;
      });
      need(turn >= 0);
      expect([t.c.state.auditStatus, t.c.state.auditFailures, t.c.state.auditCaveats]).toEqual(['ok', [], []]);
    }));

  deal('a seat that stays away is timed out once, then played at bot pace until its player returns', () => {
    const t = paced('AW1');
    need(t.toTurn(2));
    const turn = t.host.game!.turnCounter;
    t.drop(0);
    // Held: no move is waiting to be played for the seat, and its clock runs.
    expect(t.timers.length).toBe(0);
    expect(seatsOf(t.host).clocks.has(0)).toBe(true);
    t.run(t.host, TURN + BANK - 2_000);
    expect(t.host.game!.turnCounter).toBe(turn);
    expect(seatsOf(t.host).seats[0].away).toBeUndefined();
    t.run(t.host, 3_000);
    const table0 = () => t.applied.filter((a) => a.source !== 'player');
    expect(table0().map((a) => a.source)).toEqual(['timeout']);
    expect(seatsOf(t.host).seats[0].away).toBe(true);
    // Away: the table plays the seat's later moves with the bots', no clock in between.
    let guard = 0;
    while (t.host.phase === 'playing' && table0().length < 3 && guard++ < 400) need(t.step());
    need(t.host.phase === 'playing' && table0().length === 3);
    expect(table0().map((a) => a.source)).toEqual(['timeout', 'bot', 'bot']);
    expect(seatsOf(t.host).clocks.has(0)).toBe(false);
    // Back: the mark is cleared and the seat's next move waits for its player again.
    t.rejoin(0);
    expect(seatsOf(t.host).seats[0].away).toBeUndefined();
    guard = 0;
    while (t.host.phase === 'playing' && !t.owes(t.host, 0) && guard++ < 400) need(t.step());
    need(t.host.phase === 'playing');
    while (t.step());
    expect(t.owes(t.host, 0)).toBe(true);
    expect(seatsOf(t.host).clocks.has(0)).toBe(true);
    expect(table0().length).toBe(3);
  });

  /** Seat 0 drops on its first turn and never returns: everything the table then played for it. */
  function awayHand(code: string) {
    const t = paced(code);
    need(t.toTurn(1));
    t.drop(0);
    for (let guard = 0; guard < 4000 && t.host.phase === 'playing'; guard++) if (!t.step()) t.run(t.host, 60_000);
    expect(t.host.phase).toBe('hand_over');
    return t.applied.filter((a) => a.source !== 'player');
  }
  const takes = (a: Action | null) => a?.type === 'chi' || a?.type === 'pong' || a?.type === 'kong';

  deal('while a seat is away the table passes every Chow, Pong or Kong offered on a discard', () => {
    const played = awayHand('AW2');
    expect(played.filter((a) => a.source === 'timeout').length).toBe(1);
    const offers = played.filter((a) => a.claim && !a.offered.some((o) => o.type === 'hu'));
    // At least one of them is an offer a bot in the seat would have taken.
    need(offers.some((a) => a.source === 'bot' && takes(a.asABot)));
    expect(offers.map((a) => a.action.type)).toEqual(offers.map(() => 'pass'));
  });

  it('while a seat is away the table takes a win offered on a discard', () =>
    scenario(() => {
      const played = awayHand('AW3');
      const wins = played.filter((a) => a.claim && a.source === 'bot' && a.offered.some((o) => o.type === 'hu'));
      need(wins.length > 0);
      expect(wins.map((a) => a.action.type)).toEqual(wins.map(() => 'hu'));
    }, 400));

  deal('a seat that left on purpose is played at once', () => {
    const t = paced('AW4');
    need(t.toTurn(2));
    t.clients[0].leave();
    expect(seatsOf(t.host).seats[0].left).toBe(true);
    expect(seatsOf(t.host).clocks.has(0)).toBe(false);
    // Its move is already waiting at bot pace, with no time run off any clock.
    expect(t.timers.length).toBe(1);
    t.step();
    expect(t.applied[t.applied.length - 1].source).toBe('bot');
  });

  deal('the away mark survives a server restart, and a seat that had only dropped is held after it, not played', () => {
    for (const away of [true, false]) {
      const t = paced(`AW5${away}`, 2);
      need(t.toTurn(2));
      t.drop(0);
      if (away) t.run(t.host, TURN + BANK + 1_000);
      need(t.host.phase === 'playing');
      const saved = JSON.parse(JSON.stringify(t.host.serialize())) as ReturnType<TableHost['serialize']>;
      expect((saved.seats[0] as { away?: boolean }).away).toBe(away ? true : undefined);
      expect((saved.seats[1] as { away?: boolean }).away).toBeUndefined();
      // The server restarts: every link is gone, and seat 1's player is the first one back.
      t.timers.length = 0;
      const hub2 = new LoopbackHub();
      const host2 = new TableHost(hub2.create('host'), { roomCode: saved.roomCode, restore: saved, ...t.opts });
      t.spy(host2);
      expect(seatsOf(host2).seats[0].away).toBe(away ? true : undefined);
      const before = t.applied.length;
      t.rejoin(1, hub2);
      for (let guard = 0; guard < 400 && host2.phase === 'playing' && !t.owes(host2, 0); guard++) {
        const c = t.clients[1];
        if (t.owes(host2, 1)) c.act(chooseAction(c.localState()!, 1, { seed: 'p' })!);
        else need(t.step());
      }
      need(host2.phase === 'playing' && t.owes(host2, 0) && !t.owes(host2, 1));
      if (away) {
        // Still away: the table goes on playing the seat at bot pace.
        expect(seatsOf(host2).clocks.has(0)).toBe(false);
        expect(t.timers.length).toBe(1);
        t.step();
        expect(t.applied.slice(before).map((a) => a.source)).toContain('bot');
      } else {
        // Held: the seat gets a whole clock, and the table moves for it only when that has run out.
        expect(seatsOf(host2).clocks.has(0)).toBe(true);
        expect(t.timers.length).toBe(0);
        expect(t.applied.length).toBe(before);
        t.run(host2, TURN + BANK + 1_000);
        expect(t.applied.slice(before).map((a) => a.source)[0]).toBe('timeout');
        expect(seatsOf(host2).seats[0].away).toBe(true);
      }
    }
  });
});
