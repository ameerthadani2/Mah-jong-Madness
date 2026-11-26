/**
 * The copy rule: which move this phone sent a move the log credits to its player is.
 *
 * An honest host takes a link's frames in the order they were sent. It answers each move by playing it, at the turn it
 * reached the table at if it is legal there, or by a refusal naming the turn it was made on; and a new link it seats the
 * player on ends the old one. So the move it played at a turn is the first move still unanswered on the link the seat
 * held then, that is the move the log shows, tile for tile. Not one a refusal answered in order, nor one sent before a
 * move of its link the log played earlier, nor one the table had taken up before that turn (it answered a ping sent
 * after it while the hand's state was at that turn or before). With no such move the entry is not the player's own.
 *
 * Before, a move the log credited to the player was matched to any unused move of the same kind made on that turn or
 * before, refused ones last, the latest link first. Two things came of it:
 * - a server dropped one of the player's passes (the table timed the window out with its own pass), later dropped a win
 *   or a claim, wrote a pass in the player's name there and cut the link: the forged pass was matched to the old pass,
 *   and the hand was green with the end of the match verified;
 * - on a connection grown slow toward the table, a late move the honest table played on a later turn was pinned on
 *   another copy of the same kind, and the in-order rule then failed an honest hand.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, withRules, type Action, type GameState } from '@mjm/engine';
import { caveatKey } from '../src/index';
import { runScenario } from './adversary/fuzz';
import type { Scenario } from './adversary/scenario';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 });
const CLAIMS: ReadonlySet<string> = new Set(['pong', 'chi', 'kong', 'hu']);
const apply = (w: Wire, seat: number, a: Action) => (w.host as unknown as { apply(seat: number, a: Action, source: string): void }).apply(seat, a, 'player');
const claimWindow = (g: GameState | null) => !!g && g.phase !== 'discard';

type Reserve = 'drop' | 'tap' | 'next';
type Mode = 'cut' | 'restart' | 'nocut' | 'cutauto';

/**
 * Normal. The reserve: at a claim window the server drops the seat's pass, and the table times the window out with its own
 * pass (`drop`); or the seat's app sends its pass twice at once, and the table plays the first and refuses the second
 * (`tap`); or as `drop`, with the claim the seat's next move after the pass (`next`: the table played no move of the link
 * in between, so only the table's answer to a ping sent after the pass shows it had taken the pass up long before).
 * Later in the same hand the seat makes a claim (a Pong, Chow, Kong or a win): the server drops it and writes a
 * pass in the seat's name there, then cuts the link (`cut`), or the app starts again from its record and journal
 * (`restart`), or nothing more (`nocut`). `cutauto`, the control: no pass is written; the link is cut at once and the table
 * times the claim out with its own pass (a move dropped with its connection, played over by the table: amber).
 */
function launder(code: string, reserve: Reserve, mode: Mode) {
  const st = { reserved: false, hand: -1, tc: -1, tap: false, target: -1, forged: false, acted: -1 };
  let ref: Wire | null = null;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    journal: true,
    // (`next`: the seat answers every claim window itself, below: a pass for the reserve, then the first claim it can make.)
    think: () => (reserve === 'next' && claimWindow(ref?.c.localState() ?? null) ? Number.POSITIVE_INFINITY : 600),
    upFilter: (m, w) => {
      if (m.t !== 'action') return true;
      const g = w.host.game;
      if (!g) return true;
      if (reserve === 'next' && st.reserved && st.target < 0 && !claimWindow(g)) {
        st.reserved = false;
        return true;
      }
      if (!claimWindow(g)) return true;
      if (!st.reserved && m.action.type === 'pass') {
        st.reserved = true;
        st.hand = g.handNumber;
        st.tc = m.turnCounter as number;
        if (reserve === 'tap') {
          st.tap = true;
          return true;
        }
        return false;
      }
      // (`next`: another move of the seat first, and the pass after it is the reserve.)
      if (reserve === 'next' && st.reserved && st.target < 0 && !CLAIMS.has(m.action.type)) {
        st.reserved = false;
        return true;
      }
      if (st.reserved && st.target < 0 && g.handNumber === st.hand && CLAIMS.has(m.action.type) && (m.turnCounter as number) > st.tc) {
        st.target = m.turnCounter as number;
        if (mode === 'cutauto') {
          st.forged = true;
          w.dropNow();
        }
        return false;
      }
      return true;
    },
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      // The second tap, on the same view (the frames the table sent since have not been handled yet).
      if (st.tap) {
        st.tap = false;
        w.c.act({ type: 'pass' });
      }
      // A reserve left unused when its hand ended is made again in the next.
      if (st.reserved && st.target < 0 && g.handNumber !== st.hand) st.reserved = false;
      const s = w.c.localState();
      if (reserve === 'next' && s && claimWindow(s) && w.current() && st.acted !== s.turnCounter && w.clock.now - (w.shown.get(s.turnCounter) ?? Infinity) >= 1_000) {
        const claim = legalActions(s, 0).find((a) => CLAIMS.has(a.type));
        st.acted = s.turnCounter;
        w.c.act(st.reserved && claim ? claim : { type: 'pass' });
      }
      if (st.target >= 0 && !st.forged && g.handNumber === st.hand && g.turnCounter === st.target && w.owes()) {
        st.forged = true;
        apply(w, 0, { type: 'pass' });
        if (mode === 'cut') w.dropNow();
        if (mode === 'restart') w.restart();
      }
    },
  });
  ref = w;
  w.dealt();
  for (let e = 0; e < 7_200_000 && w.host.phase !== 'match_over'; e += 500) w.step();
  for (let e = 0; e < 120_000 && !w.c.state.matchOver; e += 500) w.step();
  need(st.forged);
  const audit = w.c.state.audits.find((a) => a.audit.handNumber === st.hand);
  return { w, audit, hand: st.hand };
}

const keys = (audit: { status: string; failures: string[]; caveats: string[] } | undefined) => ({ status: audit?.status, failures: audit ? audit.failures : [], caveats: audit ? audit.caveats : [] });

describe('a dropped claim laundered through an earlier pass of the player', () => {
  it.each([
    ['drop', 'cut'],
    ['drop', 'restart'],
    ['tap', 'cut'],
    ['next', 'cut'],
    ['drop', 'nocut'],
  ] as const)('reserve %s, then the claim dropped, a pass written in the player’s name and %s: red, the pass is not the player’s (it was green with a cut or a restart)', (reserve, mode) =>
    scenario((i) => {
      const { w, audit } = launder(`CR${reserve}${mode}${i}`, reserve, mode);
      need(audit !== undefined);
      expect(audit?.status, JSON.stringify(keys(audit))).toBe('failed');
      // (`next`: the old pass is the only move of its kind the link had not answered, but the table had taken it up long
      // before; the log can be true only if the table held its frames back, and the hand fails for that.)
      expect(audit?.failures.some((f) => /changed a move this seat made|never made|left a move this seat sent unanswered|held back its frames/.test(f))).toBe(true);
      expect(w.c.state.matchEndVerified).toBe(false);
    }),
  );

  it('control: the claim dropped with its connection and the table’s own pass played over it, amber (a move in flight), as stated', () =>
    scenario((i) => {
      const { audit } = launder(`CRauto${i}`, 'drop', 'cutauto');
      need(audit !== undefined && audit.caveats.length > 0);
      expect(audit?.status).toBe('partial');
      expect(audit?.failures).toEqual([]);
      expect(audit?.caveats.some((c) => /in good time was still on its way/.test(c))).toBe(true);
    }));
});

describe('a connection that grows slow toward the table, with a second move sent when the first seems to go nowhere', () => {
  // Found by the fuzzer's long run: the honest table plays a late move on a later turn, and the phone pinned it on another
  // copy of the same kind (x472: a discard of tile 11 on the copy of tile 8; h1649: a late pass on a pass of a later turn).
  const cases: Array<[string, Scenario]> = [
    ['x472', { seed: 472, speed: 'hyper', hands: 5, othersPresent: false, botDelayMs: 300, player: { thinkMs: [600, 1500], retry: { kind: 'other', afterMs: 1500 }, readyMs: 3000 }, events: [{ at: { on: 'move', hand: 0, kind: 'pass', k: 1, ms: 1 }, do: { a: 'latency', ms: 6500, forMs: 40000 } }], hostOffsetMs: 86400000 } as Scenario],
    [
      'h1649',
      {
        seed: 1649,
        speed: 'hyper',
        hands: 2,
        othersPresent: false,
        botDelayMs: 300,
        player: { thinkMs: [600, 1500], retry: { kind: 'other', afterMs: 0 }, readyMs: 300 },
        events: [
          { at: { on: 'state', hand: 1, kind: 'claim', k: 2, ms: 0 }, do: { a: 'latency', ms: 9000, forMs: 40000 } },
          { at: { on: 'state', hand: 0, kind: 'own', k: 1, ms: 1 }, do: { a: 'resume', afterMs: 2000 } },
        ],
        hostOffsetMs: 3600000,
        wallOffsetMs: 3600000,
      } as Scenario,
    ],
  ];
  it.each(cases)('%s: no hand red (one was red with every late move left unanswered)', (_name, s) => {
    const o = runScenario(s);
    expect([...o.judgement.verdicts.values()].filter((v) => v.status === 'failed').map((v) => v.failures)).toEqual([]);
    expect(o.judgement.violations.map((v) => v.property)).not.toContain('falseRed');
  });
});

describe('a restored record that storage changed', () => {
  /**
   * Normal, with the app's journal. Once the seat has made three moves and owes nothing, the app restarts, and storage has
   * changed one digit of the saved record: the link of the state of an early turn (`epoch`, one restored without its check
   * figure, `kept: false`) or the turn a refusal named (refusals restored damaged, `movesKept: false`). The table is
   * honest. Before, the copy rule read link ends and refusals from such a record: a state whose link was moved on ended
   * the link the seat's moves went out on before they were played, and every one of them was "changed" (honest
   * battery, Relaxed, storage damage).
   */
  function damagedRestart(code: string, damage: 'frame' | 'refusal') {
    let restarted = false;
    let damaged = false;
    let refused = false;
    const w = wire({
      code,
      rules: withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 }),
      botDelayMs: 700,
      journal: true,
      think: () => 1_500,
      onTick: (w) => {
        const g = w.host.game;
        if (restarted || !g || w.host.phase !== 'playing') return;
        if (g.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length < 3 || w.owes() || w.c.state.view?.turnCounter !== g.turnCounter) return;
        restarted = true;
        w.restart((saved) => {
          const play = (saved as unknown as { plays: Array<{ hand: number; seen: Array<{ tc: number; epoch: number }>; sent: Array<{ tc: number; epoch: number }>; refusals?: Array<{ tc: number; at: number; epoch?: number }> }> }).plays.find((p) => p.hand === 0);
          if (!play) return saved;
          if (damage === 'frame') {
            const early = play.seen.find((f) => f.tc > 0 && f.tc < play.sent[play.sent.length - 1].tc);
            if (early) {
              early.epoch += 8;
              damaged = true;
            }
          } else {
            // A refusal of the seat's first move, as if the table had answered it so: storage wrote it where none was.
            const first = play.sent[0];
            (play.refusals ??= []).push({ tc: first.tc, at: first.tc, epoch: first.epoch });
            damaged = refused = true;
          }
          return saved;
        });
      },
    });
    w.finish();
    return { w, damaged, refused };
  }

  it('a saved state whose link storage changed (its check figure no longer matches): not red', () =>
    scenario((i) => {
      const a = damagedRestart(`CRD${i}`, 'frame');
      need(a.damaged);
      expect(a.w.verdict().failures).toEqual([]);
    }));

  it('a refusal storage wrote into the saved record (the moves’ check figure no longer matches): not red', () =>
    scenario((i) => {
      const a = damagedRestart(`CRR${i}`, 'refusal');
      need(a.damaged && a.refused);
      expect(a.w.verdict().failures).toEqual([]);
    }));
});

/**
 * Normal. At a claim window the seat passes, and the server keeps that pass from the table (`drop`: the table times the
 * window out with its own pass), or the seat's app sends its pass twice and the server lets the first through and keeps
 * the second from the table, never answering it (`tap`). From then on the server answers none of the seat's pings, so no
 * answer pins when the table took the kept pass up. At the next claim window of the hand where the seat could claim or
 * win, as soon as it opens and before any other move of the seat reached the table, the server writes a pass in the
 * seat's name there (unit 20h's check: green before).
 */
function heldPass(code: string, reserve: 'drop' | 'tap') {
  const st = { reserved: false, hand: -1, tc: -1, tap: false, idle: false, forged: false };
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    journal: true,
    think: () => 1_500,
    upFilter: (m, w) => {
      if (st.reserved && !st.forged && m.t === 'ping') return false;
      if (m.t !== 'action') return true;
      const g = w.host.game;
      if (!st.reserved && !st.forged && g && claimWindow(g) && m.action.type === 'pass') {
        Object.assign(st, { reserved: true, hand: g.handNumber, tc: m.turnCounter as number, idle: false });
        if (reserve === 'tap') {
          st.tap = true;
          return true;
        }
        return false;
      }
      // The second tap: kept from the table, never answered.
      if (reserve === 'tap' && st.reserved && !st.forged && m.action.type === 'pass' && m.turnCounter === st.tc) return false;
      // Another move of the seat reaches the table first: the attack needs none, so it starts again.
      if (st.reserved && !st.forged) st.reserved = false;
      return true;
    },
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      if (st.tap) {
        st.tap = false;
        w.c.act({ type: 'pass' });
      }
      if (!st.reserved || st.forged) return;
      // A reserve left unused when its hand ended is made again in the next.
      if (g.handNumber !== st.hand) {
        st.reserved = false;
        return;
      }
      // The window of the reserve is over once the seat is asked nothing.
      if (legalActions(g, 0).length === 0) st.idle = true;
      else if (st.idle && claimWindow(g) && legalActions(g, 0).some((a) => CLAIMS.has(a.type))) {
        st.forged = true;
        apply(w, 0, { type: 'pass' });
      }
    },
  });
  w.dealt();
  for (let e = 0; e < 7_200_000 && w.host.phase !== 'match_over'; e += 500) w.step();
  for (let e = 0; e < 120_000 && !w.c.state.matchOver; e += 500) w.step();
  need(st.forged);
  return w.c.state.audits.find((a) => a.audit.handNumber === st.hand);
}

describe('a pass the server kept back, written in the player’s name at a later claim window', () => {
  it.each(['drop', 'tap'] as const)(
    'reserve %s, pings unanswered after it: amber (a pass of a decision that had closed, where the seat could claim), never green',
    (reserve) =>
      scenario((i) => {
        const audit = heldPass(`HP${reserve}${i}`, reserve);
        need(audit !== undefined);
        expect(audit?.status, JSON.stringify(keys(audit))).not.toBe('ok');
        expect(audit?.caveats.some((c) => caveatKey(c) === 'lateCopy') || audit?.status === 'failed', JSON.stringify(keys(audit))).toBe(true);
      }),
    60_000,
  );
});
