/**
 * A turn held behind a welcome, with or without the answers to pings.
 *
 * An honest host answers a join in one step: the welcome, then whatever it has of a hand for the seat (a state, a result, a
 * deal under way), and only then the answer to the ping the app sends right behind its join. So, on a new link:
 * - an answer to a ping sent after the join that comes before any frame about a hand says the table had no hand under way;
 *   the first state of a hand this device had been shown on an earlier link, its turn 0 included, was held back;
 * - the first state of a later turn of such a hand that comes with no answer to a ping sent after the join before it was
 *   held back too when its own stamp, placed on this device's clock by the answers to the pings sent from the join on,
 *   is more than `LATE_MS` after the welcome came: an honest host stamps it as it sends it, right behind the welcome.
 * A move the table then makes for the seat fails the hand (`heldFrame`). Before, the rule needed a later turn than the
 * deal, and an answer to a ping between the welcome and the state: a server that held the deal's first turn, or held the
 * answers as well, played the seat's turns unseen. (A first cut timed the state by when it came: a network that stalled
 * right after the welcome made an honest table red.)
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

describe('an honest network that stalls right behind a rejoin welcome', () => {
  /**
   * Hyper-like (5 s turns, no bank). The app checks the link and pings each second, but its limit for a silent link has
   * grown past the stall (as after drops in a row), so it keeps the link (`watch: false`, `checkLink` here). Once the seat
   * has made two moves and owes nothing, the link drops for 3 s (`restart`: then the app restarts) and the phone joins
   * again, the table having moved on. The welcome comes at once; then the network toward the phone stalls for `LATE_MS + 5 s`, so the state
   * the table sent right behind the welcome, and every answer to a ping, come that much later, and the table times the
   * seat out meanwhile. The table is honest: its stamps say it sent the state right behind the welcome.
   */
  function stallAfterWelcome(code: string, restart: boolean) {
    let rejoined = false;
    let restartAt = Number.POSITIVE_INFINITY;
    let checkedAt = Number.NEGATIVE_INFINITY;
    let stallFrom: number | null = null;
    const STALL = LATE_MS + 5_000;
    const w = wire({
      code,
      rules: withRules({ handsPerMatch: 1, turnSeconds: 5, timeBankSeconds: 0 }),
      botDelayMs: 700,
      watch: false,
      think: () => 1_500,
      journal: restart,
      delay: (m, now) => {
        if (rejoined && stallFrom === null && m.t === 'welcome') {
          stallFrom = now;
          return 0;
        }
        return stallFrom !== null && now < stallFrom + STALL ? stallFrom + STALL - now : 0;
      },
      onTick: (w) => {
        const g = w.host.game;
        if (w.clock.now - checkedAt >= 1_000) {
          checkedAt = w.clock.now;
          w.c.checkLink();
        }
        if (w.clock.now >= restartAt) {
          restartAt = Number.POSITIVE_INFINITY;
          w.pendingReconnectAt = null;
          w.restart();
          return;
        }
        if (rejoined || !g || w.host.phase !== 'playing' || mine(w) < 2 || w.owes() || w.c.state.view?.turnCounter !== g.turnCounter) return;
        rejoined = true;
        w.dropNow(restart ? 600_000 : 3_000);
        if (restart) restartAt = w.clock.now + 3_000;
      },
    });
    w.finish();
    return { w, stalled: stallFrom !== null, tableMoved: w.judged().length > 0 };
  }

  it(`a ${LATE_MS / 1000 + 5} s stall after the welcome of a link that dropped, the table timing the seat out meanwhile: not red (it was red heldFrame)`, () =>
    scenario((i) => {
      const a = stallAfterWelcome(`HSD${i}`, false);
      need(a.stalled && a.tableMoved);
      expect(a.w.verdict().failures).toEqual([]);
    }));

  it('the same stall after the welcome of an app restart (with the journal): not red', () =>
    scenario((i) => {
      const a = stallAfterWelcome(`HSR${i}`, true);
      need(a.stalled && a.tableMoved);
      expect(a.w.verdict().failures).toEqual([]);
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
