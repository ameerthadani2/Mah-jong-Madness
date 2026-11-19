/**
 * The phone pings the table once a second while it holds a seat, and right after each join; the
 * table answers each ping at once with its clock. Each answer is a fixed point between the table's
 * clock and the phone's: the table stamped it after the ping reached it. A hand keeps one such fixed
 * point per 10 s of ping time (the one with the shortest round trip), only within the run of the app
 * and of its clock that sent the ping, and never in its saved record. A table that answers no ping
 * during a hand makes the hand amber.
 */
import { describe, expect, it } from 'vitest';
import { withRules, type RuleSet } from '@mjm/engine';
import { caveatKey, LoopbackHub, TableClient, TableHost, transportLink, type ClientMessage, type HostMessage, type Link, type SerializedClient } from '../src/index';
import { MAX_PINGS, NO_ANSWER_PINGS, PONG_WINDOW_MS, RTT_PUBLISH_MS } from '../src/clientclock';
import type { ClockAnchor, PlayRecord } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const plays = (c: TableClient) => (c as unknown as { plays: PlayRecord[] }).plays;
const flush = () => Promise.resolve();

/** A link whose every frame to the table the test reads (`sent`), and on which the test plays the table (`deliver`). */
function fakeLink() {
  const sent: ClientMessage[] = [];
  let cb: ((m: HostMessage) => void) | null = null;
  let closer: (() => void) | null = null;
  const link: Link = {
    send: (m) => void sent.push(m as ClientMessage),
    onMessage: (f) => {
      cb = f;
      return () => undefined;
    },
    close: () => undefined,
    onClose: (f) => {
      closer = f;
      return () => undefined;
    },
  };
  return { link, sent, deliver: (m: HostMessage) => cb?.(m), close: () => closer?.(), pings: () => sent.filter((m): m is Extract<ClientMessage, { t: 'ping' }> => m.t === 'ping') };
}

const welcome = (rules: RuleSet = RULES): HostMessage => ({ t: 'welcome', seat: 0, roomCode: 'PONG', rules, seats: [], matchId: 'm-PONG', token: 'a'.repeat(32) });

/**
 * A real table on one fake clock, its frames to the phone passed on at once except the table's own
 * pongs (dropped while `drop` is set); the phone's clock may run apart from its monotonic clock
 * (`wallAhead`, as across a sleep). The match is dealt; the phone is shown the hand.
 */
function table(code: string) {
  const clock = { now: 9_000_000, mono: 100_000, wallAhead: 0 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: withRules({ handsPerMatch: 1, turnSeconds: 120, timeBankSeconds: 0 }), now: () => clock.now, matchId: `m-${code}` });
  const base = transportLink(hub.create('p0'), 'host');
  const net = { drop: true, pings: [] as number[] };
  let cb: ((m: HostMessage) => void) | null = null;
  const link: Link = {
    ...base,
    send: (m) => {
      if ((m as ClientMessage).t === 'ping') net.pings.push((m as Extract<ClientMessage, { t: 'ping' }>).at);
      base.send(m);
    },
    onMessage: (f) => {
      cb = f;
      return base.onMessage((m) => {
        if (m.t === 'pong' && net.drop) return;
        f(m);
      });
    },
  };
  const c = new TableClient(link, 'Victim', undefined, {}, { now: () => clock.now + clock.wallAhead, monotonic: () => clock.mono });
  c.join();
  host.start();
  const pongs = (): ClockAnchor[] => plays(c).find((p) => p.hand === c.state.view?.handNumber)?.pongs ?? [];
  return {
    clock,
    host,
    c,
    net,
    pongs,
    /** Let `ms` pass on every clock. */
    pass(ms: number) {
      clock.now += ms;
      clock.mono += ms;
    },
    /** The table answers the ping that carried `at`, stamped `now`. */
    answer: (at: number, now: number) => cb?.({ t: 'pong', at, now }),
  };
}

describe('the table answers every ping at once (T1)', () => {
  it('from a peer that holds no seat, and from a seated one: `at` exactly as sent, `now` the table’s stamp', () => {
    const clock = { now: 7_000_000 };
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'PG1', rules: RULES, now: () => clock.now, matchId: 'm-PG1' });
    const got: Array<{ from: string; m: HostMessage }> = [];
    const stranger = hub.create('stranger');
    stranger.onMessage((from, m) => got.push({ from, m: m as HostMessage }));
    stranger.send('host', { t: 'ping', at: 123.456 });
    expect(got.map((g) => g.m)).toEqual([{ t: 'pong', at: 123.456, now: 7_000_000 }]);
    const seated = hub.create('seated');
    const heard: HostMessage[] = [];
    seated.onMessage((_from, m) => heard.push(m as HostMessage));
    seated.send('host', { t: 'join', name: 'A' });
    expect(heard.some((m) => m.t === 'welcome')).toBe(true);
    clock.now += 2_500;
    heard.length = 0;
    seated.send('host', { t: 'ping', at: 0.125 });
    expect(heard).toEqual([{ t: 'pong', at: 0.125, now: 7_002_500 }]);
    void host;
  });
});

describe('the phone’s pings (T3)', () => {
  it('one right after a join, sent once join() has returned; then one with every check of the link while it holds a seat on a link that is up, and none otherwise', async () => {
    const clock = { now: 50_000 };
    const net = fakeLink();
    const c = new TableClient(net.link, 'A', undefined, {}, { now: () => clock.now });
    c.join();
    expect(net.sent.map((m) => m.t)).toEqual(['join']);
    await flush();
    expect(net.sent.map((m) => m.t)).toEqual(['join', 'ping']);
    expect(net.pings()[0].at).toBe(50_000);
    // No seat yet: the watch's checks send nothing.
    clock.now += 1_000;
    c.checkLink();
    expect(net.pings()).toHaveLength(1);
    net.deliver(welcome());
    for (let s = 1; s <= 3; s++) {
      clock.now += 1_000;
      c.checkLink();
      expect(net.pings()).toHaveLength(1 + s);
      expect(net.pings()[s].at).toBe(clock.now);
    }
    // The link drops: no ping until the seat is back on a link.
    net.close();
    clock.now += 1_000;
    c.checkLink();
    expect(net.pings()).toHaveLength(4);
  });

  it('a join followed at once by another link sends the ping on the link in use only', async () => {
    const a = fakeLink();
    const b = fakeLink();
    const c = new TableClient(a.link, 'A', undefined, {}, { now: () => 1_000 });
    c.join();
    c.rebind(b.link);
    c.join();
    await flush();
    expect(a.pings()).toHaveLength(0);
    expect(b.pings()).toHaveLength(1);
  });

  it('remembers at most MAX_PINGS unanswered pings, the oldest dropped first', () => {
    const clock = { now: 10_000 };
    const net = fakeLink();
    const c = new TableClient(net.link, 'A', undefined, {}, { now: () => clock.now });
    for (let i = 0; i < MAX_PINGS + 5; i++) {
      clock.now += 10;
      c.ping();
    }
    const pings = (c as unknown as { pings: Map<number, unknown> }).pings;
    expect(pings.size).toBe(MAX_PINGS);
    expect(pings.has(net.pings()[0].at)).toBe(false);
    expect(pings.has(net.pings()[net.pings().length - 1].at)).toBe(true);
  });
});

describe('pong fixed points (T4)', () => {
  it('an answer to a ping of this run is kept; an unknown `at` and a second answer to the same ping are not', () =>
    scenario((i) => {
      const t = table(`PF1${i}`);
      need(t.c.state.view !== null && t.c.state.lastResult === null);
      t.c.ping();
      const at = t.net.pings[t.net.pings.length - 1];
      t.pass(300);
      t.answer(at, t.clock.now - 100);
      expect(t.pongs()).toEqual([{ at, now: t.clock.now - 100, era: 0, run: expect.any(String), seg: 0, fat: at + 300 }]);
      t.answer(at, t.clock.now - 5_000);
      t.answer(at + 0.5, t.clock.now - 5_000);
      expect(t.pongs()).toHaveLength(1);
      expect(t.pongs()[0].now).toBe(t.clock.now - 100);
    }));

  it('an answer to a ping read in an earlier run of this device’s clock is not kept (the phone slept between them)', () =>
    scenario((i) => {
      const t = table(`PF2${i}`);
      need(t.c.state.view !== null && t.c.state.lastResult === null);
      t.c.ping();
      const at = t.net.pings[t.net.pings.length - 1];
      // The wall clock runs 5 s further than the monotonic one: the next reading starts a new run of the device's clock.
      t.clock.wallAhead += 5_000;
      t.pass(200);
      t.answer(at, t.clock.now);
      expect(t.pongs()).toEqual([]);
      // A ping of the new run is kept, with its run of the clock.
      t.c.ping();
      const at2 = t.net.pings[t.net.pings.length - 1];
      t.pass(200);
      t.answer(at2, t.clock.now);
      expect(t.pongs()).toHaveLength(1);
      expect(t.pongs()[0].seg).toBe(1);
    }));

  it('an answer that arrives before its ping was sent, by this device’s clock, is not kept', () => {
    const clock = { now: 80_000 };
    const net = fakeLink();
    const c = new TableClient(net.link, 'A', undefined, {}, { now: () => clock.now });
    net.deliver(welcome());
    c.ping();
    const at = net.pings()[0].at;
    // A device clock that is only the injected wall clock can be set back.
    clock.now -= 1_000;
    net.deliver({ t: 'pong', at, now: 5 });
    expect((c as unknown as { pings: Map<number, unknown> }).pings.has(at)).toBe(false);
    expect(c.state.rttMs).toBeNull();
  });

  it('one fixed point per 10 s of ping time: the one with the shortest round trip', () =>
    scenario((i) => {
      const t = table(`PF3${i}`);
      need(t.c.state.view !== null && t.c.state.lastResult === null);
      // Start at the beginning of a window.
      t.pass(PONG_WINDOW_MS - (t.clock.now % PONG_WINDOW_MS));
      const round = (rtt: number) => {
        t.c.ping();
        const at = t.net.pings[t.net.pings.length - 1];
        t.pass(rtt);
        t.answer(at, t.clock.now - rtt / 2);
        return at;
      };
      round(400);
      t.pass(1_000);
      const best = round(100);
      t.pass(1_000);
      round(300);
      expect(t.pongs()).toHaveLength(1);
      expect(t.pongs()[0].at).toBe(best);
      t.pass(PONG_WINDOW_MS);
      const next = round(500);
      expect(t.pongs().map((k) => k.at)).toEqual([best, next]);
    }));

  it('one answered while a hand’s deal is agreed is kept for that hand; one to a ping sent before it, or for another hand, is not', () => {
    const clock = { now: 60_000 };
    const net = fakeLink();
    const c = new TableClient(net.link, 'A', undefined, {}, { now: () => clock.now });
    net.deliver(welcome());
    // A ping in the lobby, answered once the deal of hand 0 is being agreed: it was sent for no hand.
    c.ping();
    const early = net.pings()[0].at;
    net.deliver({ t: 'commit_request', handNumber: 0, attempt: 1 });
    clock.now += 100;
    net.deliver({ t: 'pong', at: early, now: 50_000 });
    expect(plays(c).find((p) => p.hand === 0)?.pongs ?? []).toEqual([]);
    // A ping sent during the deal is kept for hand 0.
    clock.now += 1_000;
    c.ping();
    const during = net.pings()[1].at;
    clock.now += 100;
    net.deliver({ t: 'pong', at: during, now: 51_000 });
    expect(plays(c).find((p) => p.hand === 0)?.pongs).toEqual([{ at: during, now: 51_000, era: 0, run: expect.any(String), seg: 0, fat: during + 100 }]);
    expect(plays(c).find((p) => p.hand === 0)?.pinged).toBe(1);
  });

  it('none is kept while no hand is on show (between hands, before the deal)', async () => {
    const clock = { now: 70_000 };
    const net = fakeLink();
    const c = new TableClient(net.link, 'A', undefined, {}, { now: () => clock.now });
    c.join();
    await flush();
    net.deliver(welcome());
    clock.now += 50;
    net.deliver({ t: 'pong', at: net.pings()[0].at, now: 10 });
    expect(plays(c)).toEqual([]);
    expect(c.state.rttMs).toBe(50);
  });
});

describe('the round trip is published at most every 10 s (T5)', () => {
  it('60 pongs in 60 s cause at most 7 state updates', () => {
    const clock = { now: 20_000 };
    const net = fakeLink();
    const c = new TableClient(net.link, 'A', undefined, {}, { now: () => clock.now });
    net.deliver(welcome());
    let updates = 0;
    c.onChange(() => updates++);
    for (let s = 0; s < 60; s++) {
      clock.now += 1_000;
      c.checkLink();
      const ping = net.pings()[net.pings().length - 1];
      clock.now += 80;
      net.deliver({ t: 'pong', at: ping.at, now: ping.at - 3_000 });
    }
    expect(net.pings().length).toBeGreaterThanOrEqual(60);
    expect(updates).toBeGreaterThan(0);
    expect(updates).toBeLessThanOrEqual(Math.ceil(60_000 / RTT_PUBLISH_MS) + 1);
    expect(c.state.rttMs).toBe(80);
  });
});

describe('pong fixed points and pings are never saved (T6)', () => {
  it('a saved record holds no pongs, pings, ping counts or pauses; a restored client starts with none, and drops any a record holds', () =>
    scenario((i) => {
      const w = wire({ code: `PS${i}` });
      need(w.toDiscard(2));
      // The app did not run for 3 s: a pause.
      w.c.checkLink();
      w.clock.now += 3_000;
      w.c.checkLink();
      const live = plays(w.c).find((p) => p.hand === w.c.state.view?.handNumber)!;
      need((live.pongs?.length ?? 0) > 0 && (live.pinged ?? 0) > 0);
      expect((w.c as unknown as { pauses: unknown[] }).pauses.length).toBeGreaterThan(0);
      const saved = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
      const text = JSON.stringify(saved);
      for (const k of ['"pongs"', '"pinged"', '"pings"', '"pauses"']) expect(text).not.toContain(k);
      const back = TableClient.restore(saved, transportLink(new LoopbackHub().create('back'), 'host'), 'Victim', undefined, { token: saved.state.token ?? undefined });
      expect(plays(back).every((p) => p.pongs === undefined && p.pinged === undefined)).toBe(true);
      expect((back as unknown as { pings: Map<number, unknown> }).pings.size).toBe(0);
      expect((back as unknown as { pauses: unknown[] }).pauses).toEqual([]);
      // A record that holds some (an edited one, or one from a build that kept them) gives none back.
      const edited = JSON.parse(text) as SerializedClient & { plays: Array<Record<string, unknown>> };
      edited.plays[edited.plays.length - 1].pongs = [{ at: 1, now: 0, era: 0, run: 'x', seg: 0, fat: 2 }];
      edited.plays[edited.plays.length - 1].pinged = 40;
      const again = TableClient.restore(edited, transportLink(new LoopbackHub().create('again'), 'host'), 'Victim', undefined, { token: saved.state.token ?? undefined });
      expect(plays(again).every((p) => p.pongs === undefined && p.pinged === undefined)).toBe(true);
    }));
});

describe('a table that answers no ping (T7)', () => {
  const play = (code: string, dropPongs: boolean): Wire => {
    const w = wire({ code, map: (m) => (dropPongs && m.t === 'pong' ? null : m) });
    w.finish();
    return w;
  };

  it('makes every hand amber with the reason; a table that answers keeps it green', () =>
    scenario((i) => {
      const silent = play(`NA${i}`, true);
      need(silent.c.state.audits.length > 0);
      const v = silent.verdict();
      expect(v.status).toBe('partial');
      expect(v.caveats).toContain('noAnswer');
      expect(plays(silent.c).every((p) => (p.pongs ?? []).length === 0)).toBe(true);
      const answered = play(`NB${i}`, false);
      need(answered.c.state.audits.length > 0);
      expect(answered.verdict()).toEqual({ status: 'ok', failures: [], caveats: [] });
    }));

  it(`says nothing when the phone sent fewer than ${NO_ANSWER_PINGS} pings in the hand`, () =>
    scenario((i) => {
      // The watch does not run: only the join's ping goes out, and the table plays the hand out.
      const w = wire({ code: `NC${i}`, watch: false, map: (m) => (m.t === 'pong' ? null : m) });
      w.finish();
      need(w.c.state.audits.length > 0);
      expect(w.c.state.auditCaveats.map(caveatKey)).not.toContain('noAnswer');
    }));
});
