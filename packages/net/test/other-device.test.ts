/**
 * Moves the server writes in the player's name while it says the seat is open on another device.
 *
 * A seat-taken notice (`disconnected`), or a welcome that says another device held the seat since this one's last link
 * (`welcome.elsewhere`), stops the phone: it sends nothing more until the player resumes the table from Home. From the
 * latest turn it had been shown until the first state it is shown once welcomed back, the seat was the other device's
 * (`PlayRecord.otherDevice`). A move the log credits to the player there that this phone did not send may have been made
 * on that device, so it does not fail the hand; but nothing vouches for it, so the hand is amber (`otherDevice`) and the
 * end of the match is not shown as verified. Before, such a move was green and the end verified.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { caveatKey, failureKey, TableClient, type HostMessage, type Link } from '../src/index';
import { cleanPlay, MAX_OTHER_DEVICE, openOtherDevice, otherDeviceAt, savedPlay, type PlayRecord } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
/** The seat's own moves in the hand so far. */
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0).length;
/** A legal discard of the seat's that the table's timeout rule would not make. */
const otherDiscard = (w: Wire): Action | undefined => {
  const g = w.host.game!;
  const timeout = host(w).timeoutAction(g, 0);
  return legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
};

/** The verdict on hand 0 (the match may run to more hands: a drawn hand keeps the dealer). */
const hand0 = (w: Wire) => {
  const a = w.c.state.audits.find((x) => x.audit.handNumber === 0);
  return a ? { status: a.status, failures: [...new Set(a.failures.map(failureKey))], caveats: a.caveats.map(caveatKey) } : null;
};

type Mode = 'after' | 'honest' | 'none' | 'elsewhere' | 'elsehonest' | 'dropforge';

/**
 * Normal. On the seat's third discard turn, half a second after the phone was shown it (the seat moves 3 s in):
 *   after      : the server says the seat was opened on another device, and 300 ms later plays a legal discard the seat
 *                would not make, written as the player's own; the player resumes from Home 3 s after the notice;
 *   honest     : the notice and the resume, nothing forged;
 *   none       : the forged move, no notice (control);
 *   elsewhere  : the server cuts the link, plays the forged move while it is down, and says in the welcome of the rejoin
 *                that another device held the seat; the player resumes from Home 3 s later;
 *   elsehonest : the same cut and welcome, nothing forged;
 *   dropforge  : the same cut and forged move, the rejoin welcomed as usual (control).
 * `journal`: the app keeps its journal of moves (`writeAhead`).
 */
function seatForge(code: string, mode: Mode, journal = false) {
  let at: { tc: number; shownAt: number } | null = null;
  let told = false;
  let forged = false;
  let cut = false;
  let tagged = false;
  let resumeAt: number | null = null;
  let resumed = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 3_000,
    fireClose: true,
    journal,
    map: (m) => {
      if ((mode === 'elsewhere' || mode === 'elsehonest') && m.t === 'welcome' && cut && !tagged) {
        tagged = true;
        resumeAt = w.clock.now + 3_000;
        return { ...m, elsewhere: true };
      }
      return m;
    },
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      const now = w.clock.now;
      if (resumeAt !== null && now >= resumeAt) {
        resumeAt = null;
        resumed = true;
        w.restart();
        return;
      }
      if (at === null) {
        if (w.discardTurn() && w.current() && mine(w) >= 2) at = { tc: g.turnCounter, shownAt: w.shown.get(g.turnCounter) ?? now };
        return;
      }
      const onIt = g.turnCounter === at.tc && w.owes();
      if (!onIt) return;
      const forge = () => {
        const move = otherDiscard(w);
        if (!move) return;
        forged = true;
        host(w).apply(0, move, 'player');
      };
      if ((mode === 'after' || mode === 'honest') && !told && now >= at.shownAt + 500) {
        told = true;
        w.line.inject({ t: 'disconnected' } as HostMessage);
        resumeAt = now + 3_000;
        return;
      }
      if (mode === 'after' && told && !forged && now >= at.shownAt + 800) return forge();
      if (mode === 'none' && !forged && now >= at.shownAt + 500) return forge();
      if ((mode === 'elsewhere' || mode === 'elsehonest' || mode === 'dropforge') && !cut && now >= at.shownAt + 500) {
        cut = true;
        w.dropNow(2_000);
        return;
      }
      if ((mode === 'elsewhere' || mode === 'dropforge') && cut && !forged && now >= at.shownAt + 800) forge();
    },
  });
  for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
  const attacked = mode === 'honest' || mode === 'elsehonest' ? resumed : forged && (mode === 'none' || mode === 'dropforge' || resumed);
  return { w, attacked, verified: w.c.state.matchEndVerified, over: w.c.state.matchOver };
}

describe('a seat the server says another device held', () => {
  it('a seat-taken notice, then a move written in the player’s name and a resume from Home: amber (otherDevice), the end not verified (it was green, the end verified)', () =>
    scenario((i) => {
      const r = seatForge(`OD${i}`, 'after');
      need(r.attacked && r.over);
      expect(hand0(r.w)!.status).toBe('partial');
      expect(hand0(r.w)!.caveats).toContain('otherDevice');
      expect(r.verified).toBe(false);
    }));

  it('a welcome that says another device held the seat, after a cut in which the move was written: amber (otherDevice), the end not verified', () =>
    scenario((i) => {
      const r = seatForge(`ODE${i}`, 'elsewhere');
      need(r.attacked && r.over);
      expect(hand0(r.w)!.status).toBe('partial');
      expect(hand0(r.w)!.caveats).toContain('otherDevice');
      expect(r.verified).toBe(false);
    }));

  it('the same with the app’s journal: amber (otherDevice), the end not verified', () =>
    scenario((i) => {
      for (const mode of ['after', 'elsewhere'] as const) {
        const r = seatForge(`ODJ${mode}${i}`, mode, true);
        need(r.attacked && r.over);
        expect(hand0(r.w)!.status).toBe('partial');
        expect(hand0(r.w)!.caveats).toContain('otherDevice');
        expect(r.verified).toBe(false);
      }
    }));

  it('honest: the notice or the welcome and a resume, nothing written for the seat: green, the end verified', () =>
    scenario((i) => {
      for (const mode of ['honest', 'elsehonest'] as const) {
        const r = seatForge(`ODH${mode}${i}`, mode);
        need(r.attacked && r.over);
        expect(hand0(r.w)!).toEqual({ status: 'ok', failures: [], caveats: [] });
        expect(r.verified).toBe(true);
      }
    }));

  it('controls: the same move with no notice, or after a cut with a plain welcome: red (a move the seat never made)', () =>
    scenario((i) => {
      for (const mode of ['none', 'dropforge'] as const) {
        const r = seatForge(`ODC${mode}${i}`, mode);
        need(r.attacked);
        expect(hand0(r.w)!.status).toBe('failed');
        expect(hand0(r.w)!.failures).toEqual(expect.arrayContaining(['moveInvented']));
      }
    }));

  it('honest: the seat’s own move on the turn the notice came, played by the table, is this device’s: no caveat', () =>
    scenario((i) => {
      // The notice arrives right behind the seat's move, before the state the move made: the stretch holds that turn.
      let told = false;
      let resumeAt: number | null = null;
      let resumed = false;
      const w = wire({
        code: `ODM${i}`,
        rules: NORMAL,
        botDelayMs: 700,
        think: () => 1_000,
        fireClose: true,
        before: (m, w) => {
          const g = w.host.game;
          if (told || m.t !== 'state' || !g || w.host.phase !== 'playing') return [];
          const last = g.actionLog[g.actionLog.length - 1];
          if (!last || last.seat !== 0 || last.source !== 'player' || g.actionLog.filter((e) => e.seat === 0).length < 3) return [];
          told = true;
          resumeAt = w.clock.now + 3_000;
          return [{ t: 'disconnected' } as HostMessage];
        },
        onTick: (w) => {
          if (resumeAt !== null && w.clock.now >= resumeAt) {
            resumeAt = null;
            resumed = true;
            w.restart();
          }
        },
      });
      for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
      need(resumed && w.c.state.matchOver);
      const play = (w.c as unknown as { plays: PlayRecord[] }).plays.find((p) => p.hand === 0);
      expect(play?.otherDevice?.length).toBe(1);
      expect(hand0(w)).toEqual({ status: 'ok', failures: [], caveats: [] });
      expect(w.c.state.matchEndVerified).toBe(true);
    }));
});

describe('the stretches the record keeps', () => {
  const nowhere = (): Link => ({ send: () => undefined, onMessage: () => () => undefined, close: () => undefined });

  it('a stretch opens at the latest turn shown when the server says so, and closes at the first state shown once welcomed back', () => {
    const r = seatForge('ODS', 'after');
    need(r.attacked);
    const play = (r.w.c as unknown as { plays: PlayRecord[] }).plays.find((p) => p.hand === 0)!;
    expect(play.otherDevice).toHaveLength(1);
    const [span] = play.otherDevice!;
    expect(span.to).toBeGreaterThan(span.from);
    const forged = r.w.c.state.lastAudit!.log.find((e) => e.seat === 0 && e.source === 'player' && e.n >= span.from && e.n < span.to!);
    expect(forged).toBeDefined();
  });

  it('saved and read back; one stored damaged is left out; past the cap the oldest become one, never dropped', () => {
    const c = new TableClient(nowhere(), 'Victim', undefined, {}, { now: () => 5_000_000 });
    const play = (c as unknown as { playFor(h: number): PlayRecord }).playFor(0);
    play.otherDevice = [{ from: 3, to: 7 }, { from: 9 }];
    const back = cleanPlay(JSON.parse(JSON.stringify(savedPlay(play))));
    expect(back.otherDevice).toEqual([{ from: 3, to: 7 }, { from: 9 }]);
    expect(otherDeviceAt(back, 3) && otherDeviceAt(back, 6) && !otherDeviceAt(back, 7) && otherDeviceAt(back, 40)).toBe(true);
    const damaged = cleanPlay({ ...JSON.parse(JSON.stringify(savedPlay(play))), otherDevice: [{ from: 5, to: 2 }, { from: 'x' }, { from: 1, to: 4 }] });
    expect(damaged.otherDevice).toEqual([{ from: 1, to: 4 }]);
    // An open stretch stays open: a second notice before the seat is shown the hand again adds none.
    expect(openOtherDevice([{ from: 4 }], 9)).toEqual([{ from: 4 }]);
    let spans = openOtherDevice(undefined, 0);
    for (let k = 1; k <= MAX_OTHER_DEVICE + 3; k++) {
      spans[spans.length - 1].to = 10 * k - 5;
      spans = openOtherDevice(spans, 10 * k);
    }
    expect(spans).toHaveLength(MAX_OTHER_DEVICE);
    // Every turn any stretch held is still held.
    for (let k = 0; k <= MAX_OTHER_DEVICE + 3; k++) expect(otherDeviceAt({ hand: 0, seen: [], sent: [], ledgerFrom: null, otherDevice: spans }, 10 * k)).toBe(true);
  });
});
