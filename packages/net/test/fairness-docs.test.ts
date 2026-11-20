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
import { MOVE_SLACK_MS } from '../src/client';
import { CLOCK_SKEW_MS, DRIFT_CAP_MS, DRIFT_RATE, LATE_MS, NO_ANSWER_PINGS, SILENT_ANSWER_MS, STEADY_SLACK_MS, WATCH_WINDOW_MS } from '../src/clientclock';
import { FLIGHT_SLACK_MS, LATE_COUNT_MIN_MS, LATE_LIMIT_MIN_MS, lateCountMs, lateLimitMs } from '../src/clientmoves';
import { MAX_SEEN } from '../src/clientrecords';
import { CLOCK_FRAME_MS } from '../src/messages';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');
const doc = readFileSync(join(root, 'FAIRNESS.md'), 'utf8');
const api = readFileSync(join(root, 'API.md'), 'utf8');
/** The table rows on the turn clock and on the seat's own moves, where the limits are stated. */
const turnRow = doc.split('\n').find((l) => l.startsWith('| The server did not play your turn before your time ran out')) ?? '';
const movesRow = doc.split('\n').find((l) => l.startsWith('| The server did not change or drop your moves')) ?? '';
const dropRow = doc.split('\n').find((l) => l.startsWith('| A dropped connection was not used to play your turn')) ?? '';
const s = (ms: number) => String(ms / 1000);
const rules = (k: keyof typeof SPEED_PRESETS) => withRules({ turnSeconds: SPEED_PRESETS[k].turnSeconds, timeBankSeconds: SPEED_PRESETS[k].timeBankSeconds });

describe('the fair play charter states the late-turn limits the table client uses', () => {
  it('the phone pings the table once a second and right after each join, and measures every state against the answers, its pauses left out', () => {
    expect(turnRow).toContain('your phone pings the table once a second, and right after each join; the table answers each at once with its clock');
    expect(turnRow).toContain('Time the app was not running is left out.');
    expect(api).toContain('The app sends one once a second while it holds a seat on a socket that is up, whether or not the table has welcomed it there, and one right after each `join`.');
    expect(turnRow).toContain('It pings, and watches the connection (below), whether or not the table has welcomed it on that connection');
    expect(api).toContain(`A hand in which the app sent ${NO_ANSWER_PINGS} or more pings and no answer came back is amber.`);
    expect(turnRow).toContain('A table that answers none of your pings during a hand makes the hand amber.');
  });

  it('a turn may reach the phone half its turn clock late, at least 2 s, as the client sets it at every speed', () => {
    expect(LATE_LIMIT_MIN_MS).toBe(2_000);
    const g = (k: keyof typeof SPEED_PRESETS) => s(lateLimitMs(rules(k)));
    expect(turnRow).toContain(`later than half its turn clock, and at least ${s(LATE_LIMIT_MIN_MS)} seconds (${g('relaxed')} seconds at Relaxed, ${g('normal')} at Normal, ${g('fast')} at Fast, ${g('turbo')} at Turbo, ${g('hyper')} at Hyper), makes the hand amber, never green`);
    expect(dropRow).toContain(`less half its turn clock (at least ${s(LATE_LIMIT_MIN_MS)} seconds)`);
    expect(turnRow).toContain(`at Hyper a ${g('hyper')}-second stall as your turn starts is enough`);
  });

  it('the Fair play count’s bar is half of that, at least 1 s, at every speed', () => {
    expect(LATE_COUNT_MIN_MS).toBe(1_000);
    const bar = (k: keyof typeof SPEED_PRESETS) => s(lateCountMs(rules(k)));
    expect(turnRow).toContain(`(the Fair play count, which measures your turns against the table's answers to your pings alone, counts each turn later than half of it: ${bar('relaxed')} seconds at Relaxed, ${bar('normal')} at Normal, ${bar('fast')} at Fast, ${bar('turbo')} at Turbo, ${bar('hyper')} at Hyper)`);
    expect(doc).toContain('later than half the time a turn may be late (a quarter of the turn clock, at least 1 second)');
  });

  it('a move sent in good time that the table plays over is amber; in good time is more than 1.5 s before the end of the screen’s clock; one left 30 s, pauses left out, fails', () => {
    expect(movesRow).toContain(`a legal move left unanswered for more than ${s(MOVE_SLACK_MS)} seconds and replaced by the table's own fails (time your app was not running is left out of the ${s(MOVE_SLACK_MS)} seconds)`);
    expect(movesRow).toContain(`more than ${s(FLIGHT_SLACK_MS)} seconds before the end of the clock your screen showed`);
    expect(movesRow).toContain(`more than the best round trip of the hand plus ${s(FLIGHT_SLACK_MS)} seconds, at most half the turn clock`);
    expect(movesRow).toContain(`a move you sent in the last ${s(FLIGHT_SLACK_MS)} seconds your screen showed`);
    expect(turnRow).toContain(`a move made in the last ${s(FLIGHT_SLACK_MS)} seconds your screen shows can be lost`);
  });

  it('the server’s stamps are believed 5 s beyond the phone’s clock, a whole turn at Hyper, once per run; the watch’s relation drifts by at most half a second', () => {
    expect(turnRow).toContain(`believed up to ${s(CLOCK_SKEW_MS)} seconds beyond your phone's own clock`);
    // At Hyper the allowance is more than the whole turn clock.
    expect(SPEED_PRESETS.hyper.turnSeconds * 1000).toBeLessThanOrEqual(CLOCK_SKEW_MS);
    expect(turnRow).toContain(`so a turn could be cut short by that much without failing (at Hyper, whose turn clock is ${SPEED_PRESETS.hyper.turnSeconds} seconds, a whole turn; the allowance holds once per run of the app and of the server's clock, not on every turn)`);
    expect(DRIFT_CAP_MS).toBe(500);
    expect(turnRow).toContain('allowing at most half a second for the two clocks drifting apart');
  });

  // Unit 20's honest check: a phone clock 2,000 ppm fast made most later hands of a 48-hand match amber, which the
  // charter did not say. The drift the phone allows is the code's; the times follow from it and the limit.
  it('states the drift it allows (500 ppm, half a second since the closest tie) and what a phone clock far beyond it costs', () => {
    expect(DRIFT_RATE).toBe(0.0005);
    expect(turnRow).toContain(`Your phone allows its clock and the server's to drift apart by ${DRIFT_RATE * 1e6} parts per million, and by half a second at most since the closest tie; real clocks drift less than half that.`);
    expect(turnRow).toContain('A phone clock that runs far faster, 2,000 parts per million say, makes its turns look later and later, so the later hands of a long match are amber: from about 20 minutes in at Hyper and about an hour in at Normal. One that runs that much slower makes the table\'s moves for you look early, and can fail such hands.');
    // At 2,000 ppm the turns fall 2 ms a second behind, of which the phone allows half a second in all: past the limit after
    // (limit + 0.5 s) / 2 ms a second.
    const minutes = (k: keyof typeof SPEED_PRESETS) => (lateLimitMs(rules(k)) + DRIFT_CAP_MS) / 0.002 / 60_000;
    expect(Math.round(minutes('hyper'))).toBe(21);
    expect(Math.round(minutes('normal'))).toBe(67);
  });

  it('the watch: a frame every 3 seconds, a probe 8 seconds behind, 5 more to answer, a 20-second window, 17 s on a live link, which a server can shorten and never lengthen', () => {
    expect(turnRow).toContain(`for ${s(CLOCK_FRAME_MS)} seconds`);
    expect(turnRow).toContain(`fall ${s(2 * CLOCK_FRAME_MS + 2_000)} seconds behind`);
    expect(turnRow).toContain(`After ${s(SILENT_ANSWER_MS)} more seconds it drops the connection`);
    expect(turnRow).toContain(`the last ${s(WATCH_WINDOW_MS)} seconds`);
    expect(turnRow).toContain(`the state must reach you within ${s(LATE_MS)} seconds of its stamp by the watch's measure`);
    expect(turnRow).toContain('a server can shorten the 3 and the 8 by announcing a shorter clock-frame period, never lengthen them');
  });

  it('the watch keeps a connection whose frames come at the pace of their stamps, the last within 4 seconds, behind a delay steady to within a second over 8 seconds', () => {
    expect(STEADY_SLACK_MS).toBe(1_000);
    expect(turnRow).toContain(`the last within ${s(CLOCK_FRAME_MS + 1_000)} seconds, behind by a delay that has held steady to within a second over the last ${s(2 * CLOCK_FRAME_MS + 2_000)} seconds`);
  });

  it('names every event after which the measure starts afresh: a sleep, an app restart, the phone’s clock set forward, an announced server restart', () => {
    const sentence = turnRow.slice(turnRow.indexOf('After your phone sleeps'));
    expect(sentence).toMatch(/^After your phone sleeps, after the app restarts .*, after your phone's clock is set forward by more than a second, or after a restart the server announces, the measure starts afresh from the next answered ping, within a second/);
    expect(turnRow).toContain("For each run of the server's clock, of the app and of your phone's own clock");
  });

  it('the screen’s clock never counts to less than the rules’ clock, a later end it showed binds the table, and a restart while a move is owed is amber', () => {
    expect(turnRow).toContain("It never counts to less than the rules' clock your phone tracked. A later end the server shows you binds it: if the table then plays for you before it, the hand fails, even if a later state took the time back.");
    expect(turnRow).toContain("If the server says it restarted while you owed a move, and then plays that move for you, the hand is amber: the time your screen showed before the restart cannot be checked against the server's new clock.");
    expect(turnRow).toContain('Until a ping is answered after the app restarts or your phone sleeps, it is placed by the quickest frame your phone has had since, so a turn the server holds on its way does not make it show more time.');
  });

  it('states how many states of a hand the phone keeps', () => {
    expect(doc).toContain(`It keeps up to ${MAX_SEEN} states of each hand`);
  });

  it('no longer gives 17 s as the bound on a late turn, says turns 25 to 30 s late stay green, or says a protocol change is still needed', () => {
    expect(turnRow).not.toMatch(/amber at best/);
    expect(turnRow).not.toMatch(/21 seconds/);
    expect(doc).not.toMatch(/25 to 30 seconds/);
    expect(doc).not.toMatch(/change to the protocol|protocol change/);
    // 17 s is left only as the watch's bound on a live link.
    expect(turnRow.match(/17 seconds/g)).toHaveLength(1);
  });
});
