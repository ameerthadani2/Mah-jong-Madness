/**
 * No cap on what the phone keeps may give up evidence that disagrees.
 *
 * An honest host sends one turn's state with one hash and exactly the view of that state for the seat, so a second copy
 * of a turn that shows another view fails the hand when it comes (`twoStates`), as one with another hash does. And the
 * record of a hand, kept to `MAX_SEEN` states, gives up first a copy that adds nothing the checks read: never a turn's
 * first copy on a link, its latest, or the copy that claimed the latest end, while such a copy is left, and never a view
 * or hash no other kept state shows while anything else is left (`keepSeen`).
 */
import { describe, expect, it } from 'vitest';
import { legalActions, viewToState, withRules } from '@mjm/engine';
import type { HostMessage } from '../src/index';
import { keepSeen, MAX_SEEN, type PlayRecord, type SeenState } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

/** A state of turn `tc` as the record keeps it. */
const frame = (tc: number, extra: Partial<SeenState> = {}): SeenState => ({ tc, epoch: 1, era: 0, at: 1_000 + tc, now: 900 + tc, owes: false, deadline: null, timeBank: 30, inBank: false, hash: `h${tc}`, view: `v${tc}`, ...extra });
const record = (seen: SeenState[]): PlayRecord => ({ hand: 0, seen, sent: [], ledgerFrom: 0 });

describe('the record of a hand that runs over', () => {
  it('a copy that shows another view between two true copies of its turn is never the one given up (it once was the first to go)', () => {
    const doctored = frame(5, { view: 'doctored' });
    const play = record([frame(4), frame(5), doctored, ...Array.from({ length: MAX_SEEN - 2 }, () => frame(5))]);
    expect(play.seen.length).toBe(MAX_SEEN + 1);
    keepSeen(play);
    expect(play.seen.length).toBe(MAX_SEEN);
    expect(play.overflow).toBe(true);
    expect(play.seen).toContain(doctored);
    expect(play.seen[0].tc).toBe(4);
  });

  it('a turn’s first copy, its latest and the copy that claimed the latest end stay while copies that add nothing go', () => {
    const head = frame(5, { owes: true, deadline: 20_000, at: 1 });
    const later = frame(5, { owes: true, deadline: 90_000, at: 2 });
    const tail = frame(5, { owes: true, deadline: 20_000, at: 3 });
    const fill = Array.from({ length: MAX_SEEN - 2 }, (_, k) => frame(5, { owes: true, deadline: 20_000, at: 10 + k }));
    const play = record([head, later, ...fill, tail]);
    for (let k = 0; k < 50; k++) {
      play.seen.push(frame(5, { owes: true, deadline: 20_000, at: 5_000 + k }));
      keepSeen(play);
    }
    expect(play.seen.length).toBe(MAX_SEEN);
    expect(play.seen[0]).toBe(head);
    expect(play.seen).toContain(later);
  });

  it('with no copy to spare, the oldest state whose view another state also shows goes before a view shown once', () => {
    // 601 states, each the first and latest of its turn on its link: one view per turn shown twice (two links), turn 0 once.
    const once = frame(0, { epoch: 9 });
    const seen = [once];
    for (let tc = 1; seen.length <= MAX_SEEN; tc++) for (const epoch of [1, 2]) if (seen.length <= MAX_SEEN) seen.push(frame(tc, { epoch }));
    const play = record(seen);
    keepSeen(play);
    expect(play.seen).toContain(once);
    expect(play.seen.length).toBe(MAX_SEEN);
  });
});

/**
 * Normal, four hands. Whenever the host's state offers the seat a win, the server sends that state and at once a copy of
 * it with the win left out of the view, the host's hash kept (`doctor`); the seat answers from the copy on show. As its
 * answer goes out, the server sends the true state again and 600 more copies of it (`flood`), before the host's next
 * state. Reported: the verdicts of the hands in which a win was hidden and not taken.
 */
function hideFlood(code: string, doctor: boolean, flood: boolean) {
  const offered = new Map<number, Extract<HostMessage, { t: 'state' }>>();
  const done = new Set<string>();
  let floods = 0;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 }),
    botDelayMs: 700,
    think: () => 1_000,
    intermissionSeconds: 5,
    after: (m) => {
      if (m.t !== 'state' || done.has(`${m.view.handNumber}:${m.view.turnCounter}`)) return [];
      let win = false;
      try {
        win = legalActions(viewToState(m.view), 0).some((a) => a.type === 'hu');
      } catch {
        win = false;
      }
      if (!win) return [];
      done.add(`${m.view.handNumber}:${m.view.turnCounter}`);
      offered.set(m.view.handNumber, m);
      if (!doctor) return [];
      const copy = JSON.parse(JSON.stringify(m)) as Extract<HostMessage, { t: 'state' }>;
      if (copy.view.phase === 'claim') for (const o of copy.view.pending?.offers ?? []) (o as { hu?: boolean }).hu = false;
      else delete copy.view.lastDrawn;
      return [copy];
    },
    upFilter: (m, w) => {
      const g = w.host.game;
      const shown = g ? offered.get(g.handNumber) : undefined;
      if (!flood || m.t !== 'action' || !shown || m.turnCounter !== shown.view.turnCounter || done.has(`flood:${g!.handNumber}`)) return true;
      done.add(`flood:${g!.handNumber}`);
      for (let k = 0; k <= MAX_SEEN; k++) w.line.inject(shown);
      floods++;
      return true;
    },
  });
  for (let e = 0; e < 7_200_000 && !w.c.state.matchOver; e += 500) w.step();
  const lost = [...offered.keys()].filter((h) => !w.host.audits.find((a) => a.handNumber === h)?.log.some((e) => e.seat === 0 && e.action.type === 'hu'));
  const verdicts = lost.map((h) => w.c.state.audits.find((a) => a.audit.handNumber === h));
  return { w, verdicts, floods };
}

describe('a doctored view under a flood of true copies', () => {
  it('the win hidden in a copy between true ones, then 601 true copies: red when the copy comes, and its view still held to the replay (it was once amber)', () =>
    scenario((i) => {
      const a = hideFlood(`KSF${i}`, true, true);
      need(a.verdicts.length > 0 && a.floods > 0);
      for (const v of a.verdicts) {
        expect(v?.status).toBe('failed');
        expect(v?.failures.some((f) => f.startsWith('Host showed two different states for turn'))).toBe(true);
        expect(v?.failures.some((f) => f.startsWith('The view of the table this seat was shown at turn'))).toBe(true);
      }
    }));

  it('controls: the doctored copy without the flood, red; the flood alone, amber (the record ran over); nothing, green', () =>
    scenario((i) => {
      const a = hideFlood(`KSC${i}`, true, false);
      need(a.verdicts.length > 0);
      for (const v of a.verdicts) expect(v?.status).toBe('failed');
      const b = hideFlood(`KSC${i}`, false, true);
      need(b.floods > 0);
      expect(b.w.c.state.audits.some((x) => x.status === 'partial' && x.caveats.some((c) => c.startsWith('The table sent this device far more states')))).toBe(true);
      expect(b.w.c.state.audits.every((x) => x.status !== 'failed')).toBe(true);
      const c = hideFlood(`KSC${i}`, false, false);
      expect(c.w.c.state.audits.every((x) => x.status === 'ok')).toBe(true);
    }), 60_000);
});
