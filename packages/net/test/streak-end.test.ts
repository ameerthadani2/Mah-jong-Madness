/**
 * One end for the screen and the audit (`streakEnd`). The app counts the seat's clock to the latest end
 * any state of the move it owes claimed, and never to less than the rules' clock as the phone tracks it;
 * the audit holds the table to that same end. So a server that offers a later end and takes it back
 * cannot let the player wait past the true end and then play the turn green: the table's move before the
 * end the screen showed is red. Ends of another clock era of the host are not compared: when the host
 * announces a restart while the seat owes a move and then plays that move, the hand is amber.
 */
import { describe, expect, it, vi } from 'vitest';
import { chooseAction, legalActions, withRules, type Action, type RuleSet } from '@mjm/engine';
import type { HostMessage } from '../src/index';
import { BANK_ROUND_MS, type ClockBase } from '../src/clientclock';
import { claimEnd, clockTrack, FLIGHT_SLACK_MS, flightAllowance, ownRun, restartInRun, streakEnd, type LateScope } from '../src/clientmoves';
import type { CeremonyRecord, ClockAnchor, PlayRecord, SeenState } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { BANK, RULES, TURN, wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
/** Deal the same hands again: the random source every secret is drawn from starts over from `seed` (as `seededDeals` does). */
function reseed(seed: number): void {
  let st = seed;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
    for (let k = 0; k < buf.length; k++) {
      st ^= st << 13;
      st ^= st >>> 17;
      st ^= st << 5;
      buf[k] = (st >>> 0) & 0xff;
    }
    return buf;
  }) as never);
}
const HYPER = withRules({ handsPerMatch: 1, turnSeconds: 4, timeBankSeconds: 0 });
const plays = (w: Wire) => (w.c as unknown as { plays: PlayRecord[] }).plays;
/** What the server knows of its own clock for a seat: when the seat's time runs out, on the host's clock. */
const hostOf = (w: Wire) => w.host as unknown as { clocks: Map<number, { base: number; inBank: boolean }>; banks: number[]; now: () => number };
const hostEnd = (w: Wire, seat = 0): number | null => {
  const c = hostOf(w).clocks.get(seat);
  return c ? c.base + hostOf(w).banks[seat] : null;
};
/** The time the phone's screen shows for the seat's own move (ms), null when it shows none. */
const screenLeft = (w: Wire): number | null => {
  const o = w.c.ownClock();
  return o ? o.bankEnd - w.c.clockNow() : null;
};
/** The phone shows the seat owing a move at turn `tc`. */
const shownOwing = (w: Wire, tc: number): boolean => {
  const s = w.c.localState();
  if (!s || s.turnCounter !== tc || w.c.state.lastResult !== null) return false;
  try {
    return legalActions(s, 0).length > 0;
  } catch {
    return false;
  }
};
/** The seat makes the move its phone shows at turn `tc` once its screen shows `show` ms or less (once). */
function byScreen(w: Wire, tc: number, show: number, done: Set<number>): void {
  if (done.has(tc) || !shownOwing(w, tc)) return;
  const left = screenLeft(w);
  if (left === null || left > show) return;
  done.add(tc);
  w.c.act(chooseAction(w.c.localState()!, 0, { seed: 'p' }) as Action);
}

/** A state this device's run `r` saw arrive at `at`, stamped `now`, showing the seat a move with `deadline`. */
const state = (tc: number, at: number, now: number, deadline: number, extra: Partial<SeenState> = {}): SeenState => ({ tc, epoch: 1, era: 0, at, atLo: at, now, run: 'r', seg: 0, onLink: true, owes: true, deadline, timeBank: BANK / 1000, inBank: false, hash: `h${tc}`, ...extra });
const playOf = (seen: SeenState[]) => ({ seen }) as unknown as PlayRecord;

describe('streakEnd: the end the audit and the screen share', () => {
  const r0 = state(10, 100_080, 100_000, 100_000 + TURN);
  it('one state: its deadline plus the bank it states; in the bank, its deadline', () => {
    expect(claimEnd(r0)).toBe(100_000 + TURN + BANK);
    expect(claimEnd({ ...r0, inBank: true, deadline: 130_000 })).toBe(130_000);
    expect(claimEnd({ ...r0, deadline: null })).toBe(Number.NEGATIVE_INFINITY);
    // The app takes off the host's rounding of a stated bank, never below the deadline.
    expect(claimEnd(r0, 500)).toBe(100_000 + TURN + BANK - 500);
    expect(claimEnd({ ...r0, timeBank: 0 }, 500)).toBe(100_000 + TURN);
    expect(streakEnd(playOf([r0]), 0, RULES, null)).toBe(100_000 + TURN + BANK);
  });

  it('an end offered and taken back still counts (T23); so does a bank offered and taken back (T24)', () => {
    const more = state(10, 100_090, 100_000, 100_000 + TURN + 60_000);
    const bank = state(10, 100_090, 100_000, 100_000 + TURN, { timeBank: BANK / 1000 + 60 });
    const back = state(10, 100_100, 100_000, 100_000 + TURN);
    expect(streakEnd(playOf([r0, more, back]), 2, RULES, null)).toBe(100_000 + TURN + 60_000 + BANK);
    expect(streakEnd(playOf([r0, bank, back]), 2, RULES, null)).toBe(100_000 + TURN + BANK + 60_000);
    // As it stood at the first state, before the offer.
    expect(streakEnd(playOf([r0, more, back]), 0, RULES, null)).toBe(100_000 + TURN + BANK);
  });

  it('the rules’ clock as tracked is a floor: a state that claims less does not shorten the end (T26)', () => {
    expect(streakEnd(playOf([{ ...r0, deadline: 100_000 + TURN - 10_000 }]), 0, RULES, 100_000 + TURN + BANK)).toBe(100_000 + TURN + BANK);
    expect(streakEnd(playOf([r0]), 0, RULES, Number.NaN)).toBe(100_000 + TURN + BANK);
  });

  it('an end a claim window claimed counts for the turn after it when the turn did not arm a later clock (T25), and not when it did', () => {
    // The seat answered a claim window at turn 20 and owes its own turn at 22: no state between showed it owing nothing.
    const turnAt = 110_000;
    const turn = state(22, turnAt + 80, turnAt, turnAt + TURN);
    const inflated = state(20, 105_080, 105_000, 105_000 + TURN + 60_000);
    const honest = state(20, 105_080, 105_000, 105_000 + TURN);
    expect(ownRun(playOf([inflated, turn]), RULES)).toHaveLength(2);
    expect(streakEnd(playOf([inflated, turn]), 1, RULES, null)).toBe(105_000 + TURN + 60_000 + BANK);
    // An honest window ends before the turn's clock does, so the turn arms a later clock and starts the streak.
    expect(ownRun(playOf([honest, turn]), RULES)).toEqual([turn]);
    expect(streakEnd(playOf([honest, turn]), 1, RULES, null)).toBe(turnAt + TURN + BANK);
  });

  it('only ends of the latest state’s clock era count; a streak across eras is a restart during the move (T28)', () => {
    const more = state(10, 100_090, 100_000, 100_000 + TURN + 60_000);
    const after = state(10, 139_600, 139_600, 140_000, { era: 1, inBank: true, timeBank: 0 });
    const play = playOf([r0, more, after]);
    expect(streakEnd(play, 2, RULES, null)).toBe(140_000);
    expect(restartInRun(play, 10, RULES)).toBe(true);
    expect(restartInRun(playOf([r0, more]), 10, RULES)).toBe(false);
    // A restart before the move began is not one during it.
    const before = state(8, 99_000, 99_000, 99_000, { era: 0, owes: false, deadline: null });
    const fresh = state(10, 100_080, 100_000, 100_000 + TURN, { era: 1 });
    expect(restartInRun(playOf([before, fresh]), 10, RULES)).toBe(false);
    // A state restored damaged may read any era (one flipped bit made it 5e-324): it says nothing of a restart.
    expect(restartInRun(playOf([r0, { ...more, era: 5e-324, kept: false }]), 10, RULES)).toBe(false);
    expect(restartInRun(playOf([r0, { ...more, kept: false }, after]), 10, RULES)).toBe(true);
  });
});

/**
 * The server sends the seat the state of its `nth` own turn honestly, and right behind it the copies `copies` makes
 * of it (the same view, hash and stamp); the seat makes every other move 600 ms after it is shown, and that one by
 * its screen (`show`). The table's host times it out at the true end.
 */
function offered(code: string, rules: RuleSet, copies: (m: Extract<HostMessage, { t: 'state' }>) => HostMessage[], show: number, nth = 2) {
  let target = -1;
  let turns = 0;
  const done = new Set<number>();
  const seen = new Set<number>();
  let shownMax = 0;
  /** The bank the screen showed after the turn clock, when first shown the turn. */
  let gap: number | null = null;
  const w = wire({
    code,
    rules,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? Infinity : 600),
    after: (m, w) => {
      if (m.t !== 'state' || target >= 0 || !w.discardTurn() || w.host.game!.turnCounter !== m.view.turnCounter || seen.has(m.view.turnCounter)) return [];
      seen.add(m.view.turnCounter);
      if (++turns < nth) return [];
      target = m.view.turnCounter;
      return copies(m);
    },
    onTick: (w) => {
      if (target < 0) return;
      const o = shownOwing(w, target) ? w.c.ownClock() : null;
      if (o && gap === null) gap = o.bankEnd - o.turnEnd;
      if (o) shownMax = Math.max(shownMax, o.bankEnd - w.c.clockNow());
      byScreen(w, target, show, done);
    },
  });
  w.finish();
  return { w, target, tableTook: () => w.judged().includes(target), shownMax, gap };
}

describe('an end the screen showed binds the table (R9)', () => {
  for (const [name, rules, extra, show] of [
    ['Normal (15 + 30 s), 60 s more', RULES, 60_000, 3_000],
    ['Hyper (4 + 0 s), 3 s more', HYPER, 3_000, 2_000],
  ] as const) {
    it(`${name}: the turn state, then at once a copy with a later deadline and one with the true deadline; the seat moves when its screen shows ${show / 1000} s, the table times it out at the true end: red playedEarly; without the copies the seat moves itself, green (T23)`, () =>
      scenario((i) => {
        reseed(7_100 + i);
        const t = offered(`SEA${extra}${i}`, rules, (m) => [{ ...m, deadline: (m.deadline as number) + extra }, { ...m }], show);
        need(t.target >= 0 && t.tableTook());
        // The screen counted to the later end the copy offered (its bank less the host's rounding of it), and the table
        // played the turn while it still showed it.
        expect(t.shownMax).toBeGreaterThan(extra - 1_000);
        expect(t.gap).toBe(rules.timeBankSeconds > 0 ? rules.timeBankSeconds * 1000 - BANK_ROUND_MS : 0);
        expect(t.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
        // The same deal with no copies: the seat moves by its screen, in time, and nothing fails.
        reseed(7_100 + i);
        const honest = offered(`SEA${extra}${i}`, rules, () => [], show);
        expect(honest.target).toBe(t.target);
        expect(honest.tableTook()).toBe(false);
        expect(honest.w.verdict()).toEqual({ status: 'ok', failures: [], caveats: [] });
      }));
  }

  it('the same with 60 s more bank offered and taken back (Normal): red playedEarly (T24)', () =>
    scenario((i) => {
      const t = offered(`SEB${i}`, RULES, (m) => [{ ...m, timeBank: m.timeBank + 60 }, { ...m }], 3_000);
      need(t.target >= 0 && t.tableTook());
      expect(t.shownMax).toBeGreaterThan(60_000);
      expect(t.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('an end offered on an earlier move of the same streak: a claim window stated 60 s late, the states between the seat’s answer and its next move withheld, that move given its true clock and timed out at its true end: red playedEarly (T25)', () =>
    scenario((i) => {
      let window = -1;
      let next = -1;
      let hiding = false;
      const hidden = new Set<number>();
      const done = new Set<number>();
      let shownMax = 0;
      const w = wire({
        code: `SEC${i}`,
        botDelayMs: 700,
        think: (_k, tc) => (tc === next ? Infinity : 600),
        map: (m, w) => {
          const g = w.host.game;
          if (m.t === 'state' && g && g.turnCounter === m.view.turnCounter) {
            if (window < 0 && g.phase === 'claim' && w.owes() && typeof m.deadline === 'number' && !m.inTimeBank) {
              window = m.view.turnCounter;
              hiding = true;
              return { ...m, deadline: m.deadline + 60_000 };
            }
            if (hiding && m.view.turnCounter > window) {
              if (!w.owes()) {
                hidden.add(m.view.turnCounter);
                return null;
              }
              hiding = false;
              next = m.view.turnCounter;
            }
          }
          // (Nor a clock frame for a turn whose state it withheld.)
          if (m.t === 'clock' && hidden.has(m.tc)) return null;
          return m;
        },
        onTick: (w) => {
          if (next < 0) return;
          if (shownOwing(w, next)) shownMax = Math.max(shownMax, screenLeft(w) ?? 0);
          byScreen(w, next, 3_000, done);
        },
      });
      w.finish();
      need(next >= 0 && w.judged().includes(next));
      const play = plays(w).find((p) => p.hand === w.c.state.lastAudit?.handNumber)!;
      const i0 = play.seen.findIndex((f) => f.tc === next);
      // The streak of the next move reaches back to the window, and its end is the window's.
      expect(ownRun(play, RULES, i0).map((f) => f.tc)).toContain(window);
      expect(streakEnd(play, i0, RULES, null)).toBeGreaterThan(claimEnd(play.seen[i0]) + 30_000);
      expect(shownMax).toBeGreaterThan(30_000);
      expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('a shorter end stated on a new link: the seat’s turn starts while its link is down, and on its return the server states, and times it out at, an end 10 s short of the rules’ clock as the phone tracks it; the screen still counts to that clock, and the table’s move before it is red (T26)', () =>
    scenario((i) => {
      let turn = -1;
      let cut = false;
      let reading: { screen: number; bound: number; stated: number } | null = null;
      const w = wire({
        code: `SED${i}`,
        botDelayMs: 1_000,
        think: (_k, tc) => (tc === turn ? Infinity : 600),
        onTick: (w) => {
          const g = w.host.game;
          // The link drops while the seat owes nothing and another seat is to move (its second time round, at least).
          if (turn < 0 && w.pendingReconnectAt === null && w.drops.length === 0 && g && g.turnCounter > 8 && !w.owes() && w.c.state.view?.turnCounter === g.turnCounter) w.dropNow(4_000);
          // The seat's turn starts while it is away: the server takes 10 s off its clock.
          if (!cut && w.pendingReconnectAt !== null && w.discardTurn() && hostOf(w).clocks.has(0)) {
            cut = true;
            turn = g!.turnCounter;
            hostOf(w).clocks.get(0)!.base -= 10_000;
          }
          if (cut && reading === null && shownOwing(w, turn) && w.c.state.deadline !== null) {
            const c = w.c as unknown as { clockBase: ClockBase; recordFor(h: number): CeremonyRecord | null; dealFixed(h: number): ClockAnchor | null };
            const h = w.c.state.view!.handNumber;
            const play = plays(w).find((p) => p.hand === h)!;
            const deal = c.dealFixed(h);
            const bound = clockTrack(c.clockBase, c.recordFor(h), play, w.rules, [...(deal ? [deal] : []), ...(play.pongs ?? [])]).bound.get(play.seen[play.seen.length - 1]) as number;
            // The phone's clock and the table's run together here: the screen's end, on the table's clock.
            const o = w.c.ownClock();
            if (o) reading = { screen: o.bankEnd - w.c.clockNow() + hostOf(w).now(), bound, stated: hostEnd(w) as number };
          }
        },
      });
      w.finish();
      need(cut && reading !== null && w.judged().includes(turn));
      const r = reading as unknown as { screen: number; bound: number; stated: number };
      // The server's end is well short of the rules' clock as tracked; the screen counts to the latter.
      expect(r.bound - r.stated).toBeGreaterThan(2_000);
      expect(Math.abs(r.screen - r.bound)).toBeLessThanOrEqual(500);
      expect(w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));
});

/**
 * The server shows the seat its `nth` own turn and drops the move the seat sends for it by its screen (when the screen
 * shows `show` ms) once the host's clock passes `cut`, then lets the host time the seat out. `bank0`: the states that
 * show the turn before the bank state no bank (the host keeps the real one, and its state in the bank is honest), and
 * the move is dropped once the turn clock is over; `ext`: right behind the turn's first state the server sends a copy
 * with its deadline 20 s later, keeps to it (the host's clock moves 20 s), and drops the move once the first state's
 * own end is over; `none`: honest states, dropped as `bank0`.
 */
function swallowed(code: string, kind: 'bank0' | 'ext' | 'none', show: number, nth = 2) {
  const X = 20_000;
  let target = -1;
  let turns = 0;
  /** On the host's clock: the turn's first state's own end (deadline plus the bank it states), and when the move is dropped. */
  let firstEnd: number | null = null;
  let cut: number | null = null;
  let extSent = false;
  const seen = new Set<number>();
  const sent: Action[] = [];
  let dropped: Action | null = null;
  let screenAtSend: number | null = null;
  const w = wire({
    code,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? Infinity : 600),
    map: (m, w) => {
      if (m.t !== 'state' || typeof m.deadline !== 'number' || m.inTimeBank || !w.discardTurn() || w.host.game!.turnCounter !== m.view.turnCounter) return m;
      if (target < 0 && !seen.has(m.view.turnCounter)) {
        seen.add(m.view.turnCounter);
        if (++turns === nth) target = m.view.turnCounter;
      }
      if (m.view.turnCounter !== target) return m;
      const out = kind === 'bank0' ? { ...m, timeBank: 0 } : m;
      if (firstEnd === null) {
        firstEnd = out.deadline! + out.timeBank * 1000;
        cut = kind === 'ext' ? firstEnd : m.deadline!;
        if (kind === 'ext') hostOf(w).clocks.get(0)!.base += X;
      }
      return out;
    },
    after: (m, w) => {
      if (kind !== 'ext' || extSent || m.t !== 'state' || m.view.turnCounter !== target || m.inTimeBank || typeof m.deadline !== 'number') return [];
      extSent = true;
      return [{ ...m, deadline: m.deadline + X, now: hostOf(w).now() }];
    },
    onTick: (w) => {
      if (target < 0 || sent.length > 0 || !shownOwing(w, target)) return;
      const left = screenLeft(w);
      if (left === null || left > show) return;
      screenAtSend = left;
      const a = chooseAction(w.c.localState()!, 0, { seed: 'p' }) as Action;
      sent.push(a);
      w.c.act(a);
    },
  });
  // The server drops the seat's move for the turn once the host's clock passes the cut.
  const send = w.line.link.send;
  w.line.link.send = (m) => {
    const x = m as { t?: string; turnCounter?: number; action?: Action };
    if (x.t === 'action' && x.turnCounter === target && cut !== null && hostOf(w).now() >= cut) {
      dropped = x.action ?? null;
      return;
    }
    send(m);
  };
  w.finish();
  const audit = w.c.state.lastAudit;
  const taken = audit?.log.find((e) => e.seat === 0 && e.n === target && e.source !== 'player');
  // The table played its own move over the one the seat sent (a timeout move equal to the seat's takes nothing).
  const over = dropped !== null && taken !== undefined && JSON.stringify(taken.action) !== JSON.stringify(dropped);
  return { w, target, over, screenAtSend: screenAtSend as number | null };
}

describe('a move sent with time on the screen, lost to the table’s own (R4 against the end the screen showed, T29)', () => {
  for (const [kind, what] of [
    ['bank0', 'the turn’s state says the bank is spent while the host keeps it, so the screen runs on into the bank the phone tracked'],
    ['ext', 'right behind the turn’s state, a copy with a deadline 20 s later that the host keeps to'],
  ] as const) {
    it(`Normal: ${what}; the seat moves when its screen shows 3 s, the server drops the move and the table plays its own at the end: amber inFlight, never green`, () =>
      scenario((i) => {
        reseed(7_300 + i);
        const t = swallowed(`SEF${kind}${i}`, kind, 3_000);
        need(t.target >= 0 && t.over);
        expect(t.screenAtSend).toBeGreaterThan(2_000);
        expect(t.w.verdict()).toEqual({ status: 'partial', failures: [], caveats: ['inFlight'] });
        // The same deal with honest states, the move dropped once the turn clock is over: amber inFlight as well.
        reseed(7_300 + i);
        const honest = swallowed(`SEF${kind}${i}`, 'none', 3_000);
        need(honest.target === t.target && honest.over);
        expect(honest.w.verdict()).toEqual({ status: 'partial', failures: [], caveats: ['inFlight'] });
      }));
  }
});

/**
 * Normal. One second into the seat's `nth` own turn the server says the seat was opened on another device; the link
 * closes half a second later and the user resumes the table from Home a second after that (a new run of the app, on a
 * new link the table welcomes, every ping answered, the app's join ping sent). The seat moves when its screen shows
 * `show` ms; the server drops that move and the host times the seat out at the turn's true end. `kick` false: the same
 * drop with no resume (the control). `silent`: from the notice on the server answers no ping until the turn is over
 * (the app's join ping included), so the new run of the app measures no round trip of its own before the move.
 */
function resumedDrop(code: string, kick: boolean, show: number, nth = 2, silent = false) {
  let target = -1;
  let turns = 0;
  const seen = new Set<number>();
  let closeAt: number | null = null;
  let resumeAt: number | null = null;
  let kicked = false;
  let resumed = !kick;
  let acted = false;
  let dropped: Action | null = null;
  let screenAtSend: number | null = null;
  /** The server drops the seat's move for the target turn on the link in use. */
  const drop = (w: Wire) => {
    const send = w.line.link.send;
    w.line.link.send = (m) => {
      const x = m as { t?: string; turnCounter?: number; action?: Action };
      if (x.t === 'action' && x.turnCounter === target) {
        dropped = x.action ?? null;
        return;
      }
      send(m);
    };
  };
  const w = wire({
    code,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? Infinity : 600),
    map: (m, w) => {
      if (target < 0 && m.t === 'state' && typeof m.deadline === 'number' && !m.inTimeBank && w.discardTurn() && w.host.game!.turnCounter === m.view.turnCounter && !seen.has(m.view.turnCounter)) {
        seen.add(m.view.turnCounter);
        if (++turns === nth) target = m.view.turnCounter;
      }
      if (silent && kicked && m.t === 'pong' && w.host.phase === 'playing' && w.host.game!.turnCounter <= target) return null;
      return m;
    },
    onTick: (w) => {
      const now = w.clock.now;
      const shown = target >= 0 ? w.shown.get(target) : undefined;
      if (kick && !kicked && shown !== undefined && now >= shown + 1_000) {
        kicked = true;
        w.line.inject({ t: 'disconnected' });
        closeAt = now + 500;
      }
      if (closeAt !== null && now >= closeAt) {
        closeAt = null;
        w.line.close();
        resumeAt = now + 1_000;
      }
      if (resumeAt !== null && now >= resumeAt) {
        resumeAt = null;
        w.restart();
        w.c.ping();
        drop(w);
        resumed = true;
      }
      if (!resumed || acted || target < 0 || !shownOwing(w, target)) return;
      const left = screenLeft(w);
      if (left === null || left > show) return;
      acted = true;
      screenAtSend = left;
      w.c.act(chooseAction(w.c.localState()!, 0, { seed: 'p' }) as Action);
    },
  });
  if (!kick) drop(w);
  w.finish();
  const taken = w.c.state.lastAudit?.log.find((e) => e.seat === 0 && e.n === target && e.source !== 'player');
  const over = dropped !== null && taken !== undefined && JSON.stringify(taken.action) !== JSON.stringify(dropped);
  return { w, target, over, kicked, screenAtSend: screenAtSend as number | null };
}

describe('the round trip that bounds a move lost on its way (flightAllowance)', () => {
  const scope: LateScope = { run: 'r2', best: null, pauses: [], earlier: [{ run: 'r1', best: null, pauses: [] }] };
  const k = (run: string, at: number, rtt: number, era = 0, seg = 0): ClockAnchor => ({ at, now: at, era, run, seg, fat: at + rtt });
  const x = { at: 100_000, run: 'r2', seg: 0 };
  it('is the least round trip measured before the move was sent, in an earlier run of the app or another era of the host as well as its own; never one measured after it, in a later run or in a run the record does not hold', () => {
    expect(flightAllowance(x, [], scope, 7_500)).toBe(7_500);
    expect(flightAllowance(x, [k('r1', 10_000, 200)], scope, 7_500)).toBe(200 + FLIGHT_SLACK_MS);
    expect(flightAllowance(x, [k('r2', 50_000, 300, 1)], scope, 7_500)).toBe(300 + FLIGHT_SLACK_MS);
    expect(flightAllowance(x, [k('r2', 50_000, 300), k('r1', 10_000, 900)], scope, 7_500)).toBe(300 + FLIGHT_SLACK_MS);
    expect(flightAllowance(x, [k('r2', 120_000, 100)], scope, 7_500)).toBe(7_500);
    expect(flightAllowance({ at: 100_000, run: 'r1', seg: 0 }, [k('r2', 10_000, 100)], scope, 7_500)).toBe(7_500);
    expect(flightAllowance(x, [k('r9', 10_000, 100)], scope, 7_500)).toBe(7_500);
    expect(flightAllowance(x, [k('r2', 10_000, 100, 0, 1)], scope, 7_500)).toBe(7_500);
    // The strongest tie each run carried from the hands before, by the same rule; never more than the limit.
    const carried: LateScope = { ...scope, earlier: [{ run: 'r1', best: { era: 0, run: 'r1', seg: 0, value: 0, at: 5_000, rtt: 150 }, pauses: [] }] };
    expect(flightAllowance(x, [], carried, 7_500)).toBe(150 + FLIGHT_SLACK_MS);
    expect(flightAllowance(x, [k('r1', 10_000, 20_000)], scope, 7_500)).toBe(7_500);
  });
});

describe('a move made after an app resume the server forced, lost to the table’s own (R4 in the run that sent the move)', () => {
  it('Normal: the same with 5 s on the screen, and the table answering no ping of the new run of the app until the turn is over: the hand’s best round trip, measured before the resume, still bounds the allowance, so amber inFlight, never green', () =>
    scenario((i) => {
      reseed(7_800 + i);
      const t = resumedDrop(`SEQ${i}`, true, 5_000, 2, true);
      need(t.target >= 0 && t.kicked && t.over);
      expect(t.screenAtSend).toBeGreaterThan(4_000);
      expect(t.w.verdict().failures).toEqual([]);
      expect(t.w.verdict().status).toBe('partial');
      expect(t.w.verdict().caveats).toContain('inFlight');
    }));
  for (const show of [3_000, 10_000]) {
    it(`Normal: the seat opened “on another device” a second into the turn, the table resumed from Home, the move made with ${show / 1000} s on the screen dropped and the seat timed out: amber inFlight, never green; the same without the resume`, () =>
      scenario((i) => {
        reseed(7_700 + i);
        const t = resumedDrop(`SER${show}${i}`, true, show);
        need(t.target >= 0 && t.kicked && t.over);
        expect(t.screenAtSend).toBeGreaterThan(show - 1_000);
        expect(t.w.verdict().failures).toEqual([]);
        expect(t.w.verdict().status).toBe('partial');
        expect(t.w.verdict().caveats).toContain('inFlight');
        reseed(7_700 + i);
        const ctl = resumedDrop(`SER${show}${i}`, false, show);
        need(ctl.target === t.target && ctl.over);
        expect(ctl.w.verdict()).toEqual({ status: 'partial', failures: [], caveats: ['inFlight'] });
      }));
  }
});

describe('honest ends (T27)', () => {
  const speeds: Array<[string, number, number]> = [
    ['Relaxed', 30, 60],
    ['Normal', 15, 30],
    ['Fast', 10, 20],
    ['Turbo', 7, 10],
    ['Hyper', 4, 0],
  ];
  for (const [name, turnS, bankS] of speeds) {
    it(`${name} (${turnS} + ${bankS} s): calm turns, the bank used, claim windows, a rejoin in the middle of a turn and a server restart in the middle of the hand: the end of every state that shows the seat a move is within 0.5 s of the host’s own, and the screen’s time left within a round trip of the host’s`, () =>
      scenario((i) => {
        const rules = withRules({ handsPerMatch: 1, turnSeconds: turnS, timeBankSeconds: bankS });
        const ends = new Map<string, number>();
        const readings: Array<{ screen: number; host: number }> = [];
        let dropped = false;
        let restarted = false;
        const w = wire({
          code: `SEH${name}${i}`,
          rules,
          botDelayMs: 700,
          // Most moves quickly; now and then into the bank, or out to the table's move.
          think: (k) => (k % 6 === 3 ? (turnS + bankS / 2) * 1_000 : k % 9 === 5 ? 3_600_000 : 600),
          map: (m, w) => {
            // What the host's own clock says, as it sends the seat each state that shows it a move.
            if (m.t === 'state' && w.owes() && typeof m.now === 'number') {
              const e = hostEnd(w);
              if (e !== null) ends.set(`${m.view.turnCounter}:${m.now}`, e);
            }
            return m;
          },
          onTick: (w) => {
            const g = w.host.game;
            if (!g || w.host.phase !== 'playing') return;
            // A rejoin in the middle of one of the seat's turns, and later a restart of the server's process.
            if (!dropped && g.turnCounter > 8 && w.discardTurn() && w.current() && w.pendingReconnectAt === null) {
              dropped = true;
              w.dropNow(1_500);
            }
            if (dropped && !restarted && g.turnCounter > 20 && w.pendingReconnectAt === null) {
              restarted = true;
              w.restartHost(1_000);
            }
            const e = hostEnd(w);
            const left = screenLeft(w);
            if (e !== null && left !== null && w.current() && w.pendingReconnectAt === null) readings.push({ screen: left, host: e - hostOf(w).now() });
          },
        });
        w.finish();
        need(dropped && restarted && w.c.state.lastAudit !== null);
        const audit = w.c.state.lastAudit!;
        const play = plays(w).find((p) => p.hand === audit.handNumber)!;
        const c = w.c as unknown as { clockBase: ClockBase; recordFor(h: number): CeremonyRecord | null };
        const track = clockTrack(c.clockBase, c.recordFor(audit.handNumber), play, rules, play.pongs ?? []);
        let checked = 0;
        play.seen.forEach((f, k) => {
          const e = f.owes ? ends.get(`${f.tc}:${f.now}`) : undefined;
          if (e === undefined) return;
          expect(Math.abs(streakEnd(play, k, rules, track.bound.get(f)) - e)).toBeLessThanOrEqual(500);
          checked++;
        });
        expect(checked).toBeGreaterThan(5);
        expect(new Set(play.seen.map((f) => f.era ?? 0)).size).toBe(2);
        // One wire step (500 ms) of round trip; the screen also takes off the host's rounding of the bank it states
        // (up to 0.5 s) and allows for it (0.5 s), so it may show up to 1 s less, never more.
        expect(readings.length).toBeGreaterThan(10);
        for (const r of readings) {
          expect(r.screen).toBeLessThanOrEqual(r.host + 500);
          expect(r.screen).toBeGreaterThanOrEqual(r.host - 1_000 - 500);
        }
      }));
  }
});

describe('a restart during the move (R9, T28)', () => {
  /**
   * A later end offered (a state re-sent with 60 s more), then a restart announced 1 to 1.5 s before the true end, with
   * a ping on its way, and the seat timed out at the true end. `newLink`: as a restarted table announces it, the link
   * drops and the notice is the new link's first word, followed by the turn's state as the table now has it;
   * otherwise the notice and the turn's state at the true end come on the link that never dropped.
   */
  function restartBeforeEnd(code: string, newLink: boolean) {
    let target = -1;
    let turns = 0;
    let restarted = false;
    const w = wire({
      code,
      botDelayMs: 700,
      // The seat's messages take half a second to reach the table, so a ping is on its way when the restart is announced.
      up: () => 500,
      think: (_k, tc) => (tc === target ? Infinity : 600),
      after: (m, w) => {
        if (m.t !== 'state' || target >= 0 || !w.discardTurn() || w.host.game!.turnCounter !== m.view.turnCounter) return [];
        if (++turns < 2) return [];
        target = m.view.turnCounter;
        return [{ ...m, deadline: (m.deadline as number) + 60_000 }];
      },
      onTick: (w) => {
        const end = target >= 0 && w.current() && w.host.game!.turnCounter === target ? hostEnd(w) : null;
        // 1 to 1.5 s before the true end, with a ping on its way (the phone pings on the whole second).
        if (restarted || end === null || hostOf(w).now() < end - 1_500 || w.clock.now % 1_000 !== 500) return;
        restarted = true;
        const v = w.c.state.view!;
        if (newLink) {
          w.afterWelcome({ t: 'restored', handNumber: v.handNumber, turnCounter: v.turnCounter });
          w.dropNow(300);
          return;
        }
        w.line.inject({ t: 'restored', handNumber: v.handNumber, turnCounter: v.turnCounter });
        w.line.inject({ t: 'state', view: v, hash: w.c.state.stateHash!, deadline: end, timeBank: 0, inTimeBank: true, now: hostOf(w).now() });
      },
    });
    w.finish();
    need(restarted && w.judged().includes(target));
    return w.verdict();
  }

  it('a later end offered, then a restart announced just before the true end, as the first word of a new link, and the seat timed out: amber restartClock, never green', () =>
    scenario((i) => {
      const v = restartBeforeEnd(`SER${i}`, true);
      expect(v).toMatchObject({ status: 'partial', failures: [] });
      expect(v.caveats).toContain('restartClock');
    }));

  it('the same restart announced on the link that never dropped, with the turn state again at the true end: red, the notice changes nothing and the later end binds the table', () =>
    scenario((i) => {
      const v = restartBeforeEnd(`SEM${i}`, false);
      expect(v.status).toBe('failed');
      expect(v.failures).toEqual(expect.arrayContaining(['restartMidLink', 'playedEarly']));
    }));

  it('a restart while the seat owes nothing, followed by an answered ping, then a turn the table times out: no restartClock', () =>
    scenario((i) => {
      let restartTc = -1;
      let target = -1;
      const w = wire({
        code: `SES${i}`,
        botDelayMs: 700,
        think: (_k, tc) => (tc === target ? Infinity : 600),
        onTick: (w) => {
          const g = w.host.game;
          if (!g || w.host.phase !== 'playing') return;
          if (restartTc < 0 && g.turnCounter > 10 && !w.owes() && w.c.state.view?.turnCounter === g.turnCounter) {
            restartTc = g.turnCounter;
            w.restartHost(1_000);
          }
          // The seat's next own turn after it is back, a few seconds on.
          if (restartTc >= 0 && target < 0 && w.pendingReconnectAt === null && w.discardTurn() && g.turnCounter > restartTc + 4) target = g.turnCounter;
        },
      });
      w.finish();
      need(restartTc >= 0 && target >= 0 && w.judged().includes(target));
      const play = plays(w).find((p) => p.hand === w.c.state.lastAudit?.handNumber)!;
      expect(new Set(play.seen.map((f) => f.era ?? 0)).size).toBe(2);
      expect(w.verdict().caveats).not.toContain('restartClock');
      expect(w.verdict().failures).toEqual([]);
    }));
});

/**
 * Normal. At the seat's third own turn (a discard) it moves 5 s after the turn is shown, with most of the turn clock
 * still on its screen; the server drops that move and (`cut`) cuts the link at once, as a lost connection would. The
 * phone joins again a second later and is shown the turn again; the seat does not move again, and the table times it
 * out. `cut` false: the same drop on a link that stays up (the control).
 */
function droppedThenCut(code: string, cut: boolean) {
  let target = -1;
  let dropped: Action | null = null;
  const mineN = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;
  const w = wire({
    code,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? 5_000 : 600),
    map: (m, w) => {
      if (target < 0 && m.t === 'state' && w.discardTurn() && w.host.game!.turnCounter === m.view.turnCounter && mineN(w) >= 2) target = m.view.turnCounter;
      return m;
    },
    upFilter: (m, w) => {
      if (dropped || m.t !== 'action' || m.turnCounter !== target) return true;
      dropped = m.action;
      if (cut) w.dropNow(1_000);
      return false;
    },
  });
  w.finish();
  const taken = w.c.state.lastAudit?.log.find((e) => e.seat === 0 && e.n === target && e.source !== 'player');
  // (Only a move other than the one dropped took anything from the seat.)
  return { w, dropped: dropped !== null, taken: taken !== undefined && JSON.stringify(taken.action) !== JSON.stringify(dropped) };
}

describe('a move the server drops and then cuts the link (R4 across links)', () => {
  it('Normal: the move made with most of the turn clock showing, dropped, the link cut at once and the seat timed out on the new link: amber inFlight, never green; without the cut red, the move left lying more than 30 s on a link that never dropped', () =>
    scenario((i) => {
      const t = droppedThenCut(`SDC${i}`, true);
      need(t.dropped && t.taken);
      expect(t.w.drops).toHaveLength(1);
      expect(t.w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(t.w.verdict().caveats).toContain('inFlight');
      // Without the cut the move lies 40 s on a link that never dropped before the table plays over it: no network is that slow.
      const ctl = droppedThenCut(`SDC${i}`, false);
      need(ctl.dropped && ctl.taken);
      expect(ctl.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveIgnored'] });
    }));
});
