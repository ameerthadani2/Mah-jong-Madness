/**
 * A host that holds back the frame showing a seat its turn, on a link it keeps open, and then
 * times the seat out has cut the turn short without the link ever dropping. One WebSocket is one
 * ordered stream and an honest host's stamps never go back, so its frames arrive in the order of
 * their stamps; and while a hand is played it sends each seat a stamped `clock` frame with the
 * turn whenever it has sent nothing else for a few seconds. A frame that arrives after one stamped
 * later, or a `clock` frame for a turn whose state never came, shows a frame was held, and a move
 * the table then makes for the seat fails the hand. Honest links that are slow, uneven or bursty,
 * and a phone that sleeps through a turn, stay green.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type Action, type GameState } from '@mjm/engine';
import { CLOCK_FRAME_MS, LoopbackHub, SILENT_ANSWER_MS, TableClient, TableHost, failureKey, transportLink, type HostMessage, type Link } from '../src/index';
import { Missed, scenario, seededDeals } from './support';

seededDeals();

const deal = (name: string, fn: () => void) => it(name, () => scenario(fn));
const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

interface HostInternals {
  game: GameState | null;
  apply: (seat: number, action: Action, source: 'player' | 'bot' | 'timeout') => void;
  timeoutAction: (game: GameState, seat: number) => Action;
}

const TURN = 15_000;
const BANK = 30_000;
const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

/**
 * The link from the host to the seat. Every frame waits `delay(m)` ms of the shared clock and none
 * overtakes another (an ordered stream), unless the server holds it: `hold(m)` true keeps the frame
 * back until `release()`, and the frames behind it pass it (only a server can do that).
 */
function link(hub: LoopbackHub, id: string, clock: { now: number }) {
  const base = transportLink(hub.create(id), 'host');
  let cb: ((m: HostMessage) => void) | null = null;
  const queue: Array<{ at: number; m: HostMessage }> = [];
  const held: HostMessage[] = [];
  const ctl = {
    delay: (_m: HostMessage) => 0,
    hold: (_m: HostMessage) => false,
    /** What the server sends in place of the frame the host made (null: nothing). */
    rewrite: (m: HostMessage): HostMessage | null => m,
    link: {
      ...base,
      onMessage: (f) => {
        cb = f;
        return base.onMessage((m0) => {
          const m = ctl.rewrite(m0);
          if (m === null) return;
          if (ctl.hold(m)) return void held.push(m);
          const at = Math.max(clock.now + ctl.delay(m), queue.length ? queue[queue.length - 1].at : Number.NEGATIVE_INFINITY);
          queue.push({ at, m });
          ctl.pump();
        });
      },
    } as Link,
    pump() {
      while (queue.length && queue[0].at <= clock.now) cb?.(queue.shift()!.m);
    },
    /** The server sends a frame of its own making, past what it holds. */
    inject(m: HostMessage) {
      cb?.(m);
    },
    /** The server lets the frames it held go, now. */
    release() {
      for (const m of held.splice(0)) cb?.(m);
    },
  };
  return ctl;
}

function table(code: string, skew = 0, rewrite?: (m: HostMessage) => HostMessage | null) {
  const clock = { now: 2_000_000 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, now: () => clock.now, matchId: `m-${code}` });
  const net = link(hub, 'p0', clock);
  if (rewrite) net.rewrite = rewrite;
  const c = new TableClient(net.link, 'Victim', undefined, {}, { now: () => clock.now + skew });
  c.join();
  host.start();
  let links = 0;
  const t = {
    clock,
    hub,
    host,
    h: host as unknown as HostInternals,
    c,
    net,
    /** The online session's watch: when it is on, `checkLink` runs every second and a silent link is dropped and joined again. */
    watching: false,
    /** When the watch last dropped a silent link (the shared clock). */
    droppedAt: null as number | null,
    /** Whether the phone joins again at once after the watch dropped a link (else `reconnect()` does it). */
    rejoin: true,
    /** The phone gets a new link to the table and joins on it. */
    reconnect() {
      c.rebind(transportLink(hub.create(`p0r${links++}`), 'host'));
      c.join();
    },
    /** Let the clock run in half-second ticks, as the server does; the phone pings every `pingMs` (0: never). */
    wait(ms: number, pingMs = 0) {
      for (let left = ms; left > 0; left -= 500) {
        clock.now += Math.min(500, left);
        if (pingMs > 0 && clock.now % pingMs === 0) c.ping();
        host.tick();
        net.pump();
        if (t.watching && clock.now % 1_000 === 0 && c.checkLink() === 'silent') {
          t.droppedAt = clock.now;
          t.net.link.close();
          if (t.rejoin) t.reconnect();
          else t.watching = false;
        }
      }
    },
  };
  return t;
}
type T = ReturnType<typeof table>;

/** This seat has a discard to make in the state its phone holds. */
const myDiscard = (t: T) => {
  const s = t.c.localState();
  return !!s && t.host.phase === 'playing' && legalActions(s, 0).length > 0 && legalActions(s, 0).every((a) => a.type === 'discard');
};
/** It is this seat's discard at the table, whatever the phone was shown. */
const hostDiscard = (t: T) => t.host.phase === 'playing' && legalActions(t.host.game!, 0).length > 0 && legalActions(t.host.game!, 0).every((a) => a.type === 'discard');

/** The seat makes the move its phone shows, if the phone is up to date with the table. */
function moveIfShown(t: T): boolean {
  const s = t.c.localState();
  if (!s || legalActions(s, 0).length === 0 || t.c.state.view?.turnCounter !== t.host.game!.turnCounter) return false;
  t.c.act(chooseAction(s, 0, { seed: 'p' })!);
  return true;
}

/** Play on until `stop()` (true) or the hand ends (false): the seat moves on what its phone shows, else the clock runs. */
function advance(t: T, stop: () => boolean): boolean {
  for (let g = 0; g < 4000 && t.host.phase === 'playing'; g++) {
    if (stop()) return true;
    if (!moveIfShown(t)) t.wait(500);
  }
  return false;
}

/** Play on (the seat moves at once when its phone shows a move) until the table owes this seat its `n`-th discard. */
function toDiscard(t: T, n: number): boolean {
  let seen = 0;
  for (let g = 0; g < 4000 && t.host.phase === 'playing'; g++) {
    if (hostDiscard(t) && myDiscard(t) && ++seen === n) return true;
    if (!moveIfShown(t)) t.wait(500);
  }
  return false;
}

/** Play the hand out, the seat moving at once. */
function finish(t: T) {
  for (let g = 0; g < 8000 && t.host.phase === 'playing'; g++) if (!moveIfShown(t)) t.wait(500);
  // What is still in the network arrives.
  t.clock.now += 10_000;
  t.net.pump();
  expect(t.host.phase).toBe('hand_over');
}

/** Wait, the seat away from its phone, until the table has timed it out of the turn it is on. */
function timedOut(t: T, pingMs = 0) {
  const tc = t.host.game!.turnCounter;
  for (let g = 0; g < 400 && t.host.phase === 'playing' && t.host.game!.turnCounter === tc; g++) t.wait(500, pingMs);
  t.net.release();
}

const keys = (t: T) => t.c.state.auditFailures.map(failureKey);
const green = (t: T) => expect([t.c.state.auditStatus, t.c.state.auditFailures, t.c.state.auditCaveats]).toEqual(['ok', [], []]);

describe('a frame held back on a link that stays open', () => {
  deal('the state showing the turn is held while the clock frames go on: the timeout fails the hand', () => {
    const t = table('HF1');
    need(toDiscard(t, 2));
    t.c.act(chooseAction(t.c.localState()!, 0, { seed: 'p' })!);
    // The server keeps back the frame that shows the seat its next discard; the clock frames go on.
    t.net.hold = (m) => m.t === 'state' && hostDiscard(t);
    need(advance(t, () => hostDiscard(t)));
    const turn = t.host.game!.turnCounter;
    t.wait(TURN + BANK - 5_000);
    // It lets the frame go 5 s before the turn runs out, and then times the seat out.
    t.net.hold = () => false;
    t.net.release();
    timedOut(t);
    finish(t);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(keys(t)).toContain('heldFrame');
    expect(t.c.state.auditFailures).toContain(`The host held back its frames on a link that stayed open, then played for this seat (turn ${turn})`);
  });

  deal('clockcut: every table frame is held but the answers to the phone’s pings: the timeout fails the hand', () => {
    const t = table('HF2', -3 * 3_600_000);
    need(toDiscard(t, 1));
    t.c.act(chooseAction(t.c.localState()!, 0, { seed: 'p' })!);
    need(advance(t, () => hostDiscard(t)));
    const turn = t.host.game!.turnCounter;
    // From here the server holds every frame but the pongs, keeping the link alive; 40 of the 45 s pass.
    t.net.hold = (m) => m.t !== 'pong';
    t.wait(TURN + BANK - 5_000, 5_000);
    t.net.hold = () => false;
    t.net.release();
    timedOut(t);
    finish(t);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(keys(t)).toContain('heldFrame');
    expect(t.c.state.auditFailures.some((f) => f.endsWith(`(turn ${turn})`))).toBe(true);
  });

  deal('a clock frame that is held while later frames pass is proof as well', () => {
    const t = table('HF3');
    need(toDiscard(t, 1));
    // On the seat's turn the server keeps back one clock frame and lets the next one through before it.
    let once = false;
    t.net.hold = (m) => !once && m.t === 'clock' && (once = true);
    t.wait(CLOCK_FRAME_MS * 2 + 500);
    need(once);
    t.net.hold = () => false;
    t.net.release();
    timedOut(t);
    finish(t);
    expect(keys(t)).toContain('heldFrame');
  });
});

describe('a link that brings nothing is dropped', () => {
  deal('a server that holds every frame, the pongs too, loses the link within 13 s and the seat gets its turn back', () => {
    const t = table('HS1', 2 * 3_600_000);
    t.watching = true;
    need(toDiscard(t, 1));
    t.c.act(chooseAction(t.c.localState()!, 0, { seed: 'p' })!);
    t.net.hold = (m) => m.t === 'state' && hostDiscard(t);
    need(advance(t, () => hostDiscard(t)));
    // From the moment the seat owes its discard, nothing reaches it, the answers to its pings included.
    const turn = t.host.game!.turnCounter;
    const from = t.clock.now;
    t.net.hold = () => true;
    t.wait(TURN + BANK - 5_000);
    expect(t.droppedAt).not.toBeNull();
    expect(t.droppedAt! - from).toBeLessThanOrEqual(2 * CLOCK_FRAME_MS + 2_000 + SILENT_ANSWER_MS + 1_000);
    // The new link shows the turn, and the seat's own move is taken.
    expect(t.host.game!.turnCounter).toBe(turn);
    expect(myDiscard(t)).toBe(true);
    t.c.act(chooseAction(t.c.localState()!, 0, { seed: 'p' })!);
    expect(t.host.game!.actionLog.find((e) => e.n === turn)).toMatchObject({ seat: 0, source: 'player' });
    finish(t);
    expect(t.c.state.auditStatus).not.toBe('failed');
  });

  deal('honest: every frame 6 s late, the seat timed out: the link is never dropped and the hand is green', () => {
    const t = table('HS2');
    t.watching = true;
    t.net.delay = () => 6_000;
    need(toDiscard(t, 2));
    timedOut(t);
    finish(t);
    expect(t.droppedAt).toBeNull();
    green(t);
  });

  deal('honest: the phone sleeps through a whole turn (no app code runs) and wakes to the frames: no drop, green', () => {
    const t = table('HS3');
    t.watching = true;
    need(toDiscard(t, 2));
    t.wait(2_000);
    // Asleep: nothing arrives and the watch does not run, while the table times the seat out.
    t.watching = false;
    t.net.hold = () => true;
    t.wait(TURN + BANK + 5_000);
    // It wakes; the network takes 6 s to bring what was waiting.
    t.watching = true;
    t.wait(6_000);
    t.net.hold = () => false;
    t.net.release();
    finish(t);
    expect(t.droppedAt).toBeNull();
    green(t);
  });
});

/** The longest a link that brings nothing stays up while the watch runs once a second: the client's bound, whatever the table announces. */
const SILENT_BOUND = 2 * CLOCK_FRAME_MS + 2_000 + SILENT_ANSWER_MS + 1_000;
/** A table that announces no clock-frame period and sends no clock frames. */
const noClock = (m: HostMessage): HostMessage | null => {
  if (m.t === 'clock') return null;
  if (m.t !== 'welcome') return m;
  const { clockMs: _clockMs, ...rest } = m;
  return rest;
};
/** A table that announces a clock-frame period of 10 s. */
const slowClock = (m: HostMessage): HostMessage | null => (m.t === 'welcome' ? { ...m, clockMs: 10_000 } : m);

/** Play to the seat's second discard and hold everything from the moment it owes it; returns the turn and when the hold began. */
function holdTheTurn(t: T): { turn: number; from: number } {
  t.watching = true;
  need(toDiscard(t, 2));
  t.c.act(chooseAction(t.c.localState()!, 0, { seed: 'p' })!);
  t.net.hold = (m) => m.t === 'state' && hostDiscard(t);
  need(advance(t, () => hostDiscard(t)));
  t.net.hold = () => true;
  return { turn: t.host.game!.turnCounter, from: t.clock.now };
}

describe('the bound on a silent link is the client’s, not the server’s', () => {
  deal('a table that announces no clock frames and holds every frame loses the link within 13 s, and the seat gets its turn back', () => {
    const t = table('HC1', 0, noClock);
    const { turn, from } = holdTheTurn(t);
    t.wait(TURN + BANK - 5_000, 5_000);
    expect(t.droppedAt).not.toBeNull();
    expect(t.droppedAt! - from).toBeLessThanOrEqual(SILENT_BOUND);
    expect(t.host.game!.turnCounter).toBe(turn);
    expect(myDiscard(t)).toBe(true);
    t.c.act(chooseAction(t.c.localState()!, 0, { seed: 'p' })!);
    expect(t.host.game!.actionLog.find((e) => e.n === turn)).toMatchObject({ seat: 0, source: 'player' });
    finish(t);
    expect(t.c.state.auditStatus).not.toBe('failed');
  });

  deal('a table that announces no clock frames, holds every frame and times the seat out while the link it forced down is down: red', () => {
    const t = table('HC2', 0, noClock);
    t.rejoin = false;
    const { turn, from } = holdTheTurn(t);
    for (let g = 0; g < 2 * (TURN + BANK) / 1_000 && t.droppedAt === null; g++) t.wait(500, 5_000);
    expect(t.droppedAt).not.toBeNull();
    expect(t.droppedAt! - from).toBeLessThanOrEqual(SILENT_BOUND);
    // The seat's clock has 30 s or more left; the table times it out anyway, and then the phone is back.
    expect(t.host.game!.turnCounter).toBe(turn);
    expect(TURN + BANK - (t.clock.now - from)).toBeGreaterThanOrEqual(30_000);
    t.h.apply(0, t.h.timeoutAction(t.host.game!, 0), 'timeout');
    t.reconnect();
    finish(t);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(keys(t)).toEqual(['playedWhileDown']);
    expect(t.c.state.auditFailures).toEqual([`The table played for this seat while its connection was down, before its clock could have run out (turn ${turn})`]);
  });

  deal('a table that announces a 10 s clock-frame period is held to 3 s: the same bound', () => {
    const t = table('HC3', 0, slowClock);
    const { turn, from } = holdTheTurn(t);
    t.wait(TURN + BANK - 5_000, 5_000);
    expect(t.droppedAt).not.toBeNull();
    expect(t.droppedAt! - from).toBeLessThanOrEqual(SILENT_BOUND);
    expect(t.host.game!.turnCounter).toBe(turn);
    expect(myDiscard(t)).toBe(true);
  });

  deal('a table that holds every stamped frame but keeps the link busy with chat loses it within 13 s all the same', () => {
    const t = table('HC5', 0, noClock);
    const { turn, from } = holdTheTurn(t);
    for (let g = 0; g < 2 * (TURN + BANK) / 1_000 && t.droppedAt === null; g++) {
      if (g % 4 === 0) t.net.inject({ t: 'chat', seat: 1, name: 'Bot', text: 'gg' });
      t.wait(500, 5_000);
    }
    expect(t.droppedAt).not.toBeNull();
    expect(t.droppedAt! - from).toBeLessThanOrEqual(SILENT_BOUND);
    expect(t.host.game!.turnCounter).toBe(turn);
  });

  deal('honest but for the welcome (no clock-frame period announced): every frame 6 s late and the seat timed out, never dropped, green', () => {
    const t = table('HC4', 0, (m) => (m.t === 'welcome' ? noClock(m) : m));
    t.watching = true;
    t.net.delay = () => 6_000;
    need(toDiscard(t, 2));
    timedOut(t);
    finish(t);
    expect(t.droppedAt).toBeNull();
    green(t);
  });
});

describe('honest links are not flagged', () => {
  for (const [name, delay] of [
    ['every frame 6 s late', () => 6_000],
    ['frames 0 to 9 s late at random, never overtaking', (() => {
      let x = 7;
      return () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return (x % 19) * 500;
      };
    })()],
  ] as const) {
    deal(`${name}, the seat timed out twice and moving itself otherwise`, () => {
      const t = table(`HL${name.length}`, 4 * 3_600_000);
      t.net.delay = delay;
      need(toDiscard(t, 2));
      timedOut(t, 5_000);
      need(toDiscard(t, 2));
      timedOut(t, 5_000);
      finish(t);
      green(t);
    });
  }

  deal('the network stalls for 20 s mid-turn and then delivers everything at once: not proof of a held frame', () => {
    const t = table('HL3');
    need(toDiscard(t, 2));
    // Every frame, pongs included, waits in the network (an ordered stream stalls as a whole).
    t.net.hold = () => true;
    t.wait(20_000, 5_000);
    t.net.hold = () => false;
    t.net.release();
    timedOut(t);
    finish(t);
    green(t);
  });

  it('the host sends a clock frame only after a quiet spell, with the turn the seat was shown', () =>
    scenario(() => {
      const t = table('HL4');
      const got: HostMessage[] = [];
      const orig = t.net.delay;
      t.net.delay = (m) => (got.push(m), orig(m));
      need(toDiscard(t, 1));
      got.length = 0;
      t.wait(CLOCK_FRAME_MS * 3);
      const clocks = got.filter((m): m is Extract<HostMessage, { t: 'clock' }> => m.t === 'clock');
      expect(clocks.length).toBeGreaterThanOrEqual(2);
      expect(clocks.length).toBeLessThanOrEqual(3);
      for (const m of clocks) expect(m).toMatchObject({ hand: t.host.game!.handNumber, tc: t.c.state.view!.turnCounter });
      expect(clocks.every((m, i) => i === 0 || m.now - clocks[i - 1].now >= CLOCK_FRAME_MS)).toBe(true);
    }));

  // The app pings once a second. If each answer put the clock frame off, a seat would get none while it pings, and a
  // link whose delay rose 8 s each way in one step would bring nothing for 11 s: the signalling heartbeat, which waits
  // 10 s, dropped such links and the table was lost (unit 20's honest check, lat8-both-step).
  it('pongs do not put off the clock frame: a phone that pings every second still gets one after each quiet spell', () =>
    scenario(() => {
      const t = table('HL4P');
      const got: HostMessage[] = [];
      const orig = t.net.delay;
      t.net.delay = (m) => (got.push(m), orig(m));
      need(toDiscard(t, 1));
      got.length = 0;
      t.wait(CLOCK_FRAME_MS * 3, 1_000);
      expect(got.filter((m) => m.t === 'pong').length).toBeGreaterThanOrEqual(8);
      const clocks = got.filter((m): m is Extract<HostMessage, { t: 'clock' }> => m.t === 'clock');
      expect(clocks.length).toBeGreaterThanOrEqual(2);
      expect(clocks.length).toBeLessThanOrEqual(3);
      // Never more than a period and the host's half-second tick without a frame that is not a pong.
      const quiet = got.filter((m) => m.t !== 'pong').map((m) => (m as { now?: number }).now ?? Number.NaN);
      expect(quiet.every((n, i) => i === 0 || n - quiet[i - 1] <= CLOCK_FRAME_MS + 500)).toBe(true);
    }));
});
