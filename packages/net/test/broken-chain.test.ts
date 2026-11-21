/**
 * The hand after a record that does not replay says that its start was not checked.
 *
 * When a hand's record does not replay to its final hash, nothing chains from it: the next hand's start (its scores,
 * dealer and wind) is checked against nothing. That hand is then amber (`unchained`), never green, and the final scores
 * that rest on it are not shown as verified. Honest records always replay, so this costs no honest hand.
 */
import { describe, expect, it } from 'vitest';
import { withRules, type MatchSnapshot } from '@mjm/engine';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

/**
 * Two rotations at Normal. `brokenRecord`: the server sends hand 0's result with its final hash changed, so the record
 * does not replay. `shift`: it moves that many points from the seat to seat 1 in the scores hand 1 starts from.
 */
function chain(code: string, brokenRecord: boolean, shift: number) {
  let broken = false;
  let moved = false;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
    botDelayMs: 700,
    intermissionSeconds: 5,
    think: () => 1_000,
    map: (m) => {
      if (!brokenRecord || m.t !== 'hand_over' || m.audit.handNumber !== 0) return m;
      broken = true;
      const c = JSON.parse(JSON.stringify(m)) as typeof m;
      c.audit.finalHash = (c.audit.finalHash[0] === '0' ? '1' : '0') + c.audit.finalHash.slice(1);
      return c;
    },
    onTick: (w) => {
      const snap = (w.host as unknown as { snapshot: MatchSnapshot }).snapshot;
      if (shift === 0 || moved || snap.handNumber !== 1 || snap.matchOver) return;
      moved = true;
      snap.scores = snap.scores.slice();
      snap.scores[0] -= shift;
      snap.scores[1] += shift;
    },
  });
  for (let e = 0; e < 7_200_000 && !w.c.state.audits.some((a) => a.audit.handNumber === 1); e += 500) w.step();
  const hand = (h: number) => w.c.state.audits.find((a) => a.audit.handNumber === h);
  return { w, set: (!brokenRecord || broken) && (shift === 0 || moved), h0: hand(0), h1: hand(1) };
}

describe('the hand after a record that does not replay', () => {
  it('hand 0’s record broken and 300 points moved before hand 1: hand 1 amber, its start unchecked (it was once green)', () =>
    scenario((i) => {
      const a = chain(`BCM${i}`, true, 300);
      need(a.set && !!a.h0 && !!a.h1);
      expect(a.h0!.status).toBe('failed');
      expect(a.h1!.status).toBe('partial');
      expect(a.h1!.caveats).toContain('The record of the hand before this one did not replay, so the scores this hand started from could not be checked');
    }));

  it('controls: hand 0 honest with the points moved, hand 1 red as it always was; hand 0 broken alone, hand 1 amber the same way (it was once green)', () =>
    scenario((i) => {
      const a = chain(`BCC${i}`, false, 300);
      need(a.set && !!a.h1);
      expect(a.h1!.status).toBe('failed');
      expect(a.h1!.failures.some((f) => f.startsWith('Hand started with scores'))).toBe(true);
      const b = chain(`BCB${i}`, true, 0);
      need(b.set && !!b.h1);
      expect(b.h1!.status).toBe('partial');
      expect(b.h1!.caveats).toContain('The record of the hand before this one did not replay, so the scores this hand started from could not be checked');
      const c = chain(`BCH${i}`, false, 0);
      need(c.set && !!c.h1);
      expect(c.h1!.caveats).not.toContain('The record of the hand before this one did not replay, so the scores this hand started from could not be checked');
    }));
});
