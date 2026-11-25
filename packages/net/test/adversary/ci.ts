/**
 * What the fuzzer's CI files share (adversary.test.ts, adversary-gaps.test.ts, adversary-rules.test.ts: three files, so
 * the test runner runs them side by side): the time limit of a test, whether coverage is measuring the run, and what the
 * oracle finds wrong with a run of a scenario.
 */
import { report, runScenario } from './fuzz';
import type { Scenario } from './scenario';

/** Coverage measures this run: the code runs about four times slower, so the samples are smaller (adversary.test.ts). */
export const COVERED = process.argv.includes('--coverage') || !!process.env.COVERAGE;
/** A test's time limit: a minute, five under coverage. */
export const LIMIT = (COVERED ? 5 : 1) * 60_000;

/** What the oracle finds wrong with a run of `s`, as the runner prints it (nothing when the phone did right). */
export function failures(s: Scenario): string[] {
  const o = runScenario(s);
  return o.judgement.violations.map((v) => report(o, v));
}

/**
 * Gaps this code still has, found by the fuzzer and reported with their seeds (oracle.ts KNOWN): each test of one fails
 * while its gap is open (`it.fails`), so the run stays green, and turns red the day the gap is closed, when the case moves
 * to the closed ones. A gap docs/FAIRNESS.md comes to state as a limit becomes a `limit` case in known.ts instead.
 */
export const OPEN_GAPS = new Set(['N2', 'N3', 'N4']);
