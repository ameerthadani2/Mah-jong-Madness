/**
 * A record's format never makes an honest table red.
 *
 * Since unit 20f the client files every audit cut to the fields its checks read (`keptAudit`: `restartReasons`, display
 * text no check reads, kept empty). A record saved by an earlier build holds its audits whole, and a returning seat is
 * sent the result of the hand on show again (`TableHost.onJoin` between hands), which the client compares with the audit
 * on file. A restored record's audits are now cut the same way when it is loaded, so the two are compared like with like.
 * Before, an honest table turned red after an app update ("Host sent a different audit for a hand it had already ended").
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { failureKey, type SerializedClient } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

/** A saved record's audits, as plain objects (what storage holds). */
type Entry = { audit: Record<string, unknown> };
const auditsOf = (d: SerializedClient): Entry[] => d.state.audits as unknown as Entry[];
const withAudits = (d: SerializedClient, audits: Entry[], extra: Record<string, unknown> = {}): SerializedClient => ({ ...d, state: { ...d.state, audits, ...extra } }) as unknown as SerializedClient;

/**
 * Normal, two hands, a long pause between them. Once hand 0's result has reached the phone the app is updated and the
 * table resumed from Home: the client restored from the record (`edit` makes it one an earlier build saved), on a new
 * link, where the table sends hand 0's result again.
 */
function updatedBetweenHands(code: string, edit?: (d: SerializedClient) => SerializedClient) {
  let restarted = false;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
    botDelayMs: 700,
    intermissionSeconds: 120,
    onTick: (w) => {
      if (restarted || !w.c.state.audits.some((a) => a.audit.handNumber === 0)) return;
      restarted = true;
      w.restart(edit);
    },
  });
  for (let k = 0; k < 4_000 && !restarted; k++) w.step();
  // Until the result of hand 0 has come again on the new link.
  for (let k = 0; k < 20; k++) w.step();
  const hand0 = w.c.state.audits.filter((a) => a.audit.handNumber === 0);
  return { w, restarted, hand0: hand0.map((a) => ({ status: a.status, failures: a.failures.map(failureKey) })) };
}

/** What an earlier build saved: each audit whole, the reasons for the deal's restarts among it. */
const whole = (a: Record<string, unknown>): Record<string, unknown> => ({ ...a, restartReasons: ['Seat 0 did not reveal in time'] });

describe('a record an earlier build saved, with its audits whole', () => {
  it('its audits are filed as this build files them, and the result the table sends again matches: the hand stays as it was (it went red)', () =>
    scenario((i) => {
      const r = updatedBetweenHands(`RFW${i}`, (d) => withAudits(d, auditsOf(d).map((x) => ({ ...x, audit: whole(x.audit) }))));
      need(r.restarted && r.hand0.length > 0);
      expect(r.hand0.every((a) => a.status !== 'failed')).toBe(true);
      expect(r.w.c.state.matchFailed).toBe(false);
      expect(r.w.c.state.audits.every((a) => Array.isArray(a.audit.restartReasons) && a.audit.restartReasons.length === 0)).toBe(true);
    }));

  it('the same with the last audit saved whole beside the list (records saved before it was kept once): the same', () =>
    scenario((i) => {
      const r = updatedBetweenHands(`RFL${i}`, (d) => {
        const audits = auditsOf(d).map((x) => ({ ...x, audit: whole(x.audit) }));
        const last = audits.find((x) => x.audit.handNumber === 0)?.audit ?? null;
        const { lastAuditAt: _at, ...rest } = d;
        void _at;
        return withAudits(rest as SerializedClient, audits, { lastAudit: last ? { ...last } : null });
      });
      need(r.restarted && r.hand0.length > 0);
      expect(r.hand0.every((a) => a.status !== 'failed')).toBe(true);
      expect(r.w.c.state.matchFailed).toBe(false);
      expect(r.w.c.state.lastAudit?.restartReasons).toEqual([]);
    }));

  it('control: a record this build saved, restored the same way: nothing fails', () =>
    scenario((i) => {
      const r = updatedBetweenHands(`RFC${i}`);
      need(r.restarted && r.hand0.length > 0);
      expect(r.hand0.every((a) => a.status !== 'failed')).toBe(true);
      expect(r.w.c.state.matchFailed).toBe(false);
    }));

  it('a different audit sent again is still caught: a record whose audit was saved with another seed, the result sent again: red', () =>
    scenario((i) => {
      const r = updatedBetweenHands(`RFD${i}`, (d) => withAudits(d, auditsOf(d).map((x) => (x.audit.handNumber === 0 ? { ...x, audit: { ...x.audit, seed: 'ab'.repeat(32) } } : x))));
      need(r.restarted && r.hand0.length > 0);
      expect(r.hand0.some((a) => a.failures.includes('auditChanged'))).toBe(true);
    }));
});
