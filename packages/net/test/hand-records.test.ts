/**
 * Records bound to their hand.
 *
 * The phone keeps what it saw of each hand under that hand: the commitments it revealed against, the flags of what the
 * table did wrong, the stretches its ledger vouches for. A frame about another hand neither replaces nor empties what
 * it holds for the hand it is on, and what it saves for an app restart is what it holds in memory: the same records,
 * under the same caps, and never without the hand on show.
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { commitFor, type HostMessage } from '../src/index';
import { makeSecret } from '../src/fairness';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
/** Five well-formed commitments the server makes up. */
const madeUp = () => [0, 1, 2, 3, 4].map((seat) => ({ seat, hash: commitFor(makeSecret()) }));

/**
 * Normal. The phone watches hand 0's deal from its first attempt over one link. When its secret reaches the host, the
 * host swaps its own share (seat 4) for a fresh one and deals from that, so the commitment the audit lists for seat 4
 * is not the one the phone was shown before it revealed. Once the deal has reached the phone, the server cuts the link
 * and, right behind the new welcome, sends: `later`, a well-formed set for hand 1, then hand 0's set with the new seat-4
 * commitment; `standIn`, a stand-in notice for hand 1, then that set; `resend`, that set alone; `plain`, nothing.
 */
function repick(code: string, mode: 'later' | 'standIn' | 'resend' | 'plain') {
  let swapped = false;
  let cut = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    upFilter: (m, w) => {
      if (m.t === 'reveal' && !swapped && w.host.phase === 'reveal' && (w.host as unknown as { snapshot: { handNumber: number } }).snapshot.handNumber === 0) {
        const h = w.host as unknown as { hostSecret: string; hostCommit: string };
        h.hostSecret = makeSecret();
        h.hostCommit = commitFor(h.hostSecret);
        swapped = true;
      }
      return true;
    },
    onTick: (w) => {
      if (!swapped || cut || w.c.state.view?.handNumber !== 0) return;
      cut = true;
      const now = (w.host as unknown as { commits(): Array<{ seat: number; hash: string }> }).commits();
      if (mode === 'later') w.afterWelcome({ t: 'commits', handNumber: 1, commits: madeUp() } as HostMessage);
      if (mode === 'standIn') w.afterWelcome({ t: 'stand_in', handNumber: 1, attempt: 1 } as HostMessage);
      if (mode !== 'plain') w.afterWelcome({ t: 'commits', handNumber: 0, commits: now } as HostMessage);
      w.dropNow();
    },
  });
  w.finish();
  return { w, attacked: swapped && cut };
}

describe('the commitments of each hand', () => {
  it('a set for the next hand behind a new welcome, then the hand on show’s set with a share picked after the reveal: red, the set the phone revealed against is kept', () =>
    scenario((i) => {
      const a = repick(`HRL${i}`, 'later');
      need(a.attacked);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['commitsChanged', 'commitChangedAfter']));
    }));

  it('a stand-in notice for the next hand behind a new welcome, then that set: red, the set is not emptied', () =>
    scenario((i) => {
      const a = repick(`HRS${i}`, 'standIn');
      need(a.attacked);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['commitsChanged', 'commitChangedAfter']));
    }));

  it('the same set sent again alone, or nothing sent: red as before', () =>
    scenario((i) => {
      const a = repick(`HRR${i}`, 'resend');
      need(a.attacked);
      expect(a.w.verdict()).toMatchObject({ status: 'failed' });
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['commitsChanged', 'commitChangedAfter']));
      const b = repick(`HRP${i}`, 'plain');
      need(b.attacked);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['commitChangedAfter'] });
    }));
});
