/**
 * Boundaries a server can bring about do not turn the phone's measures off.
 *
 * A link the table never welcomes is measured as any other: while the phone holds a seat on a link that is up it
 * pings the table once a second and watches the link, whether or not a `welcome` came (an honest host welcomes a
 * link before it sends anything else on it).
 *
 * An app resume the server forces (by saying the seat was opened on another device) does not take the measure of the
 * turns shown before it: the answers to the pings of each run, its first pings and its pauses are saved with the
 * record, each with its run and a check figure, and a frame an earlier run saw is measured against them.
 */
import { describe, expect, it } from 'vitest';
import { withRules, type RuleSet } from '@mjm/engine';
import type { TableClient } from '../src/index';
import { lateBy, unanswered, type LateScope } from '../src/clientmoves';
import type { ClockAnchor, PlayRecord, SeenState } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const plays = (c: TableClient) => (c as unknown as { plays: PlayRecord[] }).plays;
const HYPER2 = withRules({ handsPerMatch: 2, turnSeconds: 4, timeBankSeconds: 0 });
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

/**
 * Hyper, two hands. The server drops the phone's link once in the first hand (3 s into the seat's first turn, as a
 * lost connection does), lets it back on a new link and sends it every frame but the `welcome` (`welcome` true: the
 * control, the welcome sent). From the second hand on it holds the state of each of the seat's turns `hold` ms (every
 * frame behind it waits too; honest stamps). The phone sends the ping the app sends right behind each join; the seat
 * moves `think` ms after it is shown its move.
 */
function neverWelcomed(code: string, welcome: boolean, hold: number, think: number) {
  let welcomes = 0;
  let dropped = false;
  let firstOwed: number | null = null;
  /** The wire, once made (the host sends frames while it is made). */
  let made: Wire | null = null;
  const w = wire({
    code,
    rules: HYPER2,
    botDelayMs: 700,
    fireClose: true,
    think: () => think,
    onReconnect: (w) => w.c.ping(),
    map: (m) => (m.t === 'welcome' && welcomes++ > 0 && !welcome ? null : m),
    delay: (m) => {
      const g = made?.host.game;
      if (!made || !g || g.handNumber < 1) return 0;
      return m.t === 'state' && made.owes() && g.turnCounter === m.view.turnCounter && m.view.handNumber === g.handNumber ? hold : 0;
    },
    onTick: (w) => {
      const g = w.host.game;
      if (dropped || !g || g.handNumber !== 0 || !w.owes() || w.host.phase !== 'playing') return;
      firstOwed ??= w.clock.now;
      if (w.clock.now >= firstOwed + 3_000) {
        dropped = true;
        w.dropNow(1_000);
      }
    },
  });
  made = w;
  for (let k = 0; k < 14_400 && !w.c.state.matchOver; k++) w.step();
  const second = w.c.state.audits.find((a) => a.audit.handNumber === 1);
  const taken = (second?.audit.log ?? []).filter((e) => e.seat === 0 && e.source !== 'player').length;
  // The pings the phone sent while the second hand was on show.
  const pings = plays(w.c).find((p) => p.hand === 1)?.pinged ?? 0;
  return { w, dropped, welcomes, pings, second, taken };
}

describe('a link the table never welcomes is measured as any other', () => {
  it('Hyper, the second hand’s turns held 3 s on a link the table never welcomed: the phone keeps pinging, and the hand is amber with the table’s moves on the held turns taken as late, never green; the same with the welcome sent', () =>
    scenario((i) => {
      const t = neverWelcomed(`NW${i}`, false, 3_000, 1_500);
      need(t.dropped && t.welcomes >= 2 && t.second !== undefined && t.taken > 0);
      expect(t.w.c.state.connected).toBe(false);
      expect(t.pings).toBeGreaterThan(5);
      expect(t.second!.status).toBe('partial');
      expect(t.second!.failures).toEqual([]);
      expect(t.second!.caveats).toContain('The table played for this seat on a turn that reached this device late, so it did not see that turn in time');
      const ctl = neverWelcomed(`NW${i}`, true, 3_000, 1_500);
      need(ctl.second !== undefined && ctl.taken > 0);
      expect(ctl.w.c.state.connected).toBe(true);
      expect(ctl.second!.status).toBe('partial');
    }));
});

/**
 * Once the seat has moved three times and owes nothing, the server holds the state of each of the seat's next `holds`
 * turns `hold` ms (every frame behind it waits too; honest stamps; every ping answered). Two seconds after the last
 * hold, with the seat owing nothing, it says the seat was opened on another device (`resume`): the link closes two
 * seconds later and the user resumes the table from Home five seconds after that (a new run of the app, welcomed, its
 * join ping sent). `resume` false: the same holds, no resume (the control). The seat moves `think` ms after it is shown
 * its move.
 */
function heldThenResumed(code: string, rules: RuleSet, resume: boolean, hold: number, think: number, holds = 3) {
  let from: number | null = null;
  let holdUntil: number | null = null;
  const held: number[] = [];
  let kickAt: number | null = null;
  let closeAt: number | null = null;
  let resumeAt: number | null = null;
  let resumed = false;
  const w = wire({
    code,
    rules,
    botDelayMs: 700,
    think: () => think,
    map: (m, w) => {
      const g = w.host.game;
      if (from === null || held.length >= holds || w.clock.now < from + 3_000 || (holdUntil !== null && w.clock.now < holdUntil)) return m;
      if (m.t === 'state' && g && w.owes() && g.turnCounter === m.view.turnCounter && typeof m.deadline === 'number' && !m.inTimeBank && typeof m.now === 'number' && m.deadline - m.now >= rules.turnSeconds * 1000 - 1_000) {
        held.push(m.view.turnCounter);
        holdUntil = w.clock.now + hold;
      }
      return m;
    },
    delay: (_m, now) => (holdUntil !== null && now < holdUntil ? holdUntil - now : 0),
    onTick: (w) => {
      const g = w.host.game;
      const now = w.clock.now;
      if (from === null && g && w.host.phase === 'playing' && !w.owes() && g.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length >= 3) from = now;
      if (resume && kickAt === null && held.length >= holds && holdUntil !== null && now >= holdUntil + 2_000 && g && w.host.phase === 'playing' && !w.owes()) {
        kickAt = now;
        w.line.inject({ t: 'disconnected' });
        closeAt = now + 2_000;
      }
      if (closeAt !== null && now >= closeAt) {
        closeAt = null;
        w.line.close();
        resumeAt = now + 5_000;
      }
      if (resumeAt !== null && now >= resumeAt) {
        resumeAt = null;
        w.restart();
        w.c.ping();
        resumed = true;
      }
    },
  });
  w.finish();
  return { w, held, resumed };
}

describe('turns shown late before an app resume the server forced stay late after it', () => {
  it('Normal, three turns held 10 s (every ping answered), then the seat “opened on another device” and the table resumed from Home: amber lateShown, never green; the same without the resume; green when the turns were not held', () =>
    scenario((i) => {
      const t = heldThenResumed(`HR${i}`, NORMAL, true, 10_000, 1_000);
      need(t.held.length === 3 && t.resumed && t.w.c.state.lastAudit !== null);
      expect(t.w.verdict().failures).toEqual([]);
      expect(t.w.verdict().status).toBe('partial');
      expect(t.w.verdict().caveats).toContain('lateShown');
      const ctl = heldThenResumed(`HR${i}`, NORMAL, false, 10_000, 1_000);
      need(ctl.held.length === 3);
      expect(ctl.w.verdict().status).toBe('partial');
      expect(ctl.w.verdict().caveats).toContain('lateShown');
      // An honest table that says the same (the seat opened elsewhere) after three turns it did not hold: green. The
      // turns before the resume are measured against that run's answers, not taken as late for want of them.
      const honest = heldThenResumed(`HR${i}`, NORMAL, true, 0, 1_000);
      need(honest.held.length === 3 && honest.resumed);
      expect(honest.w.verdict()).toEqual({ status: 'ok', failures: [], caveats: [] });
    }));
});

describe('a frame an earlier run of the app saw is measured in that run’s scope', () => {
  const pong = (run: string, at: number, now: number, fat: number): ClockAnchor => ({ at, now, era: 0, run, seg: 0, fat });
  /** Seen by the run `old`, 11 s after its stamp; the run's answer to a ping 10 s earlier puts the two clocks 50 ms apart. */
  const f: SeenState = { tc: 5, epoch: 1, era: 0, at: 60_000, atLo: 60_000, now: 49_000, run: 'old', seg: 0, onLink: true, owes: true, deadline: 64_000, timeBank: 0, inBank: false, hash: 'h' };
  const anchors = [pong('old', 50_000, 49_950, 50_100), pong('new', 10, 0, 20)];
  const judging = (earlier: LateScope['earlier']): LateScope => ({ run: 'new', best: null, pauses: [{ from: 55_000, to: 58_000 }], earlier });
  it('against that run’s fixed points and its own pauses, as that run measured it; not at all when nothing was kept of the run', () => {
    // 11 s less the 50 ms the answer allows, less its drift since (5 ms).
    expect(lateBy(f, anchors, judging([{ run: 'old', best: null, pauses: [] }]))).toBe(10_955);
    // The old run's pause in that span is left out; the judging run's pauses are not that run's.
    expect(lateBy(f, anchors, judging([{ run: 'old', best: null, pauses: [{ from: 55_000, to: 58_000 }] }]))).toBe(7_955);
    expect(lateBy(f, anchors, judging([]))).toBe(null);
    expect(lateBy(f, anchors, judging(undefined))).toBe(null);
    // Its first ping, 10 s before it arrived: unanswered only where the run is measured at all.
    const from = [{ era: 0, run: 'old', seg: 0, at: 50_000 }];
    expect(unanswered(f, from, 7_500, judging([{ run: 'old', best: null, pauses: [] }]))).toBe(true);
    expect(unanswered(f, from, 7_500, judging([]))).toBe(false);
  });
});
