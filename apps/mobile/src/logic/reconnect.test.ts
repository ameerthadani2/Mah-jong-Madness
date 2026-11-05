import { describe, expect, it } from 'vitest';
import { backoffSeconds, CONNECTED, MAX_RECONNECT_ATTEMPTS, nextDelayMs, reconnectStep, type ReconnectEvent, type ReconnectState } from './reconnect';

const run = (events: ReconnectEvent[], from: ReconnectState = CONNECTED) => events.reduce((s, e) => reconnectStep(s, e), from);

describe('backoffSeconds', () => {
  it('doubles from one second and caps at a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(backoffSeconds)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
    expect(backoffSeconds(100)).toBe(60);
  });

  it('treats nonsense attempts as the first', () => {
    expect(backoffSeconds(0)).toBe(1);
    expect(backoffSeconds(-3)).toBe(1);
  });
});

describe('reconnectStep', () => {
  it('starts reconnecting at attempt 1 when the socket closes', () => {
    const s = run([{ type: 'closed' }]);
    expect(s).toEqual({ status: 'reconnecting', attempt: 1, reason: null });
    expect(nextDelayMs(s)).toBe(1000);
  });

  it('counts failed attempts with a growing delay', () => {
    const s = run([{ type: 'closed' }, { type: 'failed' }, { type: 'failed' }, { type: 'failed' }]);
    expect(s).toEqual({ status: 'reconnecting', attempt: 4, reason: null });
    expect(nextDelayMs(s)).toBe(8000);
  });

  it('is connected again after a successful attempt, with the count reset', () => {
    const s = run([{ type: 'closed' }, { type: 'failed' }, { type: 'succeeded' }]);
    expect(s).toEqual(CONNECTED);
    expect(nextDelayMs(s)).toBeNull();
    expect(run([{ type: 'closed' }], s).attempt).toBe(1);
  });

  it('gives up after ten failed attempts', () => {
    const fails = Array.from({ length: MAX_RECONNECT_ATTEMPTS - 1 }, (): ReconnectEvent => ({ type: 'failed' }));
    const almost = run([{ type: 'closed' }, ...fails]);
    expect(almost).toEqual({ status: 'reconnecting', attempt: 10, reason: null });
    const lost = reconnectStep(almost, { type: 'failed' });
    expect(lost).toEqual({ status: 'lost', attempt: 10, reason: 'exhausted' });
    expect(nextDelayMs(lost)).toBeNull();
  });

  it('gives up at once when the server refuses the session (4401)', () => {
    expect(run([{ type: 'closed' }, { type: 'failed', unauthorised: true }])).toEqual({ status: 'lost', attempt: 1, reason: 'unauthorised' });
    expect(run([{ type: 'unauthorised' }])).toMatchObject({ status: 'lost', reason: 'unauthorised' });
  });

  it('ignores events that do not apply', () => {
    expect(reconnectStep(CONNECTED, { type: 'failed' })).toBe(CONNECTED);
    expect(reconnectStep(CONNECTED, { type: 'succeeded' })).toBe(CONNECTED);
    const r = run([{ type: 'closed' }, { type: 'failed' }]);
    expect(reconnectStep(r, { type: 'closed' })).toBe(r);
    const lost = run([{ type: 'unauthorised' }]);
    expect(reconnectStep(lost, { type: 'closed' })).toBe(lost);
    expect(reconnectStep(lost, { type: 'succeeded' })).toBe(lost);
    expect(reconnectStep(lost, { type: 'ended' })).toBe(lost);
  });

  it('stops when the match ends or the player leaves', () => {
    expect(run([{ type: 'closed' }, { type: 'ended' }])).toMatchObject({ status: 'lost', reason: 'ended' });
  });
});
