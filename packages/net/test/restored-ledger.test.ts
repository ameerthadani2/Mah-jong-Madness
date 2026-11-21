/**
 * The ledger of a hand still under way survives an app restart, or a resume of the table from Home, up to the latest
 * state the saved record holds.
 *
 * The record is written after the states it holds came, and every move is filed before it goes out, so every move this
 * device made before the latest of those states is in it: the record saves the stretch its ledger vouched for up to
 * there (`vouchedThrough`), and a client restored from it holds the log to its moves over that stretch. A move credited
 * to the player at or after that state's turn, before the restored app is shown the table again, is not checked: it may be
 * one the app sent after its last save (the stated limit).
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import type { SerializedClient } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;

/**
 * Normal. Half a second into the seat's third discard turn (it moves 3 s in), the server plays a legal discard the seat
 * would not make, written down as the player's own. Then the app restarts from the record it saved (`restart`): `after`,
 * once the phone has been shown two turns after the forged one; `at`, before any later state reached it; `never`, not at
 * all (the control). `edit` changes the saved record first.
 */
function forgedThenRestart(code: string, when: 'after' | 'at' | 'never', edit?: (saved: SerializedClient) => SerializedClient) {
  let forged: { tc: number } | null = null;
  let restarted = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 3_000,
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      if (forged === null) {
        if (!w.discardTurn() || !w.current() || mine(w) < 2 || w.clock.now - (w.shown.get(g.turnCounter) ?? Infinity) < 500) return;
        const timeout = host(w).timeoutAction(g, 0);
        const move = legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
        if (!move) return;
        forged = { tc: g.turnCounter };
        host(w).apply(0, move, 'player');
        if (when === 'at') {
          restarted = true;
          w.restart(edit);
        }
        return;
      }
      if (when !== 'after' || restarted) return;
      const shown = w.c.state.view?.turnCounter ?? -1;
      if (shown >= forged.tc + 2 && !w.owes()) {
        restarted = true;
        w.restart(edit);
      }
    },
  });
  w.finish();
  const entry = forged ? w.c.state.lastAudit?.log.find((e) => e.seat === 0 && e.n === forged!.tc) : undefined;
  return { w, forged: !!entry && entry.source === 'player', restarted: restarted || when === 'never' };
}

describe('a move forged in the player’s name, then an app restart', () => {
  it('restarted once the phone was shown the turns after it: red, a move the seat never made (it was once green)', () =>
    scenario((i) => {
      const a = forgedThenRestart(`RLA${i}`, 'after');
      need(a.forged && a.restarted);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
    }));

  it('control: no restart, red as it always was', () =>
    scenario((i) => {
      const a = forgedThenRestart(`RLN${i}`, 'never');
      need(a.forged);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
    }));

  it('the stated limit: restarted before any state after the forged move reached the phone, the move is not checked (it may be one the app sent after its last save)', () =>
    scenario((i) => {
      const a = forgedThenRestart(`RLT${i}`, 'at');
      need(a.forged && a.restarted);
      expect(a.w.verdict().failures).not.toEqual(expect.arrayContaining(['moveInvented']));
    }));

  it('a record whose saved moves storage changed keeps no stretch, so the forged move is not held against the table (damaged storage never fails a hand)', () =>
    scenario((i) => {
      const a = forgedThenRestart(`RLD${i}`, 'after', (saved) => {
        const play = saved.plays[saved.plays.length - 1];
        if (play.sent[0]) play.sent[0] = { ...play.sent[0], tc: play.sent[0].tc + 1 };
        return saved;
      });
      need(a.forged && a.restarted);
      expect(a.w.verdict().failures).not.toEqual(expect.arrayContaining(['moveInvented']));
    }));
});
