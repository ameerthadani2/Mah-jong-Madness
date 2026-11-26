/**
 * A turn held behind a welcome, with or without the answers to pings.
 *
 * An honest host answers a join in one step: the welcome, then whatever it has of a hand for the seat (a state, a result, a
 * deal under way), and only then the answer to the ping the app sends right behind its join. So, on a new link:
 * - an answer to a ping sent after the join that comes before any frame about a hand says the table had no hand under way;
 *   the first state of a hand this device had been shown on an earlier link, its turn 0 included, was held back;
 * - the first state of a later turn of such a hand that comes more than `LATE_MS` after the welcome, with no answer to a
 *   ping sent after the join in between, was held back too: an honest host sends it right behind the welcome.
 * A move the table then makes for the seat fails the hand (`heldFrame`). Before, the rule needed a later turn than the
 * deal, and an answer to a ping between the welcome and the state: a server that held the deal's first turn, or held the
 * answers as well, played the seat's turns unseen.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import type { HostMessage } from '../src/index';
import { LATE_MS } from '../src/clientclock';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action; stateMsg(seat: number): HostMessage };
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;

/**
 * Normal. Once the seat has made two moves and owes nothing, the app restarts. On the new link the server welcomes it, then
 * holds every state and clock frame for `holdMs`, and with `noPong` every answer to a ping as well; with `forge`, half a
 * second into each discard the seat owes it plays one the seat would not make, as the player's own, else the table times the
 * seat out. Then it sends the table as it stands, and the answers it held. `delayMs`: no hold, but a link whose frames
 * from the table all come that late (an honest slow rejoin).
 */
function restartThenHold(code: string, opts: { journal: boolean; holdMs: number; noPong: boolean; forge: boolean; delayMs?: number }) {
  let restarted = false;
  let holding = false;
  let heldFrom = 0;
  let forged = 0;
  let owedInHold = false;
  let owedSince: { tc: number; at: number } | null = null;
  const pongs: HostMessage[] = [];
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: (_k, tc) => (restarted && holding ? Number.POSITIVE_INFINITY : tc >= 0 ? 3_000 : 3_000),
    journal: opts.journal,
    delay: () => (restarted && opts.delayMs ? opts.delayMs : 0),
    map: (m, w) => {
      if (!holding || w.line.id === 'p0') return m;
      if (m.t === 'state' || m.t === 'clock') return null;
      if (m.t === 'pong' && opts.noPong) {
        pongs.push(m);
        return null;
      }
      return m;
    },
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      if (!restarted) {
        if (mine(w) < 2 || w.owes() || w.c.state.view?.turnCounter !== g.turnCounter) return;
        restarted = true;
        holding = opts.holdMs > 0;
        heldFrom = w.clock.now;
        w.restart();
        return;
      }
      if (holding && w.owes()) owedInHold = true;
      if (holding && !w.owes() && w.clock.now - heldFrom >= opts.holdMs) {
        holding = false;
        w.line.inject(host(w).stateMsg(0));
        for (const p of pongs.splice(0)) w.line.inject(p);
        return;
      }
      if (!holding || !opts.forge || forged >= 2) return;
      if (!w.discardTurn()) {
        owedSince = null;
        return;
      }
      if (!owedSince || owedSince.tc !== g.turnCounter) owedSince = { tc: g.turnCounter, at: w.clock.now };
      if (w.clock.now - owedSince.at < 500) return;
      const timeout = host(w).timeoutAction(g, 0);
      const move = legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
      if (!move) return;
      host(w).apply(0, move, 'player');
      forged++;
    },
  });
  w.finish();
  return { w, restarted, forged, owedInHold, tableMoved: w.judged().length > 0 };
}

describe('after an app restart, the server holds the table back and every answer to a ping', () => {
  it(`a ${LATE_MS / 1000 + 3} s hold, moves written as the player's without the journal: red heldFrame (it was green)`, () =>
    scenario((i) => {
      const a = restartThenHold(`HWF${i}`, { journal: false, holdMs: LATE_MS + 3_000, noPong: true, forge: true });
      need(a.restarted && a.forged >= 1);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it(`the same hold, the table timing the seat out, with the journal: red heldFrame (it was amber, "while its connection was down")`, () =>
    scenario((i) => {
      const a = restartThenHold(`HWT${i}`, { journal: true, holdMs: LATE_MS + 3_000, noPong: true, forge: false });
      need(a.restarted && a.owedInHold && a.tableMoved);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it('control: the same hold with the pings answered: red heldFrame, as it was', () =>
    scenario((i) => {
      const a = restartThenHold(`HWP${i}`, { journal: true, holdMs: LATE_MS + 3_000, noPong: false, forge: false });
      need(a.restarted && a.owedInHold && a.tableMoved);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it('honest: a restart over a link whose frames from the table all come 10 s late (the welcome, the state and the answers together): nothing fails', () =>
    scenario((i) => {
      for (const journal of [false, true]) {
        const a = restartThenHold(`HWH${journal}${i}`, { journal, holdMs: 0, noPong: false, forge: false, delayMs: 10_000 });
        need(a.restarted);
        expect(a.w.verdict().failures).toEqual([]);
      }
    }));
});

describe('a deal’s first turn held behind a rejoin welcome', () => {
  /**
   * Normal, the seat deals (it owes the first discard) and never moves on it. Right after its phone is shown turn 0, the
   * link drops and the phone joins again 300 ms later. `drop`: on the new link the server drops every state for 5 s (the
   * state it owed right behind the welcome among them) while it answers the ping behind the join; the next state comes when
   * the seat's time bank starts. The table times the seat out of turn 0.
   */
  function turnZero(code: string, drop: boolean) {
    let cut = false;
    let rejoinedAt = Number.POSITIVE_INFINITY;
    const w = wire({
      code,
      rules: NORMAL,
      botDelayMs: 700,
      think: (_k, tc) => (tc === 0 ? Number.POSITIVE_INFINITY : 600),
      onReconnect: (w) => {
        rejoinedAt = w.clock.now;
      },
      map: (m, w) => (drop && w.line.id !== 'p0' && m.t === 'state' && w.clock.now - rejoinedAt < 5_000 ? null : m),
      onTick: (w) => {
        if (cut || w.c.state.view?.handNumber !== 0 || w.c.state.view.turnCounter !== 0) return;
        cut = true;
        w.dropNow(300);
      },
    });
    w.finish();
    return { w, cut, tableAt0: w.judged().includes(0) };
  }

  it('the state of turn 0 dropped, the ping behind the join answered: red heldFrame (it was green, the end verified)', () =>
    scenario((i) => {
      const a = turnZero(`HZ${i}`, true);
      need(a.cut && a.tableAt0);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
      expect(a.w.c.state.matchEndVerified).toBe(false);
    }));

  it('control: the same rejoin with the state right behind the welcome: nothing fails', () =>
    scenario((i) => {
      const a = turnZero(`HZC${i}`, false);
      need(a.cut && a.tableAt0);
      expect(a.w.verdict().failures).toEqual([]);
    }));
});
