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
export const OPEN_GAPS = new Set(['N2', 'N3']);

/**
 * Generated seeds that find a gap this code still has (one of `OPEN_GAPS`, or a variant of a closed one the long runs found):
 * adversary-gaps.test.ts runs them as expected failures, so the run stays green while each is open and turns red the day
 * it is closed. Not under coverage.
 */
export const OPEN_MIXED_SEEDS = COVERED
  ? []
  : [
      970, // N3
      468, // N1: states held on a link that was up, then the link ended: the table's moves for the player amber, the end verified
      6534, // R1: a stand-in deal and moves written as the player's, judged by a phone with no record: the end verified
      3414, // R2: a move lost under a 12 s delay, answered by late refusals, then a seat-taken notice: the table's move green
      5174, // S1: a claim lost and a pass of the same link played, saves failing, then a restart: green
      6014, // a server restart in a deal, then a claim written as the table's own: amber, the end verified
      5285, // states held, then another device: the table's moves on turns never shown amber with no stated limit
    ];
/** Honest seeds that show red on this code: run as expected failures too. Not under coverage. */
export const OPEN_HONEST_SEEDS = COVERED
  ? []
  : [
      5247, // the seat opened on another device right after the commit request, then back here: red (myCommitAltered, mySecretAltered)
    ];
