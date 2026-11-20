/**
 * Frames that name a hand or a turn the phone is not on.
 *
 * The phone files what a frame says under the hand the frame names. An honest host names only the hand being played
 * or dealt, at the point where it sends each frame (`TableHost`): a clock frame names the turn whose state it last
 * sent the link; a deal's frames name the hand being dealt; a restart notice is a returning link's first word and
 * names the hand the restored table resumed (or the next one, before its deal); a refusal answers this seat's move in
 * the hand being played. A frame naming any other hand is the server's doing: it makes, changes and pushes out no
 * record, and the hand the phone is on fails.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, withRules, type Action, type GameState } from '@mjm/engine';
import type { HostMessage, TableClient } from '../src/index';
import type { PlayRecord } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const plays = (c: TableClient) => (c as unknown as { plays: PlayRecord[] }).plays;
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
/** The host's own move for a seat, as its clock running out would make it. */
const tableMove = (w: Wire) => {
  const h = w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
  h.apply(0, h.timeoutAction(w.host.game!, 0), 'timeout');
};
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;

/**
 * Normal. Once the seat has made three moves, the table plays its next turn (not a claim) for it 2 s after the phone
 * was shown it, long before its clock ran out. Once the seat has moved again and owes nothing, the server sends
 * `stray` clock frames, each for a hand never dealt (9001, 9002, ...), stamped long before every other frame of the
 * link: a frame stamped more than a second behind the link's latest is a frame held back, and was once filed under
 * the hand it names, making a record of it that pushed the hand on show out of the three the phone keeps.
 */
function earlyThenStray(code: string, stray: number) {
  let playedAt: number | null = null;
  let movesThen: number | null = null;
  let sent = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 5_000,
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      if (playedAt === null && w.current() && mine(w) >= 3 && g.phase !== 'claim' && w.clock.now - (w.shown.get(g.turnCounter) ?? Infinity) >= 2_000) {
        tableMove(w);
        playedAt = w.clock.now;
        movesThen = mine(w);
      }
      if (playedAt !== null && !sent && movesThen !== null && mine(w) >= movesThen + 1 && !w.owes()) {
        sent = true;
        for (let j = 1; j <= stray; j++) w.line.inject({ t: 'clock', now: 1, hand: 9000 + j, tc: 0 } as HostMessage);
      }
    },
  });
  w.finish();
  return { w, played: playedAt !== null, sent };
}

describe('clock frames for a hand the phone is not on', () => {
  it('Normal, the table plays the seat’s turn 2 s after it was shown, then three clock frames for hands never dealt, stamped long ago: red, with the early move named; no record of those hands is made; the same red without the frames', () =>
    scenario((i) => {
      const a = earlyThenStray(`SCE${i}`, 3);
      need(a.played && a.sent);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['playedEarly', 'strayFrame']));
      expect(plays(a.w.c).map((p) => p.hand)).not.toEqual(expect.arrayContaining([9001]));
      const b = earlyThenStray(`SCE${i}`, 0);
      need(b.played);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('a clock frame for an earlier turn of the hand than the phone was last shown, or for another hand, fails the hand; one for the turn it was shown does not', () =>
    scenario((i) => {
      const run = (frame: (w: Wire) => HostMessage | null) => {
        let sent = false;
        const w = wire({
          code: `SCT${i}`,
          rules: NORMAL,
          botDelayMs: 700,
          onTick: (w) => {
            const v = w.c.state.view;
            if (sent || !v || mine(w) < 2 || w.host.phase !== 'playing' || v.turnCounter !== w.host.game!.turnCounter) return;
            const m = frame(w);
            sent = true;
            if (m) w.line.inject(m);
          },
        });
        w.finish();
        need(sent);
        return w.verdict();
      };
      const now = (w: Wire) => (w.host as unknown as { stamp(): number }).stamp();
      const tc = (w: Wire) => w.c.state.view!.turnCounter;
      expect(run((w) => ({ t: 'clock', now: now(w), hand: 0, tc: tc(w) - 1 }) as HostMessage)).toMatchObject({ status: 'failed', failures: ['strayFrame'] });
      expect(run((w) => ({ t: 'clock', now: now(w), hand: 1, tc: tc(w) }) as HostMessage)).toMatchObject({ status: 'failed', failures: ['strayFrame'] });
      expect(run((w) => ({ t: 'clock', now: now(w), hand: 0, tc: tc(w) }) as HostMessage)).toEqual({ status: 'ok', failures: [], caveats: [] });
      expect(run(() => null)).toEqual({ status: 'ok', failures: [], caveats: [] });
    }));
});

/**
 * Normal. Once the seat has made three moves the app restarts, restored from a record whose last-made hand record is
 * another hand's (`other`; the order a server once brought about with one stray clock frame). Then the server refuses
 * the seat's next discard as illegal (it never reaches the table) though it is legal, and the seat, told so, discards
 * another tile, which the table plays.
 */
function refusedAfterRestart(code: string, other: boolean) {
  let armed = false;
  let refused: { tc: number; action: Action } | null = null;
  let retried = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 1_000,
    upFilter: (m, w) => {
      if (!armed || refused || m.t !== 'action' || m.action.type !== 'discard' || typeof m.turnCounter !== 'number') return true;
      refused = { tc: m.turnCounter, action: m.action };
      w.line.inject({ t: 'error', code: 'illegal', message: 'That move is not allowed now.', turnCounter: m.turnCounter } as HostMessage);
      return false;
    },
    onTick: (w) => {
      if (!refused || retried || w.c.state.lastErrorCode !== 'illegal') return;
      const s = w.c.localState();
      if (!s || s.turnCounter !== refused.tc) return;
      const first = JSON.stringify(refused.action);
      const another = legalActions(s, 0).find((a) => a.type === 'discard' && JSON.stringify(a) !== first);
      if (!another) return;
      retried = true;
      w.c.act(another);
    },
  });
  need(w.toDiscard(3));
  w.restart((saved) => {
    if (other) saved.plays.push({ hand: 9001, seen: [], sent: [], ledgerFrom: 2 } as never);
    return saved;
  });
  const ledgerAfterRestart = plays(w.c).find((p) => p.hand === 0)?.ledgerFrom;
  armed = true;
  w.finish();
  need(retried);
  return { w, ledgerAfterRestart };
}

describe('the hand a refusal, an app restart and the seat-taken notice are held against', () => {
  it('Normal, the app restarted from a record whose last-made hand record is another hand’s, then a legal discard refused: red legalMoveRefused, as without that record; the restored client vouches for the hand on show only from its next state', () =>
    scenario((i) => {
      const a = refusedAfterRestart(`SRF${i}`, true);
      expect(a.ledgerAfterRestart).toBe(Number.POSITIVE_INFINITY);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['legalMoveRefused']));
      const b = refusedAfterRestart(`SRF${i}`, false);
      expect(b.w.verdict().failures).toEqual(expect.arrayContaining(['legalMoveRefused']));
    }));

  it('the seat-taken notice stops the ledger of the hand on show, whichever record was made last', () =>
    scenario((i) => {
      const w = wire({ code: `SRK${i}`, rules: NORMAL, botDelayMs: 700 });
      need(w.toDiscard(3));
      w.restart((saved) => {
        saved.plays.push({ hand: 9001, seen: [], sent: [], ledgerFrom: 2 } as never);
        return saved;
      });
      need(w.until(() => typeof plays(w.c).find((p) => p.hand === 0)?.ledgerFrom === 'number' && Number.isFinite(plays(w.c).find((p) => p.hand === 0)!.ledgerFrom as number)));
      w.line.inject({ t: 'disconnected' } as HostMessage);
      expect(plays(w.c).find((p) => p.hand === 0)?.ledgerFrom).toBe(Number.POSITIVE_INFINITY);
    }));
});
