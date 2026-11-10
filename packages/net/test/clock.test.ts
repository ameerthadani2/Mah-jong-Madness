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
