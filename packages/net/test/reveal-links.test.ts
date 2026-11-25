/**
 * A share that went out on more than one link.
 *
 * Every link the phone's share went out on counts as up before the deal (`upBeforeDeal`, `AttemptRecord.revealedOn`): on
 * such a link the hand's first frame must be its deal's state. Before, only the first reveal's link did, so a hand whose
 * share was asked for again on a new link, and then withheld there, was judged as a dropped connection (amber) instead of
 * held back (red).
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { caveatKey, failureKey } from '../src/index';
import { cleanCeremony, MAX_REVEAL_LINKS, sharedOn } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
/** The verdict on hand `h`. */
const verdictOf = (w: Wire, h: number) => {
  const a = w.c.state.audits.find((x) => x.audit.handNumber === h);
  return a ? { status: a.status, failures: [...new Set(a.failures.map(failureKey))], caveats: a.caveats.map(caveatKey) } : null;
};

/**
 * Normal, one hand. The phone's share for hand 0 goes out on link 0, where the server drops it, and the phone's side of
 * the link is cut at once (the host still holds it, half-open). On link 1 the host asks again (commits and
 * reveal_request, as `TableHost.onJoin` does for a seat whose share never came), and the phone sends its share there.
 * The deal follows. `withhold`: every state and clock frame of the hand on link 1 is withheld (and the answers to the
 * phone's pings, so the rule for a state that comes after one is out of play), the table times the seat out, and its
 * result is the hand's first frame there.
 */
function cutReveal(code: string, withhold: boolean) {
  let cut = false;
  let reconnectAt: number | null = null;
  let onNew = false;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 }),
    botDelayMs: 700,
    think: () => 1_000,
    watch: false,
    upFilter: (m) => {
      if (m.t !== 'reveal' || cut) return true;
      cut = true;
      reconnectAt = w.clock.now + 1_000;
      return false;
    },
    map: (m) => {
      if (!onNew || !withhold) return m;
      if (m.t === 'pong') return null;
      const h = m.t === 'state' ? m.view.handNumber : m.t === 'clock' ? m.hand : null;
      return h === 0 ? null : m;
    },
    onTick: (w) => {
      if (reconnectAt !== null && w.clock.now >= reconnectAt) {
        reconnectAt = null;
        onNew = true;
        // The phone's side of link 0 is gone (the host's is not): it joins again on a new link.
        w.reconnect();
      }
    },
  });
  w.finish();
  const revealedOn = (w.c as unknown as { records: Array<{ hand: number; attempts: Array<{ revealedEpoch?: number; revealedOn?: number[] }> }> }).records.find((r) => r.hand === 0)?.attempts.flatMap((a) => [a.revealedEpoch, ...(a.revealedOn ?? [])]);
  return { w, cut, onNew, revealedOn };
}

describe('a share that went out on two links', () => {
  it('asked again on a new link and sent there, then the hand withheld on it: red (held back; it was amber, as a dropped connection)', () =>
    scenario((i) => {
      const r = cutReveal(`CRV${i}`, true);
      need(r.cut && r.onNew && (r.revealedOn?.length ?? 0) >= 2 && verdictOf(r.w, 0) !== null);
      expect(verdictOf(r.w, 0)?.status).toBe('failed');
      expect(verdictOf(r.w, 0)?.failures).toEqual(expect.arrayContaining(['heldFrame']));
    }));

  it('control: the same links, nothing withheld: not red', () =>
    scenario((i) => {
      const r = cutReveal(`CRH${i}`, false);
      need(r.cut && r.onNew && (r.revealedOn?.length ?? 0) >= 2 && verdictOf(r.w, 0) !== null);
      expect(verdictOf(r.w, 0)?.failures).toEqual([]);
    }));
});

describe('the links an attempt’s share went out on, as the record keeps them', () => {
  it('read back as whole link numbers, at most MAX_REVEAL_LINKS of them; one stored damaged is left out', () => {
    const many = Array.from({ length: MAX_REVEAL_LINKS + 3 }, (_, k) => k + 1);
    const rec = cleanCeremony({ hand: 0, attempts: [{ n: 1, committed: true, revealed: true, stoodIn: false, revealedEpoch: 0, revealedOn: [1, 'x', 2.5, 3] }, { n: 2, committed: true, revealed: true, stoodIn: false, revealedEpoch: 0, revealedOn: many }, { n: 3, committed: true, revealed: true, stoodIn: false, revealedOn: 'junk' }], fromStart: true, linkLost: false, dealt: true });
    expect(rec.attempts[0].revealedOn).toEqual([1, 3]);
    expect(rec.attempts[1].revealedOn).toEqual(many.slice(-MAX_REVEAL_LINKS));
    expect(rec.attempts[2].revealedOn).toBeUndefined();
    expect([sharedOn(rec.attempts[0], 0), sharedOn(rec.attempts[0], 3), sharedOn(rec.attempts[0], 2)]).toEqual([true, true, false]);
    // A share not sent was sent on no link.
    expect(sharedOn({ revealed: false, revealedEpoch: 3, revealedOn: [4] }, 4)).toBe(false);
  });
});
