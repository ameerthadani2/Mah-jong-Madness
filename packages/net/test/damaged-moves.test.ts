/**
 * A record whose moves or refusals storage changed never fails a hand.
 *
 * The checks of the table's answers (a legal move refused, a move left unanswered while a later one of its link was
 * played, a move ignored) rest on the moves this seat sent and the refusals the table sent back, as the record holds them.
 * Since unit 20g a refusal is filed with the link and run of the app it came on, and a move of any earlier turn is held
 * to an answer, so a digit storage changed in either could fail an honest hand after an app restart (a refusal moved to
 * another link answers nothing). Every saved hand record now carries a check figure for them (`movesSum`): read back
 * with a figure that does not match, those checks make the hand amber (`damaged`) instead, through later restarts too.
 * A record an earlier build saved has no figure and is read as before.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, withRules, type Action } from '@mjm/engine';
import { caveatKey, failureKey, type SerializedClient } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const internals = (w: Wire) => w.host as unknown as { handle: (from: string, msg: unknown) => void };
type Saved = Record<string, unknown> & { sent: Array<Record<string, unknown>>; refusals?: Array<Record<string, unknown>> };
const playsOf = (d: SerializedClient) => d.plays as unknown as Saved[];

/**
 * Turbo (7 s turns, 10 s bank), one hand. The seat's first claim spends 20 s on its way up: the table times the claim
 * window out, comes round to the seat's own turn and, when the claim comes, refuses it, naming its turn (an honest
 * table). The seat's discard there is played. Once the phone has been shown the state after it, the app restarts from
 * its record (`edit` changes the saved copy first; `again`: it restarts once more, from the record the restored app
 * wrote). `drop`: the table sends no refusal (it lost the claim: a dishonest table).
 */
function restoredAfterRefusal(code: string, edit: (d: SerializedClient) => SerializedClient, opts: { again?: boolean; drop?: boolean } = {}) {
  const kinds = new Set(['pong', 'kong', 'chi']);
  let claim: { tc: number } | null = null;
  let slow = false;
  let refused = false;
  let discardTc: number | null = null;
  let restarts = 0;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 1, turnSeconds: 7, timeBankSeconds: 10 }),
    botDelayMs: 700,
    think: () => 600,
    upFilter: (m) => {
      if (!claim && m.t === 'action' && kinds.has(m.action.type) && typeof m.turnCounter === 'number') {
        claim = { tc: m.turnCounter };
        slow = true;
      }
      return true;
    },
    up: () => {
      if (!slow) return 0;
      slow = false;
      return 20_000;
    },
    map: (m) => (opts.drop && m.t === 'error' && claim && m.turnCounter === claim.tc ? null : m),
    onTick: (w) => {
      if (discardTc === null || restarts >= (opts.again ? 2 : 1)) return;
      const shown = playsOf(w.c.serialize()).some((p) => (p.seen as Array<{ tc: number }>).some((f) => f.tc > (discardTc as number) + restarts * 2));
      if (!shown) return;
      w.restart(restarts === 0 ? edit : undefined);
      restarts++;
    },
  });
  const handle = internals(w).handle.bind(w.host);
  internals(w).handle = (from, msg) => {
    const m = msg as { t?: string; action?: Action; turnCounter?: number };
    const g = w.host.game;
    if (claim && !refused && m?.t === 'action' && m.turnCounter === claim.tc && g && !legalActions(g, 0).some((a) => a.type === m.action?.type)) refused = true;
    handle(from, msg);
    if (refused && discardTc === null && m?.t === 'action' && m.action?.type === 'discard' && typeof m.turnCounter === 'number') discardTc = m.turnCounter;
  };
  for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
  const a = w.c.state.audits.find((x) => x.audit.handNumber === 0);
  return { refused, restarts, verdict: a ? { status: a.status, failures: [...new Set(a.failures.map(failureKey))], caveats: a.caveats.map(caveatKey) } : null };
}

/** The saved copy with `f` applied to each refusal (or each refused move) of every hand. */
const refusalsEdited = (f: (r: Record<string, unknown>) => Record<string, unknown>) => (d: SerializedClient): SerializedClient => {
  for (const p of playsOf(d)) if (Array.isArray(p.refusals)) p.refusals = p.refusals.map(f);
  return d;
};
/** One digit changed: a number moved by 3. */
const moved = (n: unknown) => (typeof n === 'number' ? n + 3 : n);
/** As an earlier build saved it: no check figure for the moves and refusals. */
const noFigure = (d: SerializedClient): SerializedClient => {
  for (const p of playsOf(d)) delete p.movesSum;
  return d;
};

describe('a record whose moves or refusals storage changed', () => {
  it('a refusal’s link changed: never red, amber (damaged) (it failed the hand: the claim read as left unanswered)', () =>
    scenario((i) => {
      const r = restoredAfterRefusal(`DMA${i}`, refusalsEdited((x) => ({ ...x, epoch: moved(x.epoch) })));
      need(r.refused && r.restarts === 1 && r.verdict !== null);
      expect(r.verdict!.failures).toEqual([]);
      expect(r.verdict!.caveats).toContain('damaged');
    }));

  it('a refusal’s turn changed: the same (it failed the hand: a legal move refused, the claim left unanswered)', () =>
    scenario((i) => {
      const r = restoredAfterRefusal(`DMB${i}`, refusalsEdited((x) => ({ ...x, tc: moved(x.tc) })));
      need(r.refused && r.restarts === 1 && r.verdict !== null);
      expect(r.verdict!.failures).toEqual([]);
      expect(r.verdict!.caveats).toContain('damaged');
    }));

  it('restarted again from the record the restored app wrote: still amber, not red (the figure it saves is not one over the changed copy)', () =>
    scenario((i) => {
      const r = restoredAfterRefusal(`DMD${i}`, refusalsEdited((x) => ({ ...x, epoch: moved(x.epoch) })), { again: true });
      need(r.refused && r.restarts === 2 && r.verdict !== null);
      expect(r.verdict!.failures).toEqual([]);
      expect(r.verdict!.caveats).toContain('damaged');
    }));

  it('control: the record as saved: its figure matches, nothing is damaged, nothing fails', () =>
    scenario((i) => {
      const r = restoredAfterRefusal(`DME${i}`, (d) => d);
      need(r.refused && r.restarts === 1 && r.verdict !== null);
      expect(r.verdict!.failures).toEqual([]);
      expect(r.verdict!.caveats).not.toContain('damaged');
    }));

  it('control: a record an earlier build saved (no figure) is read as before: nothing damaged, nothing fails', () =>
    scenario((i) => {
      const r = restoredAfterRefusal(`DMF${i}`, noFigure);
      need(r.refused && r.restarts === 1 && r.verdict !== null);
      expect(r.verdict!.failures).toEqual([]);
      expect(r.verdict!.caveats).not.toContain('damaged');
    }));

  it('a table that lost the claim (no refusal) is still caught after the restart, with or without a figure: red', () =>
    scenario((i) => {
      const r = restoredAfterRefusal(`DMG${i}`, (d) => d, { drop: true });
      need(r.refused && r.restarts === 1 && r.verdict !== null);
      expect(r.verdict!.failures).toEqual(expect.arrayContaining(['moveDropped']));
      const o = restoredAfterRefusal(`DMG${i}`, noFigure, { drop: true });
      need(o.refused && o.restarts === 1 && o.verdict !== null);
      expect(o.verdict!.failures).toEqual(expect.arrayContaining(['moveDropped']));
    }));
});
