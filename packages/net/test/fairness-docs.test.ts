/**
 * docs/FAIRNESS.md tells players, in seconds, what their phone allows a server and when its measure
 * starts afresh. These are the numbers and events the table client works with; when one changes in
 * the code, the charter must change with it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPEED_PRESETS, withRules } from '@mjm/engine';
import { DRIFT_CAP_MS, LATE_MS, RTT_ALLOW_MS, SILENT_ANSWER_MS, STEADY_SLACK_MS, WATCH_WINDOW_MS } from '../src/clientclock';
import { lateCountMs } from '../src/clientmoves';
import { MAX_SEEN } from '../src/clientrecords';
import { CLOCK_FRAME_MS } from '../src/messages';

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'FAIRNESS.md'), 'utf8');
/** The table row on the turn clock, where the limits are stated. */
const turnRow = doc.split('\n').find((l) => l.startsWith('| The server did not play your turn before your time ran out')) ?? '';
const s = (ms: number) => String(ms / 1000);

describe('the fair play charter states the late-turn limits the table client uses', () => {
  it('17 seconds late is amber at best, about 21 against the round trips, with at most half a second for drift', () => {
    expect(turnRow).toContain(`more than ${s(LATE_MS)} seconds after its stamp`);
    expect(turnRow).toContain(`more than about ${s(LATE_MS + RTT_ALLOW_MS)} seconds late`);
    expect(DRIFT_CAP_MS).toBe(500);
    expect(turnRow).toContain('allowing at most half a second for the two clocks drifting apart');
  });

  it('the watch: a frame every 3 seconds, a probe 8 seconds behind, 5 more to answer, a 20-second window, which a server can shorten and never lengthen', () => {
    expect(turnRow).toContain(`for ${s(CLOCK_FRAME_MS)} seconds`);
    expect(turnRow).toContain(`fall ${s(2 * CLOCK_FRAME_MS + 2_000)} seconds behind`);
    expect(turnRow).toContain(`After ${s(SILENT_ANSWER_MS)} more seconds it drops the connection`);
    expect(turnRow).toContain(`the last ${s(WATCH_WINDOW_MS)} seconds`);
    expect(turnRow).toContain('a server can shorten the 3 and the 8 by announcing a shorter clock-frame period, never lengthen them');
  });

  it('the watch keeps a connection whose frames come at the pace of their stamps, the last within 4 seconds, behind a delay steady to within a second over 8 seconds', () => {
    expect(STEADY_SLACK_MS).toBe(1_000);
    expect(turnRow).toContain(`the last within ${s(CLOCK_FRAME_MS + 1_000)} seconds, behind by a delay that has held steady to within a second over the last ${s(2 * CLOCK_FRAME_MS + 2_000)} seconds`);
  });

  it('names every event after which the measure starts afresh: a sleep, an app restart, the phone’s clock set forward, an announced server restart', () => {
    const sentence = turnRow.slice(turnRow.indexOf('After your phone sleeps'));
    expect(sentence).toMatch(/^After your phone sleeps, after the app restarts .*, after your phone's clock is set forward by more than a second, or after a restart the server announces, the measure starts afresh/);
    expect(turnRow).toContain("For each run of the server's clock, of the app and of your phone's own clock");
  });

  it('states how many states of a hand the phone keeps', () => {
    expect(doc).toContain(`It keeps up to ${MAX_SEEN} states of each hand`);
  });

  it('gives each speed’s turn clock and time bank as the rules have them, and the bar of the Fair play count as the client sets it', () => {
    const p = SPEED_PRESETS;
    expect(turnRow).toContain(`the whole turn at Normal (${p.normal.turnSeconds} seconds) and at Fast (${p.fast.turnSeconds}), and more than half a turn at Relaxed (${p.relaxed.turnSeconds})`);
    expect(turnRow).toContain(`At Turbo (${p.turbo.turnSeconds} seconds and a ${p.turbo.timeBankSeconds}-second bank) it is the whole clock, bank included`);
    expect(p.turbo.turnSeconds + p.turbo.timeBankSeconds).toBeLessThanOrEqual(LATE_MS / 1000);
    expect(p.hyper.timeBankSeconds).toBe(0);
    expect(turnRow).toContain(`at Hyper (${p.hyper.turnSeconds} seconds, no bank) more than four times the clock`);
    const bar = (k: keyof typeof SPEED_PRESETS) => s(lateCountMs(withRules({ turnSeconds: p[k].turnSeconds, timeBankSeconds: p[k].timeBankSeconds })));
    expect(turnRow).toContain(`(${bar('hyper')} seconds at Hyper, ${bar('turbo')} at Turbo, ${bar('fast')} at Fast, ${bar('normal')} at Normal, ${bar('relaxed')} at Relaxed)`);
  });
});
