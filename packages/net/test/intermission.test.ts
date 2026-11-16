/**
 * Between hands the host deals the next one on its own after a short intermission. The players'
 * result sheets count down to it, so the host says when (`deadline` on `hand_over`, on its own clock)
 * and the client keeps it as `intermissionDeadline` until the next hand begins.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink } from '../src/index';
import { seededDeals } from './support';

seededDeals();

function table(code: string, intermissionSeconds = 7) {
  const clock = { now: 2_000_000 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: withRules({ handsPerMatch: 4 }), now: () => clock.now, matchId: `m-${code}`, intermissionSeconds });
  return { clock, hub, host };
}

function playOut(host: TableHost, c: TableClient, clock: { now: number }) {
  let guard = 0;
  while (host.phase === 'playing' && guard++ < 4000) {
    const s = c.localState();
    const seat = c.state.seat;
    if (s && seat !== null && legalActions(s, seat).length > 0) c.act(chooseAction(s, seat, { seed: 'p' })!);
    else {
      clock.now += 60_000;
      host.tick();
    }
  }
  expect(host.phase).toBe('hand_over');
}

describe('the countdown to the next hand', () => {
  it('reaches the client with the hand result, on the host clock, and clears when the next hand is dealt', () => {
    const { clock, hub, host } = table('IM1', 7);
    const frames: Array<{ t: string; deadline?: unknown; now?: unknown }> = [];
    const t = hub.create('p0');
    const recv = t.onMessage.bind(t);
    t.onMessage = (fn) => recv((from, msg) => {
      frames.push(msg as never);
      fn(from, msg);
    });
    const c = new TableClient(transportLink(t, 'host'), 'Ann');
    c.join();
    host.start();
    expect(c.state.intermissionDeadline).toBeNull();
    playOut(host, c, clock);
    const over = frames.filter((f) => f.t === 'hand_over').at(-1)!;
    expect(over.deadline).toBe(host.nextDeadline());
    expect(over.deadline).toBe((over.now as number) + 7_000);
    expect(c.state.lastResult).not.toBeNull();
    expect(c.state.intermissionDeadline).toBe(host.nextDeadline());
    // The intermission runs out and the host deals: the countdown is gone with the old result.
    clock.now = host.nextDeadline()!;
    host.tick();
    expect(host.phase).not.toBe('hand_over');
    for (let i = 0; i < 20 && c.state.lastResult !== null; i++) host.tick();
    expect(c.state.intermissionDeadline).toBeNull();
  });

  it('a seat that returns during the intermission is told when the next hand comes', () => {
    const { clock, hub, host } = table('IM2', 9);
    const first = hub.create('p0');
    const c = new TableClient(transportLink(first, 'host'), 'Ann');
    c.join();
    host.start();
    playOut(host, c, clock);
    expect(c.state.intermissionDeadline).toBe(host.nextDeadline());
    first.close();
    expect(host.nextDeadline()).toBeNull(); // nobody human here: the table waits
    clock.now += 3_000;
    const back = new TableClient(transportLink(hub.create('p0b'), 'host'), 'Ann', undefined, { token: c.state.token! });
    back.join();
    expect(host.nextDeadline()).toBe(clock.now + 9_000);
    expect(back.state.intermissionDeadline).toBe(host.nextDeadline());
  });

  it('a hand_over from an older host without a deadline leaves the countdown off', () => {
    const { clock, hub, host } = table('IM3', 5);
    const t = hub.create('p0');
    const recv = t.onMessage.bind(t);
    t.onMessage = (fn) => recv((from, msg) => fn(from, (msg as { t: string }).t === 'hand_over' ? { ...(msg as object), deadline: undefined } : msg));
    const c = new TableClient(transportLink(t, 'host'), 'Ann');
    c.join();
    host.start();
    playOut(host, c, clock);
    expect(c.state.lastResult).not.toBeNull();
    expect(c.state.auditStatus).not.toBe('failed');
    expect(c.state.intermissionDeadline).toBeNull();
  });
});
