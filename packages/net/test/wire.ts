/**
 * A table on one fake clock, for the tests of the link watch and of turns shown late: a TableHost,
 * a TableClient at seat 0 or at `seat` (the other seats are bots) and a network between them that a
 * test makes slow, uneven or hostile.
 *
 * Each frame from the host waits `delay(m)` ms and none overtakes another (one ordered stream),
 * unless the server rewrites it (`map`; null drops it) or holds it (`hold`) until it lets it go;
 * each message from the phone waits `up()` ms, in order. The phone runs the online session's watch:
 * while the app runs, `checkLink` once a second, and a link it calls silent is closed and a new one
 * joined `reconnectMs` later. The app can be asleep (nothing of it runs and frames wait in the
 * device; its monotonic clock stands still while its wall clock runs) or in the background (the
 * same, with the monotonic clock running). The seat makes the move its phone shows `think(k)` ms
 * after it was shown its k-th move (Infinity: never, and the table times it out). The host keeps
 * time by its default rule (`clientClock`) over the server's wall clock, which `hostSkew` can step;
 * with `hostClock: 'real'` it is built without a clock and keeps its own default over the faked
 * `Date` and `performance` (the test turns fake timers on first).
 */
import { vi } from 'vitest';
import { chooseAction, legalActions, withRules, type Action, type RuleSet } from '@mjm/engine';
import { caveatKey, clientClock, failureKey, LoopbackHub, TableClient, TableHost, transportLink, type HostMessage, type Link, type SerializedClient, type SerializedHost } from '../src/index';

export const TURN = 15_000;
export const BANK = 30_000;
export const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
/** The real time every wire starts at. */
export const T0 = 2_000_000;

/** A frame's stamp, if it carries one. */
export const stampOf = (m: HostMessage): number | undefined => {
  const n = (m as { now?: unknown }).now;
  return typeof n === 'number' ? n : undefined;
};

export interface Plan {
  code: string;
  rules?: RuleSet;
  /** The seat the phone sits at (default 0, the first hand's dealer). */
  seat?: number;
  /** Downlink delay (ms) of a frame the host sends at real time `now`. */
  delay?: (m: HostMessage, now: number) => number;
  /** Uplink delay (ms) of a message the phone sends at real time `now`. */
  up?: (now: number) => number;
  /** The server's wall clock is `now + hostSkew(now)`. */
  hostSkew?: (now: number) => number;
  /**
   * `default`: the host is given its default rule (`clientClock`) over the server's wall and monotonic
   * clocks. `wall`: it reads the server's wall clock as it is (as hosts did before). `real`: it is
   * given no clock, and keeps its own default over `Date` and `performance`, which the test fakes
   * (`vi.useFakeTimers()` before the wire is made); `Date` is the server's wall clock.
   */
  hostClock?: 'default' | 'wall' | 'real';
  /** The phone's wall clock is `now + devSkew(now)`. */
  devSkew?: (now: number) => number;
  asleep?: (now: number) => boolean;
  background?: (now: number) => boolean;
  /** On waking, `checkLink` runs before the frames that waited in the device are handled (an order a resumed app may run them in). */
  checkFirst?: boolean;
  /** How long the seat takes over the k-th move it is shown (turn `tc`); default 600 ms. */
  think?: (k: number, tc: number) => number;
  /** The online session's watch (default on). */
  watch?: boolean;
  reconnectMs?: number;
  /** The server rewrites a frame as it sends it (null: it sends nothing). */
  map?: (m: HostMessage, w: Wire) => HostMessage | null;
  /** The server holds a frame back (on the link it was sent on) until the test lets it go. */
  hold?: (m: HostMessage, w: Wire) => boolean;
  /** Frames of the server's own making that it sends right behind a frame it sends (on the same link, in order). */
  after?: (m: HostMessage, w: Wire) => HostMessage[];
  onTick?: (w: Wire) => void;
  /** Right after the phone joined on a new link. */
  onReconnect?: (w: Wire) => void;
  /** Between hands (default 30 s, longer than any delay the tests put on a result). */
  intermissionSeconds?: number;
  /** A link the phone drops (`dropNow`) also tells its client it was lost, as a real socket's close does (default: it does not). */
  fireClose?: boolean;
  /** How long the host's bots take over each move, on the wire's clock (default 0: at once). */
  botDelayMs?: number;
}

/** One link from the phone to the table. */
export interface Line {
  id: string;
  link: Link;
  /** Frames the server holds back on this link. */
  held: HostMessage[];
  /** The server lets the frames it holds on this link go, now (`edit` may change each first). */
  release(edit?: (m: HostMessage) => HostMessage): void;
  /** The server sends a frame of its own making, at once, past what it holds and what is in the network. */
  inject(m: HostMessage): void;
  pump(): void;
  uppump(): void;
  close(): void;
  /** The phone's side learns the link was lost (its client's close handler runs). */
  lost(): void;
}

export type Wire = ReturnType<typeof wire>;

export function wire(plan: Plan) {
  const rules = plan.rules ?? RULES;
  const vs = plan.seat ?? 0;
  const clock = { now: T0 };
  let mono = 500_000;
  let hub = new LoopbackHub();
  const serverWall = () => clock.now + (plan.hostSkew?.(clock.now) ?? 0);
  const real = plan.hostClock === 'real';
  if (real) vi.setSystemTime(serverWall());
  /** The host's clock, made afresh for each process the table runs in. */
  const hostNow = () => (plan.hostClock === 'wall' ? serverWall : clientClock({ now: serverWall, monotonic: () => clock.now }));
  /** The host's bots' moves, due on the wire's clock. */
  const timers: Array<{ at: number; fn: () => void }> = [];
  /** The table in a process of the server's (`restore`: a table saved by an earlier one). */
  const makeHost = (restore?: SerializedHost) =>
    new TableHost(hub.create('host'), {
      roomCode: plan.code,
      rules,
      ...(real ? {} : { now: hostNow() }),
      matchId: `m-${plan.code}`,
      intermissionSeconds: plan.intermissionSeconds ?? 30,
      botDelayMs: plan.botDelayMs ?? 0,
      schedule: (fn, ms) => void timers.push({ at: clock.now + ms, fn }),
      ...(restore ? { restore } : {}),
    });
  let host = makeHost();
  let lines = 0;
  let owed = { tc: -1, k: 0, since: 0, think: 0, acted: false };
  /** The uplink delay starts once the seat is taken (its first join goes straight through). */
  let upOn = false;
  /** The app did not run at the last step. */
  let wasOff = false;
  const w = {
    clock,
    host,
    /** The network the host and the phone are on (another device can join it). */
    hub,
    rules,
    c: null as unknown as TableClient,
    line: null as unknown as Line,
    /** When the watch dropped a link (real time), in order. */
    drops: [] as number[],
    pendingReconnectAt: null as number | null,
    /** Turn → when the host first sent a state showing the phone's seat that move, and when the phone first got a state of that turn. */
    created: new Map<number, number>(),
    shown: new Map<number, number>(),
    /** The last state frame the phone got. */
    lastState: null as Extract<HostMessage, { t: 'state' }> | null,
    /** The moves the seat sent: the turn it acted on and when. */
    sent: [] as Array<{ tc: number; at: number }>,
    awake: () => !(plan.asleep?.(clock.now) || plan.background?.(clock.now)),
    owes: () => host.phase === 'playing' && !!host.game && legalActions(host.game, vs).length > 0,
    /** The table owes the phone's seat a discard (its own turn, not a claim). */
    discardTurn: () => w.owes() && legalActions(host.game!, vs).every((a) => a.type === 'discard'),
    /** The phone shows the seat the move the table owes it now. */
    current: () => w.owes() && w.c.state.view?.turnCounter === host.game!.turnCounter,
    reconnect() {
      w.line = line();
      w.c.rebind(w.line.link);
      w.c.join();
      plan.onReconnect?.(w);
    },
    /**
     * The app restarts: the client is saved (`edit` may change the saved record), its link is gone, and
     * a client restored from the record joins on a new link.
     */
    restart(edit?: (saved: SerializedClient) => SerializedClient) {
      let saved = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
      if (edit) saved = edit(saved);
      w.line.close();
      w.line = line();
      w.c = TableClient.restore(saved, w.line.link, 'Victim', undefined, { token: saved.state.token ?? undefined }, clientOpts);
      w.c.join();
    },
    /** The phone drops the link in use and joins again `ms` later. */
    dropNow(ms = plan.reconnectMs ?? 1_000) {
      w.drops.push(clock.now);
      w.line.close();
      if (plan.fireClose) w.line.lost();
      w.pendingReconnectAt = clock.now + ms;
    },
    /**
     * The server restarts: the table is saved, and restored in a new process (on a new network, with a
     * clock of its own over the same wall clock); every link and every bot move it had scheduled is
     * gone, and the phone joins it again `ms` later.
     */
    restartHost(ms = plan.reconnectMs ?? 1_000) {
      const saved = JSON.parse(JSON.stringify(host.serialize())) as SerializedHost;
      host.close();
      timers.length = 0;
      hub = new LoopbackHub();
      host = makeHost(saved);
      w.host = host;
      w.hub = hub;
      w.dropNow(ms);
    },
    step(ms = 500) {
      clock.now += ms;
      if (real) {
        vi.advanceTimersByTime(ms);
        vi.setSystemTime(serverWall());
      }
      if (!plan.asleep?.(clock.now)) mono += ms;
      w.line.uppump();
      for (let i = 0; i < timers.length; ) {
        if (timers[i].at <= clock.now) timers.splice(i, 1)[0].fn();
        else i++;
      }
      host.tick();
      plan.onTick?.(w);
      if (w.pendingReconnectAt !== null && clock.now >= w.pendingReconnectAt && w.awake()) {
        w.pendingReconnectAt = null;
        w.reconnect();
      }
      if (!w.awake()) {
        wasOff = true;
        return;
      }
      const first = plan.checkFirst && wasOff;
      wasOff = false;
      const check = () => {
        if (plan.watch !== false && w.pendingReconnectAt === null && w.c.checkLink() === 'silent') w.dropNow();
      };
      if (first) check();
      w.line.pump();
      if (!first && clock.now % 1_000 === 0) check();
      victim();
    },
    /** Run until `stop()` (true), or until the hand is over (false). */
    until(stop: () => boolean, maxMs = 3_600_000): boolean {
      for (let e = 0; e < maxMs && host.phase === 'playing'; e += 500) {
        if (stop()) return true;
        w.step();
      }
      return stop();
    },
    /** Run until the host is dealing no more (it plays a hand, or has ended one). */
    dealt() {
      for (let e = 0; e < 3_600_000 && host.phase !== 'playing' && host.phase !== 'hand_over' && host.phase !== 'match_over'; e += 500) w.step();
    },
    /** Play on until the phone shows the seat the `n`-th discard the table owes it. */
    toDiscard(n: number): boolean {
      let seen = 0;
      let last = -1;
      w.dealt();
      return w.until(() => {
        if (!w.discardTurn() || !w.current() || host.game!.turnCounter === last) return false;
        last = host.game!.turnCounter;
        return ++seen === n;
      });
    },
    /** Play the hand out, and let what is still in the network arrive (the client then holds its verdict). */
    finish() {
      w.dealt();
      for (let e = 0; e < 3_600_000 && host.phase === 'playing'; e += 500) w.step();
      for (let e = 0; e < 120_000 && w.c.state.lastResult === null; e += 500) w.step();
    },
    /** The turns at which the table has played for the phone's seat in the hand on the table. */
    tableMoves: (): number[] => (host.game?.actionLog ?? []).filter((e) => e.seat === vs && e.source !== 'player').map((e) => e.n),
    /** The same in the hand the client last audited. */
    judged: (): number[] => (w.c.state.lastAudit?.log ?? []).filter((e) => e.seat === vs && e.source !== 'player').map((e) => e.n),
    verdict() {
      const st = w.c.state;
      return { status: st.auditStatus, failures: [...new Set(st.auditFailures.map(failureKey))], caveats: st.auditCaveats.map(caveatKey) };
    },
  };

  function line(): Line {
    const id = lines === 0 ? 'p0' : `p0r${lines}`;
    lines++;
    const base = transportLink(hub.create(id), 'host');
    let cb: ((m: HostMessage) => void) | null = null;
    const down: Array<{ at: number; m: HostMessage }> = [];
    const up: Array<{ at: number; m: unknown }> = [];
    const held: HostMessage[] = [];
    /** Nothing comes over a link once it is closed: what was still in the network is lost with it. */
    let closed = false;
    const closeHandlers = new Set<() => void>();
    const deliver = (m: HostMessage) => {
      if (closed) return;
      if (m.t === 'state') {
        if (!w.shown.has(m.view.turnCounter)) w.shown.set(m.view.turnCounter, clock.now);
        w.lastState = m;
      }
      cb?.(m);
    };
    const l: Line = {
      id,
      held,
      link: {
        ...base,
        onClose: (f) => {
          closeHandlers.add(f);
          return () => closeHandlers.delete(f);
        },
        send: (m) => {
          if (!plan.up || !upOn) return base.send(m);
          up.push({ at: Math.max(clock.now + plan.up(clock.now), up.length ? up[up.length - 1].at : Number.NEGATIVE_INFINITY), m });
          l.uppump();
        },
        onMessage: (f) => {
          cb = f;
          return base.onMessage((m0) => {
            if (m0.t === 'state' && host.game && legalActions(host.game, vs).length > 0 && host.game.turnCounter === m0.view.turnCounter && !w.created.has(m0.view.turnCounter)) w.created.set(m0.view.turnCounter, clock.now);
            const m = plan.map ? plan.map(m0, w) : m0;
            if (m === null) return;
            if (plan.hold?.(m, w)) return void held.push(m);
            const at = Math.max(clock.now + (plan.delay?.(m, clock.now) ?? 0), down.length ? down[down.length - 1].at : Number.NEGATIVE_INFINITY);
            down.push({ at, m });
            for (const x of plan.after?.(m, w) ?? []) down.push({ at, m: x });
          });
        },
      },
      release(edit) {
        for (const m of held.splice(0)) deliver(edit ? edit(m) : m);
      },
      inject: (m) => deliver(m),
      pump() {
        while (down.length && down[0].at <= clock.now) deliver(down.shift()!.m);
      },
      uppump() {
        while (up.length && up[0].at <= clock.now) {
          const m = up.shift()!.m;
          if (!closed) base.send(m as never);
        }
      },
      close: () => {
        closed = true;
        base.close();
      },
      lost: () => {
        for (const f of [...closeHandlers]) f();
      },
    };
    return l;
  }

  /** The seat plays the move its phone shows (whether or not the table has moved on), once, after thinking. */
  function victim() {
    const s = w.c.localState();
    if (!s || host.phase !== 'playing') return;
    let acts: Action[] = [];
    try {
      acts = legalActions(s, vs);
    } catch {
      acts = [];
    }
    if (acts.length === 0) return;
    if (s.turnCounter !== owed.tc) owed = { tc: s.turnCounter, k: owed.k + 1, since: clock.now, think: plan.think?.(owed.k + 1, s.turnCounter) ?? 600, acted: false };
    if (owed.acted || clock.now - owed.since < owed.think) return;
    owed.acted = true;
    w.sent.push({ tc: s.turnCounter, at: clock.now });
    w.c.act(chooseAction(s, vs, { seed: 'p' })!);
  }

  w.line = line();
  const wallOf = () => clock.now + (plan.devSkew?.(clock.now) ?? 0);
  const clientOpts = plan.asleep ? { now: wallOf, monotonic: () => mono } : { now: wallOf };
  w.c = new TableClient(w.line.link, 'Victim', undefined, {}, clientOpts);
  w.c.join(plan.seat);
  host.start();
  upOn = true;
  return w;
}

/**
 * The server's hold of a seat's turn: armed while the seat owes its `n`-th discard and before it
 * makes it, so the state its move leads to (the next one that shows it a move) is the one held,
 * with every state after it. Until the hold ends, the server rewrites the stamps of the clock
 * frames and pongs it sends (`stamp`; by default one millisecond past the last honest stamp each)
 * and gives the clock frames the turn the phone was last shown; `all` holds every other frame too.
 */
export interface HoldSpec {
  stamp?: (base: number, k: number, since: number, now: number) => number;
  all?: boolean;
}

export function holdTurn(plan: Omit<Plan, 'map' | 'hold'>, spec: HoldSpec = {}) {
  const st = { armed: false, holding: false, released: false, base: 0, k: 0, since: 0, shownTc: -1, heldTc: -1 };
  const w = wire({
    ...plan,
    map: (m) => {
      const s = stampOf(m);
      if (s === undefined) return m;
      if (!st.holding) {
        st.base = s;
        return m;
      }
      if (m.t === 'state' || m.t === 'hand_over') return m;
      const now = spec.stamp ? spec.stamp(st.base, ++st.k, st.since, w.clock.now) : st.base + ++st.k;
      return m.t === 'clock' ? { ...m, now, tc: st.shownTc } : ({ ...m, now } as HostMessage);
    },
    hold: (m, w) => {
      if (!st.armed || st.released) return false;
      if (!st.holding && m.t === 'state' && w.owes() && w.host.game!.turnCounter === m.view.turnCounter) {
        st.holding = true;
        st.since = w.clock.now;
        st.shownTc = w.c.state.view?.turnCounter ?? -1;
        st.heldTc = m.view.turnCounter;
      }
      if (!st.holding) return false;
      if (m.t === 'state') return true;
      return !!spec.all && m.t !== 'clock' && m.t !== 'pong';
    },
  });
  return {
    w,
    st,
    /** Play to the seat's `n`-th discard and arm the hold; then run until the state it held. False when the deal never got there. */
    arm(n = 2): boolean {
      if (!w.toDiscard(n)) return false;
      st.armed = true;
      return w.until(() => st.holding, 60_000);
    },
    /** The next stamp of the crawl, as of now. */
    crawl: () => (spec.stamp ? spec.stamp(st.base, ++st.k, st.since, w.clock.now) : st.base + ++st.k),
    /** End the hold and let what the server held on the link in use go (`edit` may re-stamp each state first). */
    release(edit?: (m: HostMessage) => HostMessage) {
      st.holding = false;
      st.released = true;
      w.line.release(edit);
    },
  };
}
