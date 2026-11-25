/**
 * Answers in order over a slow link, from an honest table.
 *
 * With frames taking seconds each way, a move often reaches the table after its turn is over: the table refuses it naming
 * its turn, or plays it on a later turn where it is legal (a discard of the same tile, a pass or a claim in a later
 * window), and refuses the copy the player made there. The audit holds the table to answering each link's moves in order
 * (`droppedBefore`), so it must read such a log as the honest table made it: of copies of a move sent over one link, the
 * first sent is the one played; a pass the table lost costs nothing; and a move of an earlier turn is judged only when the
 * link it went out on brought the state showing the later move played (an answer may be lost with a link that broke).
 */
import { describe, expect, it } from 'vitest';
import { legalActions, withRules, type Action } from '@mjm/engine';
import { failureKey } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

/** Turbo or Hyper, one match, every frame `ms` on its way each way (both directions), the seat moving 0.3 to 2 s in. */
function slowMatch(code: string, turnSeconds: number, timeBankSeconds: number, ms: number) {
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 2, turnSeconds, timeBankSeconds }),
    botDelayMs: 700,
    up: () => ms,
    delay: () => ms,
    think: (k) => 300 + ((k * 7919) % 1_700),
  });
  for (let k = 0; k < 40_000 && !w.c.state.matchOver; k++) w.step();
  const audits = w.c.state.audits;
  return { w, hands: audits.length, red: audits.filter((a) => a.status === 'failed').map((a) => ({ hand: a.audit.handNumber, failures: [...new Set(a.failures.map(failureKey))] })) };
}

describe('an honest table over a slow link', () => {
  it('8 s each way, Turbo and Hyper: no hand fails, whatever the table answered late or played late (some once did: a move it played on a later turn was taken for its copy, and an earlier move of the link for one it dropped)', () => {
    let hands = 0;
    const red: unknown[] = [];
    for (const [speed, turn, bank] of [['T', 7, 10], ['H', 4, 0]] as const) {
      for (let i = 0; i < 6; i++) {
        const r = slowMatch(`SL8${speed}${i}`, turn, bank, 8_000);
        hands += r.hands;
        red.push(...r.red.map((x) => ({ code: `SL8${speed}${i}`, ...x })));
      }
    }
    expect(hands).toBeGreaterThan(20);
    expect(red).toEqual([]);
  }, 120_000);
});

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const internals = (w: Wire) => w.host as unknown as { handle: (from: string, msg: unknown) => void };

/**
 * Turbo (7 s turns, 10 s bank). The seat's first claim (Pong, Kong or Chow) spends 20 s on its way up (what the phone
 * sends after it waits behind it): the table times the claim window out first, comes round to the seat's own next turn,
 * and when the claim comes it is no longer legal, so the table refuses it, naming its turn. The seat made its discard
 * there before the refusal reached it (it was shown that turn first), and the table plays it. `cut`: the link breaks with
 * the refusal and the state that shows the discard played still on their way; the phone joins again and is shown the
 * table there. An honest table and network either way: the refusal was lost with the link.
 */
function lostAnswer(code: string, cut: boolean) {
  const kinds = new Set(['pong', 'kong', 'chi']);
  let claim: { tc: number } | null = null;
  let slow = false;
  let refused = false;
  let cutDone = false;
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
  });
  const handle = internals(w).handle.bind(w.host);
  internals(w).handle = (from, msg) => {
    const m = msg as { t?: string; action?: Action; turnCounter?: number };
    const g = w.host.game;
    if (claim && !refused && m?.t === 'action' && m.turnCounter === claim.tc && g && !legalActions(g, 0).some((a) => a.type === m.action?.type)) refused = true;
    handle(from, msg);
    // The discard after the refused claim, played: the link breaks with what the table sent since on its way.
    if (cut && refused && !cutDone && m?.t === 'action' && m.action?.type === 'discard') {
      cutDone = true;
      w.dropNow(1_000);
    }
  };
  for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
  const a = w.c.state.audits.find((x) => x.audit.handNumber === 0);
  return { w, refused, cutDone, verdict: a ? { status: a.status, failures: [...new Set(a.failures.map(failureKey))] } : null };
}

describe('an answer lost with a link that broke', () => {
  it('a late claim refused, the seat’s discard played, and the link broken before either reached the phone: not red (the refusal may be lost with the link; it once failed the hand)', () =>
    scenario((i) => {
      const r = lostAnswer(`LA${i}`, true);
      need(r.refused && r.cutDone && r.verdict !== null);
      expect(r.verdict!.failures).toEqual([]);
    }, 60));

  it('control: the same over a link that stayed up: the refusal comes before the state showing the discard, and nothing fails', () =>
    scenario((i) => {
      const r = lostAnswer(`LAC${i}`, false);
      need(r.refused && r.verdict !== null);
      expect(r.verdict!.failures).toEqual([]);
    }, 60));
});
