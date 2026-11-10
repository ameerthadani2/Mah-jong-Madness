/**
 * The record a client keeps of a match cannot be wiped, skipped past or overwritten by the host:
 * the end of a match is believed only when the verified hands say so, a new match id resets the
 * record only after such an end, hands follow one another without a jump, and a hand that has been
 * verified keeps the result, view and audit this client checked.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, countsFromKinds, dealFromSnapshot, kindOf, legalActions, NUM_PLAY_KINDS, shanten, viewFor, withRules, type GameState, type MatchSnapshot } from '@mjm/engine';
import { deriveSeed, LoopbackHub, TableClient, TableHost, transportLink, type Audit, type HostMessage, type Reveal, type SeatInfo } from '../src/index';

interface HostInternals {
  phase: string;
  game: GameState | null;
  matchId: string;
  roomCode: string;
  rules: unknown;
  snapshot: MatchSnapshot;
  seats: Array<{ seat: number; secret?: string; peerId: string | null; token?: string }>;
  ceremonyBusy: boolean;
  ceremonyHand: number;
  audits: Audit[];
  checkCeremony: () => void;
  beginHand: (cause?: string, seats?: number[]) => void;
  reveals: () => Reveal[];
  seatInfo: () => SeatInfo[];
  sendTo: (peerId: string, msg: HostMessage) => void;
}
const internals = (host: TableHost) => host as unknown as HostInternals;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A peer whose messages reach the host on a later task, so the host sees each reveal on its own. */
function asyncPeer(hub: LoopbackHub, id: string) {
  const t = hub.create(id);
  const send = t.send.bind(t);
  t.send = (to: string, msg: unknown) => void setTimeout(() => send(to, msg), 0);
  return t;
}

function table(code: string, hands: number, opts: { intermissionSeconds?: number } = {}) {
  const clock = { now: 1_000_000 };
  const hub = new LoopbackHub();
  const rules = withRules({ handsPerMatch: hands });
  const host = new TableHost(hub.create('host'), { roomCode: code, rules, now: () => clock.now, matchId: `m-${code}`, ...opts });
  return { clock, hub, host, h: internals(host), rules };
}

async function waitDealt(host: TableHost) {
  for (let i = 0; i < 400 && host.phase !== 'playing' && host.phase !== 'hand_over'; i++) await tick();
  // Let the frames the deal produced reach the client.
  for (let i = 0; i < 4; i++) await tick();
}

/** The client plays its own seat; everything else moves on the clock. */
async function playOutAsync(host: TableHost, c: TableClient, clock: { now: number }) {
  let guard = 0;
  while (host.phase === 'playing' && guard++ < 4000) {
    const s = c.localState();
    const seat = c.state.seat;
    if (s && seat !== null && legalActions(s, seat).length > 0) c.act(chooseAction(s, seat, { seed: 'p' })!);
    else {
      clock.now += 60_000;
      host.tick();
    }
    await tick();
  }
  for (let i = 0; i < 4; i++) await tick();
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

function startShanten(g: GameState): number {
  return shanten(countsFromKinds(g.players[0].hand.map(kindOf).filter((k) => k < NUM_PLAY_KINDS)), 5);
}

/**
 * A host that looks at the deal once every share is in and, `times` times, runs `redo` instead of
 * dealing it (the cheats below differ only in how they try to make the client forget the attempt).
 */
function redealing(h: HostInternals, host: TableHost, times: number, redo: (attempt: number, wouldDeal: GameState) => void, when: (snap: MatchSnapshot) => boolean = () => true) {
  const orig = h.checkCeremony.bind(host);
  let done = 0;
  h.checkCeremony = () => {
    if (!h.ceremonyBusy && h.phase === 'reveal' && h.seats.every((s) => s.secret) && done < times && when(h.snapshot)) {
      done++;
      redo(done, dealFromSnapshot(h.snapshot, deriveSeed(`${h.matchId}:${h.snapshot.handNumber}`, h.reveals()), host.rules));
      return;
    }
    orig();
  };
  return () => done;
}

function fakeNewMatch(h: HostInternals, id: string, wouldDeal: GameState) {
  const peer = h.seats[0].peerId!;
  h.sendTo(peer, { t: 'match_over', scores: h.snapshot.scores, view: viewFor(wouldDeal, 0) });
  h.matchId = id;
  h.sendTo(peer, { t: 'welcome', seat: 0, roomCode: h.roomCode, rules: h.rules as never, seats: h.seatInfo(), matchId: id, token: h.seats[0].token! });
}

describe('the end of a match is believed only when the verified hands say so', () => {
  it('a match_over with invented scores after hand 1 of 8 is refused and shown as a failure', () => {
    const { clock, hub, host, h } = table('MO1', 8);
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    playOut(host, c, clock);
    expect(c.state.auditStatus).toBe('ok');
    const real = c.state.view!.scores.slice();
    h.sendTo('p0', { t: 'match_over', scores: [-5000, 5000, 0, 0], view: { ...c.state.view!, scores: [-5000, 5000, 0, 0] } });
    expect(c.state.matchOver).toBe(false);
    expect(c.state.finalScores).toBeNull();
    expect(c.state.view!.scores).toEqual(real);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures.join(' ')).toContain('end of the match');
    expect(c.state.audits.map((a) => a.status)).toEqual(['ok', 'failed']);
    // Even the true scores do not end a match that has seven hands to go.
    h.sendTo('p0', { t: 'match_over', scores: real, view: c.state.view! });
    expect(c.state.matchOver).toBe(false);
    expect(c.state.audits).toHaveLength(2);
  });

  it('an honest end is accepted with the chained scores; the right moment with the wrong scores is not', () => {
    for (const forge of [false, true]) {
      const { clock, hub, host, h } = table(forge ? 'MO2F' : 'MO2', 1);
      const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
      c.join();
      host.start();
      let guard = 0;
      // A one-rotation match ends when the dealer passes on; a dealer who repeats plays again.
      while (host.phase !== 'match_over' && guard++ < 40) {
        playOut(host, c, clock);
        if (forge && !h.game!.result!.dealerContinues) {
          h.sendTo('p0', { t: 'match_over', scores: [9999, -3333, -3333, -3333], view: c.state.view! });
          break;
        }
        c.ready();
      }
      if (forge) {
        expect([c.state.matchOver, c.state.auditStatus]).toEqual([false, 'failed']);
      } else {
        expect(host.phase).toBe('match_over');
        expect(c.state.matchOver).toBe(true);
        expect(c.state.finalScores).toEqual(host.match().scores);
        expect(c.state.audits.every((a) => a.status === 'ok')).toBe(true);
      }
    }
  });

  it('after a verified end, a welcome for a new match starts a fresh record; before one it never does', () => {
    const { clock, hub, host, h } = table('MO3', 1);
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    let guard = 0;
    while (host.phase !== 'match_over' && guard++ < 40) {
      playOut(host, c, clock);
      if (guard === 1) {
        // Mid-match (the first result is on show): a new match id is refused and the seat stays pinned.
        h.sendTo('p0', { t: 'welcome', seat: 0, roomCode: h.roomCode, rules: h.rules as never, seats: h.seatInfo(), matchId: 'another', token: h.seats[0].token! });
        expect(c.state.matchId).toBe('m-MO3');
      }
      c.ready();
    }
    expect(c.state.matchOver).toBe(true);
    const held = c.state.audits.length;
    h.sendTo('p0', { t: 'welcome', seat: 2, roomCode: h.roomCode, rules: h.rules as never, seats: h.seatInfo(), matchId: 'next-match', token: h.seats[0].token! });
    expect([c.state.matchId, c.state.seat, c.state.matchOver]).toEqual(['next-match', 2, false]);
    expect(c.serialize().handsEnded).toEqual([]);
    expect(c.state.audits).toHaveLength(held);
  });

  it('a fake match_over and a welcome for a new match do not wipe the record: the re-dealt first hand fails', async () => {
    const { clock, hub, host, h } = table('MO4', 1);
    const rerolls = redealing(h, host, 2, (n, g) => {
      fakeNewMatch(h, `m-MO4-r${n}`, g);
      h.ceremonyHand = -1; // a fresh record: attempt 1 again, no restarts
      h.beginHand();
    });
    const c = new TableClient(transportLink(asyncPeer(hub, 'p0'), 'host'), 'Victim');
    c.join();
    await tick();
    host.start();
    for (let i = 0; i < 6; i++) await waitDealt(host);
    expect(rerolls()).toBe(2);
    expect(c.state.matchId).toBe('m-MO4');
    expect(c.state.matchOver).toBe(false);
    await playOutAsync(host, c, clock);
    expect(h.audits[0].ceremonyAttempts).toBe(1);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toEqual(expect.arrayContaining(['Host moved this seat into a different match mid-match', "Host ran attempt 1 of this hand's deal twice", 'The audit is for a different match than the one this seat is in']));
  });

  it('the same trick mid-match cannot hide a re-deal or a score rewrite between hands', async () => {
    const { clock, hub, host, h } = table('MO5', 8, { intermissionSeconds: 1 });
    const rerolls = redealing(
      h,
      host,
      1,
      (n, g) => {
        // Dock the victim 500 points, then pretend a new match begins.
        h.snapshot = { ...h.snapshot, scores: h.snapshot.scores.map((s, i) => (i === 0 ? s - 500 : i === 1 ? s + 500 : s)) };
        fakeNewMatch(h, `m-MO5-r${n}`, g);
        h.ceremonyHand = -1;
        h.beginHand();
      },
      (snap) => snap.handNumber === 1,
    );
    const c = new TableClient(transportLink(asyncPeer(hub, 'p0'), 'host'), 'Victim');
    c.join();
    await tick();
    host.start();
    await waitDealt(host);
    await playOutAsync(host, c, clock);
    expect(c.state.auditStatus).toBe('ok');
    c.ready();
    for (let i = 0; i < 6; i++) await waitDealt(host);
    expect(rerolls()).toBe(1);
    await playOutAsync(host, c, clock);
    expect(c.state.lastAudit!.handNumber).toBe(1);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toEqual(expect.arrayContaining(['Host moved this seat into a different match mid-match', 'Hand started with scores different from where the previous hand left them']));
  });
});

describe('hands follow one another without a jump', () => {
  it('a host that abandons the first hand after the player revealed and asks for the next number instead fails', async () => {
    const { clock, hub, host, h } = table('SK1', 1);
    const skips = redealing(h, host, 3, () => {
      h.snapshot = { ...h.snapshot, handNumber: h.snapshot.handNumber + 1 };
      h.ceremonyHand = -1;
      h.beginHand();
    });
    const c = new TableClient(transportLink(asyncPeer(hub, 'p0'), 'host'), 'Victim');
    c.join();
    await tick();
    host.start();
    for (let i = 0; i < 8; i++) await waitDealt(host);
    expect(skips()).toBe(3);
    await playOutAsync(host, c, clock);
    expect(h.audits[0]).toMatchObject({ handNumber: 3, ceremonyAttempts: 1, restarts: [] });
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('Host started another hand before the one in progress had ended');
  });

  it('a player seated from the lobby is dealt the first hand of a new match, whatever number the host gives it', () => {
    for (const fromLobby of [true, false]) {
      const { clock, hub, host, h } = table(fromLobby ? 'SK2' : 'SK2T', 8);
      // The host starts the match at "hand 5" with the scores already moved.
      h.snapshot = { ...h.snapshot, handNumber: 5, scores: [-900, 300, 300, 300] };
      // A client that holds only a token cannot know how the match began; one from the lobby can.
      const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, fromLobby ? {} : { token: 'f'.repeat(32) });
      c.join();
      host.start();
      playOut(host, c, clock);
      expect(c.state.lastAudit!.handNumber).toBe(5);
      if (fromLobby) expect([c.state.auditStatus, c.state.auditFailures]).toEqual(['failed', ['Host dealt a hand out of turn']]);
      else expect(c.state.auditStatus).not.toBe('failed');
    }
  });

  it('a seat changed in the lobby, before any deal, is not held against the host', () => {
    const { clock, hub, host, h } = table('SK3', 1);
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    expect(c.state.seat).toBe(0);
    // The lobby seat was given up and taken again (a reconnect in the lobby gets whichever seat is free).
    h.sendTo('p0', { t: 'welcome', seat: 2, roomCode: h.roomCode, rules: h.rules as never, seats: h.seatInfo(), matchId: h.matchId, token: 'a'.repeat(32) });
    expect(c.state.seat).toBe(2);
    h.sendTo('p0', { t: 'welcome', seat: 0, roomCode: h.roomCode, rules: h.rules as never, seats: h.seatInfo(), matchId: h.matchId, token: h.seats[0].token! });
    host.start();
    playOut(host, c, clock);
    expect([c.state.auditStatus, c.state.auditFailures]).toEqual(['ok', []]);
  });
});

describe('a verified hand keeps its result', () => {
  function played(code: string) {
    const t = table(code, 8);
    const c = new TableClient(transportLink(t.hub.create('p0'), 'host'), 'Victim');
    c.join();
    t.host.start();
    playOut(t.host, c, t.clock);
    expect(c.state.auditStatus).toBe('ok');
    return { ...t, c, audit: t.h.audits[0], view: c.state.view!, result: c.state.lastResult! };
  }

  it('an identical re-send (a returning seat) changes nothing', () => {
    const { h, c, clock, audit, view, result } = played('RS1');
    const before = c.state;
    h.sendTo('p0', { t: 'hand_over', result, audit, view, now: clock.now });
    expect(c.state.audits).toHaveLength(1);
    expect([c.state.auditStatus, c.state.view, c.state.lastResult, c.state.lastAudit]).toEqual([before.auditStatus, before.view, before.lastResult, before.lastAudit]);
  });

  it('a re-sent result with invented scores under the same audit is not shown, and fails', () => {
    const { h, c, clock, audit, view, result } = played('RS2');
    const forgedResult = { ...result, scoreDelta: [-999, 333, 333, 333], wins: [] };
    h.sendTo('p0', { t: 'hand_over', result: forgedResult, audit, view: { ...view, scores: [-999, 333, 333, 333], result: forgedResult }, now: clock.now });
    expect(c.state.view).toEqual(view);
    expect(c.state.lastResult).toEqual(result);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toEqual(['Host re-sent a different result for a hand it had already ended']);
    expect(c.state.audits.map((a) => a.status)).toEqual(['ok', 'failed']);
  });

  it('an audit carrying another match id never replaces the verified one', () => {
    const { h, c, clock, audit, view, result } = played('RS3');
    const forgedResult = { ...result, scoreDelta: [-999, 333, 333, 333], wins: [] };
    h.sendTo('p0', { t: 'hand_over', result: forgedResult, audit: { ...audit, matchId: 'not-this-match' }, view: { ...view, scores: [-999, 333, 333, 333], result: forgedResult }, now: clock.now });
    expect(c.state.lastAudit).toEqual(audit);
    expect(c.state.view).toEqual(view);
    expect(c.state.lastResult).toEqual(result);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toEqual(['Host re-sent a hand under a different match id']);
  });

  it('a first audit for a hand under another match id fails', () => {
    const { clock, hub, host, h } = table('RS4', 8);
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim');
    c.join();
    host.start();
    // The host files the hand under another match (its seed then cannot match either).
    const realId = h.matchId;
    let guard = 0;
    while (host.phase === 'playing' && guard++ < 4000) {
      const s = c.localState()!;
      if (legalActions(s, 0).length > 0) {
        if (s.wall.length - s.drawIndex < 30) h.matchId = 'elsewhere';
        c.act(chooseAction(s, 0, { seed: 'p' })!);
      } else {
        clock.now += 60_000;
        if (host.game && host.game.wall.length - host.game.drawIndex < 30) h.matchId = 'elsewhere';
        host.tick();
      }
    }
    h.matchId = realId;
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toContain('The audit is for a different match than the one this seat is in');
  });

  it('a state for a hand that has already ended is refused: the verified result stays on show', () => {
    const { h, c, clock, view, result } = played('RS5');
    const reopened = viewFor({ ...h.game!, phase: 'discard', result: undefined } as GameState, 0);
    h.sendTo('p0', { t: 'state', view: reopened, hash: 'x', deadline: null, timeBank: 0, inTimeBank: false, now: clock.now });
    expect(c.state.view).toEqual(view);
    expect(c.state.lastResult).toEqual(result);
    expect(c.state.auditStatus).toBe('failed');
    expect(c.state.auditFailures).toEqual(['Host went back to a hand that had already ended']);
  });
});
