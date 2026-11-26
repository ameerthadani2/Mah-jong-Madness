/**
 * Server restarts blame nobody.
 *
 * A server that restarts while it agrees a deal starts the ceremony again with a new attempt, and a restart notice starts
 * the phone's measure of the server's clock afresh. Before unit 20h an honest table could go red for either: a restart in
 * the ceremony plus a reveal lost with a dropped link took more attempts than one plus one per human seat, and a second
 * restart in one hand was taken as the server's own making. Now up to two server restarts count in a deal's attempts, and
 * a second restart notice while a hand is on show makes that hand amber (`restartedAgain`); a third, or a second that
 * names another hand, fails it. A server can say it restarted at will, so the count is bounded (and a restarted deal is
 * amber whatever the count: the server could have picked it).
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_CAVEATS } from '../src/index';
import { runScenario } from './adversary/fuzz';
import type { Scenario } from './adversary/scenario';

const verdicts = (s: Scenario) => {
  const o = runScenario(s);
  return { o, hands: [...o.judgement.verdicts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) };
};

describe('server restarts at an honest table', () => {
  it('a restart while the first deal is agreed, then a reveal lost with the link: amber, not red (it was "3 ceremony attempts is more than 2")', () => {
    const { o, hands } = verdicts({
      seed: 300462,
      speed: 'turbo',
      hands: 1,
      othersPresent: false,
      botDelayMs: 700,
      player: { thinkMs: [600, 1500], retry: { kind: 'none', afterMs: 0 }, readyMs: 1000 },
      events: [
        { at: { on: 'commit', hand: 0, ms: 0 }, do: { a: 'serverRestart', downMs: 1000 } },
        { at: { on: 'reveal', hand: 0 }, do: { a: 'cut', downMs: 1000, lose: true } },
      ],
    } as Scenario);
    expect(hands[0]).toMatchObject({ status: 'partial', failures: [] });
    expect(hands[0].caveats).toContain(AUDIT_CAVEATS.restarted);
    expect(o.judgement.violations.map((v) => v.property)).not.toContain('falseRed');
  });

  it('two restarts in one hand, in its deal and in its play: amber with the restart named, not red (it was "restarted this hand more than once")', () => {
    const { o, hands } = verdicts({
      seed: 102818,
      speed: 'relaxed',
      hands: 1,
      othersPresent: false,
      botDelayMs: 1200,
      player: { thinkMs: [2000, 6000], retry: { kind: 'none', afterMs: 0 }, readyMs: null },
      events: [
        { at: { on: 'state', hand: 0, kind: 'claim', k: 2, ms: 0 }, do: { a: 'serverRestart', downMs: 1000 } },
        { at: { on: 'commit', hand: 0, ms: 500 }, do: { a: 'serverRestart', downMs: 1000 } },
      ],
    } as Scenario);
    expect(hands[0]).toMatchObject({ status: 'partial', failures: [] });
    expect(hands[0].caveats).toContain(AUDIT_CAVEATS.restartedAgain);
    expect(o.judgement.violations.map((v) => v.property)).not.toContain('falseRed');
  });
});
