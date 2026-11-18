/**
 * The audit times a drop with a monotonic clock: a step of the device's wall clock back while the
 * link is down (the user changes the time, the network corrects it, a time zone trip on a phone set
 * to manual time) moves neither the verdict of an honest timeout nor that of a table that played the
 * seat inside a one-second drop. A phone's monotonic clock can stand still while the phone sleeps,
 * so when the wall clock runs more than a second further, the client counts the wall clock's time:
 * an honest timeout during sleep stays amber, not red. A wall clock stepped forward is counted the
 * same way, which can only turn a failure into amber. Only across an app restart does the client
 * meet wall time again.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules } from '@mjm/engine';
import { AUDIT_CAVEATS, clientClock, failureKey, LoopbackHub, steadyClock, TableClient, TableHost, transportLink, type Link } from '../src/index';
import { Missed, scenario, seededDeals } from './support';

seededDeals();

const TURN = 15_000;
const BANK = 30_000;
const CLOCKED = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const HOUR = 3_600_000;
const DOWN_EARLY = (turn: number) => `The table played for this seat while its connection was down, before its clock could have run out (turn ${turn})`;

interface Server {
  game: { turnCounter: number } | null;
  apply: (seat: number, action: NonNullable<ReturnType<typeof chooseAction>>, source: 'player' | 'bot' | 'timeout') => void;
  timeoutAction: (game: unknown, seat: number) => NonNullable<ReturnType<typeof chooseAction>>;
}

let links = 0;

/**
 * One human at seat 0 whose device has a wall clock (`clock.now + clock.wall`) and a monotonic one
 * (`clock.now`); the server keeps true time unless it moves its stamps `ahead`. `paced`: bot moves wait for `step()`.
 */
function seat(code: string, paced = false) {
  const clock = { now: 1_000_000, wall: 0, ahead: 0, slept: 0 };
  const hub = new LoopbackHub();
  const timers: Array<() => void> = [];
  const pace = paced ? { botDelayMs: 600, schedule: (fn: () => void) => void timers.push(fn) } : {};
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: CLOCKED, now: () => clock.now + clock.ahead, matchId: `m-${code}`, intermissionSeconds: 5, ...pace });
  const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now + clock.wall, monotonic: () => clock.now - clock.slept });
  c.join();
  host.start();
  const t = {
    clock,
    host,
    c,
    s: host as unknown as Server,
    owes: () => host.phase === 'playing' && !!c.localState() && legalActions(c.localState()!, 0).length > 0,
    discarding: () => t.owes() && legalActions(c.localState()!, 0).every((a) => a.type === 'discard'),
    act: () => c.act(chooseAction(c.localState()!, 0, { seed: 'p' })!),
    step: () => {
      const f = timers.shift();
      if (f) f();
      return !!f;
    },
    wait: (ms: number) => {
      for (let left = ms; left > 0; left -= 500) {
        clock.now += Math.min(500, left);
        host.tick();
      }
    },
    /** Time passes while the phone sleeps: its wall clock goes on, its monotonic clock stands still (Android's does). */
    sleep: (ms: number) => {
      for (let left = ms; left > 0; left -= 500) {
        const d = Math.min(500, left);
        clock.now += d;
        clock.slept += d;
        host.tick();
      }
    },
    drop: () => (c as unknown as { link: Link }).link.close(),
    back: () => {
      c.rebind(transportLink(hub.create(`p0r${links++}`), 'host'));
      c.join();
    },
    playUntil: (stop: () => boolean) => {
      for (let guard = 0; guard < 6000 && host.phase === 'playing'; guard++) {
        if (stop()) return true;
        if (t.owes()) t.act();
        else if (!t.step()) t.wait(60_000);
      }
      return false;
    },
    finish: () => {
      t.playUntil(() => false);
      expect(host.phase).not.toBe('playing');
    },
    verdict: () => [c.state.auditStatus, c.state.auditFailures, c.state.auditCaveats],
  };
  return t;
}

const nthDiscard = (t: ReturnType<typeof seat>, n: number) => {
  let seen = 0;
  let counted = -1;
  return () => {
    if (!t.discarding() || t.host.game!.turnCounter === counted) return false;
    counted = t.host.game!.turnCounter;
    return ++seen === n;
  };
};
const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

describe('a wall-clock step during a drop', () => {
  it.each([0, -HOUR, HOUR])('honest: a seat away for longer than its clock is timed out and the hand is amber (wall clock stepped %i ms while away)', (step) =>
    scenario(() => {
      const t = seat(`WS${step}`, true);
      need(t.playUntil(nthDiscard(t, 2)));
      t.drop();
      t.clock.wall += step;
      t.wait(TURN + BANK + 1_000);
      for (let i = 0; i < 12; i++) t.step();
      need(t.host.phase === 'playing');
      t.back();
      t.finish();
      expect(t.verdict()).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }),
  );

  // (A wall clock stepped forward an hour with the stamps forged to match is the case below.)
  it.each([
    [0, false],
    [-HOUR, false],
    [HOUR, false],
    [0, true],
    [-HOUR, true],
  ])('the seat played inside a one-second drop still fails the hand (wall clock stepped %i ms while away; server stamps forged ahead: %s)', (step, forged) =>
    scenario(() => {
      const t = seat(`WD${step}${forged}`);
      need(t.playUntil(nthDiscard(t, 3)));
      const turn = t.host.game!.turnCounter;
      t.drop();
      t.clock.wall += step;
      // A server that also stamps its frames as if the whole clock had run out meanwhile.
      if (forged) t.clock.ahead += TURN + BANK + 1_000;
      t.clock.now += 150;
      t.s.apply(0, t.s.timeoutAction(t.host.game!, 0), 'timeout');
      t.clock.now += 850;
      t.back();
      t.finish();
      expect(t.c.state.auditStatus).toBe('failed');
      expect(t.c.state.auditFailures).toContain(DOWN_EARLY(turn));
      expect(failureKey(DOWN_EARLY(turn))).toBe('playedWhileDown');
      expect(t.c.state.auditCaveats).toEqual([]);
    }),
  );
});

describe('a wall clock stepped forward during a drop', () => {
  it('lengthens the drop as the phone measures it, as sleep does: a seat played inside it, with the stamps forged to match, is amber, never green', () =>
    scenario(() => {
      const t = seat('WF1');
      need(t.playUntil(nthDiscard(t, 3)));
      t.drop();
      t.clock.wall += HOUR;
      t.clock.ahead += TURN + BANK + 1_000;
      t.clock.now += 150;
      t.s.apply(0, t.s.timeoutAction(t.host.game!, 0), 'timeout');
      t.clock.now += 850;
      t.back();
      t.finish();
      expect(t.verdict()).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }));
});

describe('a phone asleep during a drop', () => {
  it('honest: a seat timed out while its phone slept is amber, not red, though the phone\'s monotonic clock stood still', () =>
    scenario(() => {
      const t = seat('SL1', true);
      need(t.playUntil(nthDiscard(t, 2)));
      t.drop();
      t.sleep(TURN + BANK + 1_000);
      for (let i = 0; i < 12; i++) t.step();
      t.sleep(5 * 60_000);
      need(t.host.phase === 'playing');
      t.back();
      t.finish();
      expect(t.verdict()).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }));

  it('a seat played 150 ms into a drop the phone then slept through is amber, never green (a sleeping phone cannot time the move)', () =>
    scenario(() => {
      const t = seat('SL2');
      need(t.playUntil(nthDiscard(t, 3)));
      t.drop();
      t.clock.now += 150;
      t.s.apply(0, t.s.timeoutAction(t.host.game!, 0), 'timeout');
      t.sleep(10 * 60_000);
      t.back();
      t.finish();
      expect(t.verdict()).toEqual(['partial', [], [AUDIT_CAVEATS.tableMoved]]);
    }));
});

describe('the client clock', () => {
  it('measures within a run on the monotonic clock, from the wall time it started at', () => {
    const c = { wall: 5_000_000, mono: 42 };
    const now = clientClock({ now: () => c.wall, monotonic: () => c.mono });
    expect(now()).toBe(5_000_000);
    c.wall -= HOUR;
    c.mono += 1_000;
    expect(now()).toBe(5_001_000);
    // A restart reads the wall clock again: that is the only place wall time enters.
    expect(clientClock({ now: () => c.wall, monotonic: () => c.mono })()).toBe(5_000_000 - HOUR);
  });

  it('counts the time a sleeping phone\'s monotonic clock missed, from the wall clock, and only beyond a second', () => {
    const c = { wall: 5_000_000, mono: 42 };
    const now = clientClock({ now: () => c.wall, monotonic: () => c.mono });
    expect(now()).toBe(5_000_000);
    // Asleep ten minutes: the wall clock went on, the monotonic clock stood still.
    c.wall += 10 * 60_000;
    expect(now()).toBe(5_000_000 + 10 * 60_000);
    // The two clocks disagreeing by less than a second between readings is not sleep: the monotonic clock rules.
    c.wall += 900;
    c.mono += 400;
    expect(now()).toBe(5_000_000 + 10 * 60_000 + 400);
    // A wall clock stepped back an hour moves nothing; time goes on by the monotonic clock.
    c.wall -= HOUR;
    c.mono += 1_000;
    expect(now()).toBe(5_000_000 + 10 * 60_000 + 1_400);
  });

  it('counts the times it follows the wall clock instead of the monotonic one (its runs, or segments)', () => {
    const c = { wall: 5_000_000, mono: 42 };
    const now = clientClock({ now: () => c.wall, monotonic: () => c.mono }) as (() => number) & { segment?: number };
    now();
    expect(now.segment).toBe(0);
    // A wall clock set back, or ahead by less than a second more than the monotonic clock ran: the same run.
    c.wall -= HOUR;
    c.mono += 1_000;
    now();
    c.wall += 1_900;
    c.mono += 1_000;
    now();
    expect(now.segment).toBe(0);
    // Asleep: the wall clock ran on alone, and what the clock says of the host's after this is measured afresh.
    c.wall += 30_000;
    now();
    expect(now.segment).toBe(1);
    // A clock that is the injected `now` alone has no runs.
    expect((clientClock({ now: () => c.wall }) as { segment?: number }).segment).toBeUndefined();
  });

  it('with only `now` given, follows it exactly (the tests drive one clock)', () => {
    const c = { now: 7 };
    const now = clientClock({ now: () => c.now });
    c.now += HOUR;
    expect(now()).toBe(7 + HOUR);
    c.now -= 2 * HOUR;
    expect(now()).toBe(7 - HOUR);
  });

  it('defaults to the wall clock moved on by performance.now', () => {
    const now = clientClock();
    expect(Math.abs(now() - Date.now())).toBeLessThan(1_000);
  });
});

describe('the clock a server keeps its tables by', () => {
  it('steadyClock starts at the wall time and then moves only by the monotonic clock: a wall clock set back 60 s or forward 2 s moves nothing', () => {
    const c = { wall: 9_000_000, mono: 123 };
    const now = steadyClock(() => c.wall, () => c.mono);
    expect(now()).toBe(9_000_000);
    c.wall -= 60_000;
    c.mono += 500;
    expect(now()).toBe(9_000_500);
    c.wall += 62_000;
    c.mono += 500;
    expect(now()).toBe(9_001_000);
    c.mono += 10_000;
    expect(now()).toBe(9_011_000);
  });

  it('defaults to the wall clock moved on by performance.now', () => {
    const now = steadyClock();
    expect(Math.abs(now() - Date.now())).toBeLessThan(1_000);
  });
});
