/**
 * The replay checks what the phone was told.
 *
 * At the end of a hand the phone replays the action log from the seed and holds the table to what it saw on the way:
 * each entry of the log is the move made at the turn the replay has reached, and says so (`LoggedAction.n`), since
 * every check of the seat's own moves is keyed by that number; and each view the phone was shown, which is what the
 * app shows and acts on, is the replayed state's view for the seat at that turn (`viewFor`), as the state hash the
 * host sends with it must be that state's. The hash covers tiles the seat may not see, so it says nothing of the view.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, viewToState, withRules, type Action, type GameState } from '@mjm/engine';
import { TableClient, type HostMessage } from '../src/index';
import type { PlayRecord } from '../src/clientrecords';
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

/**
 * Normal. Whenever the view the host sends the seat offers it a win (a claim on another seat's discard, or its own
 * draw), the server shows it without the win: the claim offer's `hu` set false, or the drawn tile's mark left out (a
 * self-drawn win needs it). Every other field, the state hash included, is the host's. The seat answers from the view
 * on show, as the app does, so it lets the win go.
 */
function hideWin(code: string, hide: boolean) {
  const offered = new Set<number>();
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 1_000,
    map: (m) => {
      if (m.t !== 'state') return m;
      const v = m.view;
      let win = false;
      try {
        win = legalActions(viewToState(v), 0).some((a) => a.type === 'hu');
      } catch {
        win = false;
      }
      if (!win) return m;
      offered.add(v.turnCounter);
      if (!hide) return m;
      const copy = JSON.parse(JSON.stringify(m)) as Extract<HostMessage, { t: 'state' }>;
      if (v.phase === 'claim') for (const o of copy.view.pending?.offers ?? []) (o as { hu?: boolean }).hu = false;
      else delete copy.view.lastDrawn;
      return copy;
    },
  });
  w.finish();
  const won = w.c.state.lastAudit?.log.some((e) => e.seat === 0 && e.action.type === 'hu') ?? false;
  return { w, offered, won };
}

describe('the views the seat was shown', () => {
  it('a win hidden from the seat’s view, with the true state hash: red, the view is not the replayed one; the same frames unchanged: the seat takes the win, green', () =>
    scenario((i) => {
      const a = hideWin(`RTV${i}`, true);
      need(a.offered.size > 0 && !a.won);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(['viewDiffers']);
      const b = hideWin(`RTV${i}`, false);
      need(b.offered.size > 0);
      expect(b.won).toBe(true);
      expect(b.w.verdict()).toMatchObject({ status: 'ok', failures: [] });
    }));

  it('keeps a digest of each view, saved with the record, and an app restart keeps holding the table to it', () =>
    scenario((i) => {
      const offered = new Set<number>();
      let restarted = false;
      const w = wire({
        code: `RTR${i}`,
        rules: NORMAL,
        botDelayMs: 700,
        think: () => 1_000,
        map: (m) => {
          if (m.t !== 'state') return m;
          let win = false;
          try {
            win = legalActions(viewToState(m.view), 0).some((a) => a.type === 'hu');
          } catch {
            win = false;
          }
          if (!win || m.view.phase === 'claim') return m;
          offered.add(m.view.turnCounter);
          const copy = JSON.parse(JSON.stringify(m)) as Extract<HostMessage, { t: 'state' }>;
          delete copy.view.lastDrawn;
          return copy;
        },
        onTick: (w) => {
          // Once the doctored view has gone by and the seat has moved on, the app restarts.
          if (!restarted && offered.size > 0 && w.host.game && w.host.game.turnCounter > Math.max(...offered) + 2) {
            restarted = true;
            w.restart();
          }
        },
      });
      w.finish();
      need(offered.size > 0 && restarted && !(w.c.state.lastAudit?.log.some((e) => e.seat === 0 && e.action.type === 'hu') ?? true));
      const seen = (w.c as unknown as { plays: PlayRecord[] }).plays.flatMap((p) => p.seen);
      expect(seen.every((f) => typeof f.view === 'string' && f.view.length === 32)).toBe(true);
      expect(w.verdict().status).toBe('failed');
      expect(w.verdict().failures).toEqual(['viewDiffers']);
      expect(w.c).toBeInstanceOf(TableClient);
    }), 30_000);
});
