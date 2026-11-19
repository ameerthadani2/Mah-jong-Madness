/**
 * The clock the app shows for the move its seat owes (`TableClient.ownClock`): the turn clock, then
 * the time bank, counted by the phone itself from the state that started the move, placed on the
 * phone's clock by the strongest fixed point it holds (the table's answers to its pings), never later
 * than that state's own clock counted from its arrival. It goes on to the bank without waiting for
 * the table to say so, and a wrong wall clock on the phone does not move it.
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { BANK_ROUND_MS, DRIFT_RATE, ownClockFrom } from '../src/clientclock';
import { ownRun, seatRun } from '../src/clientmoves';
import type { ClockAnchor, PlayRecord, SeenState } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { BANK, holdTurn, TURN, wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const plays = (w: { c: unknown }) => (w.c as { plays: PlayRecord[] }).plays;
const SCOPE = { era: 0, run: 'r', seg: 0 };

/** A state this device's run `r` saw arrive at `at`, stamped `now`, showing the seat a move with `deadline`. */
const state = (tc: number, at: number, now: number, deadline: number, extra: Partial<SeenState> = {}): SeenState => ({ tc, epoch: 1, era: 0, at, atLo: at, now, run: 'r', seg: 0, onLink: true, owes: true, deadline, timeBank: BANK / 1000, inBank: false, hash: `h${tc}`, ...extra });

describe('ownClockFrom: the arithmetic (T17)', () => {
  // This device's clock is 10 s ahead of the host's. A ping sent at 100 000 reached the host at its 90 050 and
  // the answer came back at 100 100: a fixed point worth 9 950, the most this device can know of the offset.
  const pong: ClockAnchor = { at: 100_000, now: 90_050, era: 0, run: 'r', seg: 0, fat: 100_100 };
  // The turn's state was stamped 95 000 with the whole turn clock, and arrived 80 ms later, at 105 080.
  const r0 = state(10, 105_080, 95_000, 95_000 + TURN);

  it('the turn clock, then the bank to its deadline plus the bank stated (less the host’s rounding), placed by the best fixed point', () => {
    const at = 106_000;
    const o = ownClockFrom([r0], [pong], null, 10_050, at, SCOPE)!;
    const offset = 9_950 - DRIFT_RATE * (at - pong.at);
    expect(o.turnEnd).toBeCloseTo(95_000 + TURN + offset, 6);
    expect(o.bankEnd).toBeCloseTo(95_000 + TURN + BANK - BANK_ROUND_MS + offset, 6);
  });

  it('with no fixed point, the state’s own clock counted from its arrival', () => {
    const o = ownClockFrom([r0], [], null, null, 106_000, SCOPE)!;
    expect(o.turnEnd).toBe(105_080 + TURN);
    expect(o.bankEnd).toBe(105_080 + TURN + BANK - BANK_ROUND_MS);
  });

  it('never later than the state’s own clock counted from its arrival, whatever a fixed point says', () => {
    // A "fixed point" that would place the turn 5 s later than the state's own clock allows.
    const generous: ClockAnchor = { at: 100_000, now: 85_000, era: 0, run: 'r', seg: 0, fat: 100_050 };
    const o = ownClockFrom([r0], [generous], null, null, 106_000, SCOPE)!;
    expect(o.turnEnd).toBe(105_080 + TURN);
  });

  it('the strongest fixed point carried from earlier hands counts when it is stronger, capped by its round trip', () => {
    const best = { era: 0, run: 'r', seg: 0, value: 9_990, at: 50_000, rtt: 40 };
    const at = 106_000;
    const o = ownClockFrom([r0], [pong], best, 10_050, at, SCOPE)!;
    expect(o.turnEnd).toBeCloseTo(95_000 + TURN + Math.min(9_990, 10_050 - 40) - DRIFT_RATE * (at - 50_000), 6);
    // Of another run of the app, or another run of the device's clock, it does not count.
    expect(ownClockFrom([r0], [], { ...best, run: 'x' }, 10_050, at, SCOPE)!.turnEnd).toBe(105_080 + TURN);
    expect(ownClockFrom([r0], [], { ...best, seg: 1 }, 10_050, at, SCOPE)!.turnEnd).toBe(105_080 + TURN);
  });

  it('a later state that adds time moves the end (a re-armed clock on a rejoin); one that takes time does not', () => {
    const later = state(10, 106_080, 96_000, 95_000 + TURN + 4_000);
    const less = state(10, 106_080, 96_000, 95_000 + TURN - 4_000, { timeBank: 5 });
    const base = ownClockFrom([r0], [pong], null, 10_050, 107_000, SCOPE)!;
    const plus = ownClockFrom([r0, later], [pong], null, 10_050, 107_000, SCOPE)!;
    const minus = ownClockFrom([r0, less], [pong], null, 10_050, 107_000, SCOPE)!;
    expect(plus.turnEnd - base.turnEnd).toBeCloseTo(4_000, 6);
    expect(minus).toEqual(base);
  });

  it('a state already in the bank: the turn clock is over at its stamp, and the bank ends at its deadline', () => {
    const bank = state(11, 120_080, 110_000, 110_000 + 20_000, { inBank: true, timeBank: 20 });
    const o = ownClockFrom([r0, bank], [pong], null, 10_050, 121_000, SCOPE)!;
    const offset = 9_950 - DRIFT_RATE * (121_000 - pong.at);
    expect(o.turnEnd).toBeCloseTo(110_000 + offset, 6);
    expect(o.bankEnd).toBeCloseTo(95_000 + TURN + BANK - BANK_ROUND_MS + offset, 6);
  });

  it('nothing when no state gives a deadline, or nothing places the host’s clock on this device’s', () => {
    expect(ownClockFrom([{ ...r0, deadline: null }], [pong], null, null, 106_000, SCOPE)).toBeNull();
    expect(ownClockFrom([{ ...r0, run: 'x' }], [], null, null, 106_000, SCOPE)).toBeNull();
  });
});

describe('the live run of states for the move owed (T17)', () => {
  it('over a played hand, its first state is the one the audit judges the move by (seatRun), at every move this seat makes', () =>
    scenario((i) => {
      const firsts: Array<{ tc: number; r0: SeenState | undefined }> = [];
      const rules = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
      const w: ReturnType<typeof wire> = wire({
        code: `OR${i}`,
        rules,
        botDelayMs: 700,
        // Now and then the seat waits out its turn clock (the table moves for it, or it moves in the bank).
        think: (k) => {
          const play = plays(w).find((p) => p.hand === w.c.state.view?.handNumber);
          const run = play ? ownRun(play, rules) : [];
          firsts.push({ tc: w.c.state.view!.turnCounter, r0: run[0] });
          return k % 5 === 0 ? 20_000 : k % 7 === 0 ? 50_000 : 600;
        },
      });
      w.finish();
      const audit = w.c.state.lastAudit;
      need(!!audit && firsts.length > 5);
      const play = plays(w).find((p) => p.hand === audit!.handNumber)!;
      let prev = -1;
      let checked = 0;
      for (const e of audit!.log) {
        if (e.seat !== 0) continue;
        const want = seatRun(play, e.n, prev).run[0];
        prev = e.n;
        const live = firsts.filter((f) => f.tc <= e.n).pop();
        if (!want || !live) continue;
        expect(live.r0).toBe(want);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
    }));
});

describe('the own clock at the table', () => {
  it('the state that starts the bank held 25 s (Normal, 15 + 30): 20 s into the turn the own clock is in the bank with about 24.5 s left (T18)', () =>
    scenario((i) => {
      // From the turn's first state on, the server holds every state for 25 s (the one that says the bank has
      // started among them); its pongs and clock frames go on as they are.
      let turnAt = -1;
      let turnTc = -1;
      let released = false;
      const w = wire({
        code: `OB${i}`,
        think: (_k, tc) => (tc === turnTc ? Infinity : 600),
        hold: (m, w) => turnTc >= 0 && m.t === 'state' && w.clock.now < turnAt + 25_000,
        onTick: (w) => {
          if (turnTc < 0 && w.discardTurn() && w.current() && w.c.state.view!.turnCounter > 4) {
            turnTc = w.c.state.view!.turnCounter;
            // When the table sent it (the phone shows it a step later).
            turnAt = w.created.get(turnTc) ?? w.clock.now;
          }
          if (turnTc >= 0 && !released && w.clock.now >= turnAt + 25_000) {
            released = true;
            w.line.release();
          }
        },
      });
      w.dealt();
      need(w.until(() => turnTc >= 0, 600_000));
      need(w.until(() => w.clock.now >= turnAt + 20_000, 30_000));
      // The phone still holds the turn's first state: the server says nothing of the bank.
      expect(w.c.state.inTimeBank).toBe(false);
      const o = w.c.ownClock()!;
      const now = w.c.clockNow();
      expect(now).toBeGreaterThan(o.turnEnd);
      expect((o.bankEnd - now) / 1000).toBeGreaterThan(23.5);
      expect((o.bankEnd - now) / 1000).toBeLessThan(25.5);
    }));

  it('a phone whose wall clock is a minute off from the table’s: the time left matches the table’s deadline to within the round trip (T19)', () =>
    scenario((i) => {
      for (const skew of [60_000, -60_000]) {
        const checks: Array<{ own: number; host: number }> = [];
        const w: ReturnType<typeof wire> = wire({
          code: `OS${skew}${i}`,
          devSkew: () => skew,
          // Half a second each way (the wire moves in half-second steps).
          delay: () => 500,
          up: () => 500,
          think: (k) => {
            const o = w.c.ownClock();
            const st = w.c.state;
            if (o && st.deadline !== null && !st.inTimeBank) checks.push({ own: o.turnEnd - w.c.clockNow(), host: st.deadline - (w.host as unknown as { now: () => number }).now() });
            return k % 4 === 0 ? 3_000 : 600;
          },
        });
        w.finish();
        need(checks.length > 3);
        // Read when the phone is first shown the move: within the round trip (1 s), never a minute off.
        for (const c of checks) expect(Math.abs(c.own - c.host)).toBeLessThanOrEqual(1_000 + 50);
      }
    }));

  it('null while the seat owes nothing; with no ping answered (a local table), placed by the deal, never later than the state’s own clock from its arrival', () =>
    scenario((i) => {
      // The bots take a second over each move, so the seat owes nothing now and then.
      const h = holdTurn({ code: `ON${i}`, watch: false, botDelayMs: 1_000 });
      need(h.w.toDiscard(2));
      const play = plays(h.w).find((p) => p.hand === h.w.c.state.view?.handNumber)!;
      expect((play.pongs ?? []).length).toBe(0);
      const o = h.w.c.ownClock()!;
      const r0 = ownRun(play, h.w.rules)[0];
      const own = (r0.atLo ?? r0.at) + (r0.deadline as number) - (r0.now as number);
      // The wire moves in half-second steps: the deal answered the share within one.
      expect(o.turnEnd).toBeLessThanOrEqual(own);
      expect(o.turnEnd).toBeGreaterThanOrEqual(own - 500);
      // Once the phone is shown a state in which the seat owes nothing.
      need(h.w.until(() => h.w.c.localState() !== null && !h.w.owes() && h.w.c.state.view!.turnCounter === h.w.host.game!.turnCounter, 20_000));
      expect(h.w.c.ownClock()).toBeNull();
    }));
});
