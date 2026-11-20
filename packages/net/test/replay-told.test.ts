/**
 * The replay checks what the phone was told.
 *
 * At the end of a hand the phone replays the action log from the seed and holds the table to what it saw on the way:
 * each entry of the log is the move made at the turn the replay has reached, and says so (`LoggedAction.n`), since
 * every check of the seat's own moves is keyed by that number.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import type { HostMessage } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
/** The seat's own moves in the hand so far. */
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;

/**
 * Normal. On the seat's third discard turn, half a second after the phone was shown it (the seat moves 3 s in), the
 * host plays for the seat: `table`, its timeout rule's move, logged as the table's; `forge`, a discard the timeout rule
 * would not make, logged as the player's own. The log the hand's result carries then numbers that entry as the host
 * logged it (`keep`), -1 (`neg`) or null (`null`).
 */
function numbered(code: string, kind: 'table' | 'forge', label: 'keep' | 'neg' | 'null') {
  let target: { tc: number; at: number } | null = null;
  let played = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 3_000,
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing' || played) return;
      if (target === null && w.discardTurn() && w.current() && mine(w) >= 3) target = { tc: g.turnCounter, at: w.shown.get(g.turnCounter) ?? w.clock.now };
      if (target === null || g.turnCounter !== target.tc || w.clock.now < target.at + 500) return;
      const timeout = host(w).timeoutAction(g, 0);
      const move = kind === 'table' ? timeout : legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
      if (!move) return;
      host(w).apply(0, move, kind === 'table' ? 'timeout' : 'player');
      played = true;
    },
    map: (m) => {
      if (m.t !== 'hand_over' || target === null || !played || label === 'keep') return m;
      const copy = JSON.parse(JSON.stringify(m)) as Extract<HostMessage, { t: 'hand_over' }>;
      for (const e of copy.audit.log) if (e.seat === 0 && e.n === target.tc) (e as { n: unknown }).n = label === 'neg' ? -1 : null;
      return copy;
    },
  });
  w.finish();
  return { w, played };
}

describe('the turn number of each entry of the log', () => {
  it('a move the table made for the seat half a second into its turn, numbered -1 or null in the log: red, the log misnumbers it; numbered as made: red, played early', () =>
    scenario((i) => {
      for (const label of ['neg', 'null'] as const) {
        const a = numbered(`RTN${i}`, 'table', label);
        need(a.played);
        expect(a.w.verdict().status, label).toBe('failed');
        expect(a.w.verdict().failures, label).toEqual(expect.arrayContaining(['logTurn']));
      }
      const b = numbered(`RTN${i}`, 'table', 'keep');
      need(b.played);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('a move forged in the seat’s name, numbered -1: red, the log misnumbers it; numbered as made: red, a move the seat never made', () =>
    scenario((i) => {
      const a = numbered(`RTF${i}`, 'forge', 'neg');
      need(a.played);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['logTurn']));
      const b = numbered(`RTF${i}`, 'forge', 'keep');
      need(b.played);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
    }));

  it('an honest hand numbers every entry with its turn, and is green', () => {
    const w = wire({ code: 'RTH', rules: NORMAL, botDelayMs: 700 });
    w.finish();
    const log = w.c.state.lastAudit!.log;
    expect(log.every((e, k) => e.n === k)).toBe(true);
    expect(w.verdict()).toMatchObject({ status: 'ok', failures: [] });
  });
});

