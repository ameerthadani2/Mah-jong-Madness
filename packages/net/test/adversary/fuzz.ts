/**
 * Running scenarios: one scenario on the simulated table, judged by the oracle (`runScenario`); the shortest list of its
 * events that still fails the same way (`minimize`); and the report of a failure, with its seed, its events and the
 * command that replays it (`report`).
 */
import type { TableClient } from '../../src/index';
import { codeName, oldNet } from './load';
import { classOf, judge, type Judgement, type Violation } from './oracle';
import { withSeededCrypto } from './random';
import { describe, type Event, type Scenario } from './scenario';
import { Server } from './server';
import { ACCOUNT, NAME, Sim, T0 } from './sim';
import { Truth } from './truth';

export interface Outcome {
  scenario: Scenario;
  judgement: Judgement;
  /** Per hand, what the phone showed last: `0:green 1:amber(standIn,linkLost)`. */
  shown: string;
  timeline: string[];
  /** CPU time of the run (ms) and simulated time (s). */
  ms: number;
  simSeconds: number;
}

/** Play one scenario out and judge it. */
export function runScenario(s: Scenario): Outcome {
  const started = performance.now();
  const truth = new Truth();
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const sim = withSeededCrypto(s.seed, () => {
      const startBuild = s.events.some((e) => e.do.a === 'update') && oldNet ? oldNet : undefined;
      const sim = new Sim({ scenario: s, truth, startBuild });
      sim.adversary = new Server(sim, s);
      const p = sim.phone;
      p.start((link) => new p.build.TableClient(link, NAME, 'auntie', { userId: ACCOUNT }, p.opts()) as TableClient, 'initial');
      sim.host.start();
      sim.run();
      return sim;
    });
    const judgement = judge(s, truth);
    const shown = [...judgement.verdicts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([h, v]) => `${h}:${v.status === 'ok' ? 'green' : v.status === 'partial' ? 'amber' : v.status === 'failed' ? 'red' : v.status}`)
      .join(' ');
    return { scenario: s, judgement, shown, timeline: truth.timeline, ms: performance.now() - started, simSeconds: (sim.clock.now - T0) / 1000 };
  } finally {
    console.error = quiet;
  }
}

/** The events `keep` leaves, with the anchors that named a later index renumbered (an event that waited on a removed one goes too). */
function subset(events: Event[], keep: Set<number>): Event[] {
  const kept = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    if (!keep.has(i)) continue;
    const at = events[i].at;
    if (at.on === 'after' && !kept.has(at.event)) continue;
    kept.add(i);
  }
  const index = new Map([...kept].map((old, k) => [old, k]));
  return [...kept].map((i) => {
    const e = events[i];
    return e.at.on === 'after' ? { ...e, at: { ...e.at, event: index.get(e.at.event)! } } : e;
  });
}

/** Whether a run of `s` still fails the way `target` names (`classOf`). */
function stillFails(s: Scenario, target: string): Violation | null {
  const o = runScenario(s);
  return o.judgement.violations.find((v) => classOf(v) === target) ?? null;
}

/**
 * The shortest scenario found that still fails as `v` does: events dropped one at a time while it does (with those that
 * wait on them), then the table made smaller (fewer hands, a player who does not retry) where that keeps it.
 */
export function minimize(s: Scenario, v: Violation, budget = 40): Scenario {
  const target = classOf(v);
  let best = s;
  let runs = 0;
  let changed = true;
  while (changed && runs < budget) {
    changed = false;
    for (let i = best.events.length - 1; i >= 0 && runs < budget; i--) {
      const keep = new Set(best.events.map((_, k) => k).filter((k) => k !== i));
      const events = subset(best.events, keep);
      if (events.length === best.events.length) continue;
      const trial = { ...best, events };
      runs++;
      if (stillFails(trial, target)) {
        best = trial;
        changed = true;
        break;
      }
    }
  }
  const simpler: Array<(x: Scenario) => Scenario | null> = [
    (x) => (x.player.retry.kind !== 'none' ? { ...x, player: { ...x.player, retry: { kind: 'none', afterMs: 0 } } } : null),
    (x) => (x.othersPresent ? { ...x, othersPresent: false } : null),
    (x) => {
      const need = Math.max(1, ...x.events.map((e) => ('hand' in e.at ? (e.at as { hand: number }).hand + 1 : 1)));
      return x.hands > need ? { ...x, hands: need } : null;
    },
  ];
  for (const f of simpler) {
    if (runs >= budget) break;
    const trial = f(best);
    if (!trial) continue;
    runs++;
    if (stillFails(trial, target)) best = trial;
  }
  return best;
}

/** The scenario as one line of JSON, for `soak.ts --replay`. */
export const toJson = (s: Scenario): string => JSON.stringify(s);

/** How to replay a scenario from the repository's root. */
export function replayCommand(s: Scenario): string {
  const tree = codeName === 'repository' ? '' : `ADVERSARY_TREE=${codeName} `;
  return `${tree}npx tsx packages/net/test/adversary/soak.ts --replay '${toJson(s)}'`;
}

/** A failure as the runner prints it. */
export function report(o: Outcome, v: Violation, minimized?: Scenario): string {
  const s = minimized ?? o.scenario;
  const lines = [
    `FAIL ${v.known} ${v.property} (seed ${o.scenario.seed}, ${s.speed}, ${s.hands} hand${s.hands > 1 ? 's' : ''}): ${v.detail}`,
    ...v.cheats.slice(0, 4).map((c) => `  cheat ${c.kind} hand ${c.hand} turn ${c.turn}: ${c.what}${c.excuses.length ? ` [stated: ${c.excuses.join(', ')}]` : ''}${c.tags.length ? ` {${c.tags.join(',')}}` : ''}`),
    `  shown: ${o.shown || 'nothing'}`,
    `  events${minimized ? ' (minimized)' : ''}:`,
    ...describe(s).map((d) => `    ${d}`),
    `  replay: ${replayCommand(s)}`,
  ];
  return lines.join('\n');
}
