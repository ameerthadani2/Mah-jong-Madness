/**
 * A player whose link is down while the table plays on. An honest host re-sends the audits of the
 * hands the seat missed when it returns; the client checks each one as far as an absent device
 * can, marks it `partial`, and carries its record of the match forward. Missing hands are never a
 * failure by themselves; records that do not add up are.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type GameState, type MatchSnapshot } from '@mjm/engine';
import { AUDIT_CAVEATS, LoopbackHub, TableClient, TableHost, transportLink, type Audit, type HostMessage, type Link } from '../src/index';
import { Missed, scenario, seededDeals } from './support';

seededDeals();

/** A test on a fresh deal, dealt again when the situation it waits for does not come up. */
const deal = (name: string, fn: () => void) => it(name, () => scenario(fn));

interface HostInternals {
  phase: string;
  game: GameState | null;
  snapshot: MatchSnapshot;
  audits: Audit[];
  seats: Array<{ seat: number; peerId: string | null }>;
  sendTo: (peerId: string, msg: HostMessage) => void;
}
const internals = (host: TableHost) => host as unknown as HostInternals;

/** A link the test can cut. `deliver` may drop or rewrite frames from the host. */
function droppable(hub: LoopbackHub, id: string, deliver: (m: HostMessage) => HostMessage | null = (m) => m) {
  const t = hub.create(id);
  const closers = new Set<() => void>();
  const base = transportLink(t, 'host');
  const link: Link = {
    ...base,
    onMessage: (cb) =>
      base.onMessage((m) => {
        const out = deliver(m);
        if (out) cb(out);
      }),
    onClose: (cb) => {
      closers.add(cb);
      return () => closers.delete(cb);
    },
  };
  return {
    link,
    drop: () => {
      t.close();
      for (const cb of [...closers]) cb();
    },
  };
}

interface Table {
  clock: { now: number };
  hub: LoopbackHub;
  host: TableHost;
  h: HostInternals;
  a: TableClient;
  b: TableClient;
  aLink: ReturnType<typeof droppable>;
  aUp: boolean;
  /** One move by a linked human, or the clock moves on (the result screen is confirmed after a pause). */
  step(): void;
  until(done: () => boolean): void;
  leave(): void;
  back(mode: 'rebind' | 'restore', deliver?: (m: HostMessage) => HostMessage | null): void;
}

function table(code: string, hands = 8): Table {
  const clock = { now: 1_000_000 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: withRules({ handsPerMatch: hands }), now: () => clock.now, matchId: `m-${code}`, intermissionSeconds: 5 });
  const opts = { now: () => clock.now };
  const aLink = droppable(hub, 'pA');
  let n = 0;
  const t: Table = {
    clock,
    hub,
    host,
    h: internals(host),
    a: new TableClient(aLink.link, 'A', undefined, {}, opts),
    b: new TableClient(transportLink(hub.create('pB'), 'host'), 'B', undefined, {}, opts),
    aLink,
    aUp: true,
    step() {
      const linked = t.aUp ? [t.a, t.b] : [t.b];
      if (host.phase === 'playing') {
        for (const c of linked) {
          const s = c.localState();
          const seat = c.state.seat!;
          if (s && s.handNumber === host.game!.handNumber && legalActions(s, seat).length > 0) {
            c.act(chooseAction(s, seat, { seed: 'p' })!);
            return;
          }
        }
      }
      if (host.phase === 'hand_over') for (const c of linked) c.ready();
      clock.now += host.phase === 'playing' ? 60_000 : 6_000;
      host.tick();
    },
    until(done) {
      let guard = 0;
      while (!done() && guard++ < 20_000) {
        if (host.phase === 'match_over') throw new Missed();
        t.step();
      }
      if (!done()) throw new Missed();
    },
    leave() {
      t.aLink.drop();
      t.aUp = false;
    },
    back(mode, deliver) {
      t.aLink = droppable(hub, `pA${++n}`, deliver);
      if (mode === 'rebind') t.a.rebind(t.aLink.link);
      else {
        const saved = JSON.parse(JSON.stringify(t.a.serialize()));
        t.a = TableClient.restore(saved, t.aLink.link, 'A', undefined, { token: saved.state.token }, opts);
      }
      t.a.join();
      t.aUp = true;
    },
  };
  t.a.join();
  t.b.join();
  host.start();
  return t;
}

const handNow = (t: Table) => t.h.snapshot.handNumber;
const summary = (c: TableClient) => c.state.audits.map((x) => `${x.audit.handNumber}:${x.status}`).join(' ');
const failuresOf = (c: TableClient) => c.state.audits.flatMap((x) => x.failures);

describe('an honest host and a player who misses hands', () => {
  for (const mode of ['rebind', 'restore'] as const) {
    deal(`away from the middle of one hand to the middle of the next (${mode}): the missed hand is checked from its audit, nothing fails`, () => {
      const t = table(`AW1${mode}`);
      t.until(() => handNow(t) === 1 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 6);
      t.leave();
      t.until(() => handNow(t) === 2 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 4);
      t.back(mode);
      t.until(() => handNow(t) === 4 && t.host.phase === 'playing');
      expect(summary(t.a)).toBe('0:ok 1:partial 2:partial 3:ok');
      expect(failuresOf(t.a)).toEqual([]);
      expect(t.a.state.audits[1].caveats).toEqual([AUDIT_CAVEATS.away]);
      expect(t.a.state.audits[2].caveats).toContain(AUDIT_CAVEATS.standIn);
      expect(t.b.state.audits.every((x) => x.status === 'ok')).toBe(true);
    });
  }

  deal('away across several hands, returning while a result is on show', () => {
    const t = table('AW2');
    t.until(() => handNow(t) === 0 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 3);
    t.leave();
    // B stops confirming once hand 3 has ended, so the table waits on its result screen.
    t.until(() => handNow(t) === 3 && t.host.phase === 'hand_over');
    t.back('rebind');
    expect(t.host.phase).toBe('hand_over');
    t.until(() => handNow(t) === 5 && t.host.phase === 'playing');
    expect(summary(t.a)).toBe('0:partial 1:partial 2:partial 3:partial 4:ok');
    expect(failuresOf(t.a)).toEqual([]);
    for (const i of [0, 1, 2]) expect(t.a.state.audits[i].caveats).toContain(AUDIT_CAVEATS.away);
  });

  deal('away until after the match ended: every missed hand is checked and the final scores are verified', () => {
    const t = table('AW3', 1);
    t.until(() => t.host.phase === 'playing' && t.host.game!.turnCounter >= 5);
    t.leave();
    t.until(() => t.host.phase === 'match_over');
    t.back('restore');
    expect(t.a.state.matchOver).toBe(true);
    expect(t.a.state.finalScores).toEqual(t.host.match().scores);
    expect(t.a.state.audits).toHaveLength(t.h.audits.length);
    expect(t.a.state.audits.every((x) => x.status === 'partial')).toBe(true);
    expect(failuresOf(t.a)).toEqual([]);
    // The end was verified from the chain, so a new match at this table may start a fresh record.
    expect((t.a.serialize() as unknown as { matchEnded: boolean }).matchEnded).toBe(true);
  });

  deal('a host that sends no records of the missed hands leaves a gap: a caveat on the next hand, never a failure', () => {
    const t = table('AW4');
    t.until(() => handNow(t) === 1 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 6);
    t.leave();
    t.until(() => handNow(t) === 3 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 4);
    t.back('rebind', (m) => (m.t === 'hand_missed' ? null : m));
    t.until(() => handNow(t) === 5 && t.host.phase === 'playing');
    expect(summary(t.a)).toBe('0:ok 3:partial 4:ok');
    expect(failuresOf(t.a)).toEqual([]);
    expect(t.a.state.audits[1].caveats).toContain(AUDIT_CAVEATS.gap);
  });

  deal('final scores that rest on such a gap are not shown as verified, although the end of the match is', () => {
    const t = table('AW5', 4);
    t.until(() => handNow(t) === 1 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 6);
    t.leave();
    t.until(() => handNow(t) === 3 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 4);
    t.back('rebind', (m) => (m.t === 'hand_missed' ? null : m));
    t.until(() => t.host.phase === 'match_over');
    expect(t.a.state.matchOver).toBe(true);
    expect(failuresOf(t.a)).toEqual([]);
    expect(t.a.state.audits.some((x) => x.caveats.includes(AUDIT_CAVEATS.gap))).toBe(true);
    // The hands after the gap chain from it and say the match is over, so a new match may start a fresh record...
    expect((t.a.serialize() as unknown as { matchEnded: boolean }).matchEnded).toBe(true);
    // ...but the scores the gap hand started from were never checked, and every later score rests on them.
    expect(t.a.state.matchEndVerified).toBe(false);
    // The same after the app restarts on the final screen.
    const saved = JSON.parse(JSON.stringify(t.a.serialize()));
    const again = TableClient.restore(saved, droppable(t.hub, 'pAz').link, 'A', undefined, { token: saved.state.token }, { now: () => t.clock.now });
    expect([again.state.matchOver, again.state.matchEndVerified]).toEqual([true, false]);
  });

  deal('with no gap the final scores are shown as verified', () => {
    const t = table('AW6', 2);
    t.until(() => t.host.phase === 'match_over');
    expect(failuresOf(t.a)).toEqual([]);
    expect([t.a.state.matchOver, t.a.state.matchEndVerified]).toEqual([true, true]);
  });
});

describe('a dishonest gap still fails', () => {
  /** A leaves in hand 1 and returns in hand 2; `deliver` is what the host does to its frames on return. */
  function awayOneHand(code: string, deliver: (t: Table) => (m: HostMessage) => HostMessage | null, between?: (t: Table) => void) {
    const t = table(code);
    t.until(() => handNow(t) === 1 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 6);
    t.leave();
    t.until(() => handNow(t) === 1 && t.host.phase === 'hand_over');
    between?.(t);
    t.until(() => handNow(t) === 2 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 4);
    t.back('rebind', deliver(t));
    t.until(() => handNow(t) === 3 && t.host.phase === 'playing');
    return t;
  }

  deal('scores that do not follow from the missed hand fail the hand on the table', () => {
    const t = awayOneHand(
      'DG1',
      () => (m) => m,
      (t) => {
        // The host docks A while it is away; the audit of the missed hand cannot hide it.
        const orig = (t.host as unknown as { beginHand: (...a: unknown[]) => void }).beginHand.bind(t.host);
        let done = false;
        (t.host as unknown as { beginHand: (...a: unknown[]) => void }).beginHand = (...args) => {
          if (!done && t.h.snapshot.handNumber === 2) {
            done = true;
            t.h.snapshot = { ...t.h.snapshot, scores: t.h.snapshot.scores.map((s, i) => (i === 0 ? s - 500 : i === 1 ? s + 500 : s)) };
          }
          orig(...args);
        };
      },
    );
    expect(summary(t.a)).toBe('0:ok 1:partial 2:failed');
    expect(t.a.state.audits[2].failures).toContain('Hand started with scores different from where the previous hand left them');
  });

  deal('a missed hand whose record does not replay fails, and so does the hand on the table', () => {
    const t = awayOneHand('DG2', () => (m) => (m.t === 'hand_missed' ? { ...m, audit: { ...m.audit, log: m.audit.log.slice(0, -1) } } : m));
    expect(summary(t.a)).toBe('0:ok 1:failed 2:failed');
    expect(t.a.state.audits[1].failures.join(' ')).toMatch(/Replay|final state/);
    expect(t.a.state.audits[2].failures).toContain('The record of hand 2, played while this device was away, failed its checks');
  });

  deal('a missed hand dealt from a seed the shares do not give fails', () => {
    const t = awayOneHand('DG3', (t) => (m) => (m.t === 'hand_missed' ? { ...m, audit: { ...m.audit, reveals: m.audit.reveals.map((r) => (r.seat === 4 ? { ...r, secret: t.h.audits[0].reveals[4].secret } : r)) } } : m));
    expect(t.a.state.audits[1].status).toBe('failed');
    expect(t.a.state.audits[1].failures).toEqual(expect.arrayContaining(['Reveals do not match commitments for seats 4', 'Seed was not derived from the revealed secrets']));
    expect(t.a.state.audits[2].status).toBe('failed');
  });

  deal('records that skip a hand do not chain, and the hand on the table fails', () => {
    const t = table('DG4');
    t.until(() => handNow(t) === 1 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 6);
    t.leave();
    t.until(() => handNow(t) === 3 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 4);
    // The host shows hand 2's record but not hand 1's.
    t.back('rebind', (m) => (m.t === 'hand_missed' && m.audit.handNumber === 1 ? null : m));
    t.until(() => handNow(t) === 4 && t.host.phase === 'playing');
    expect(summary(t.a)).toBe('0:ok 3:failed');
    expect(t.a.state.audits[1].failures).toContain('The record of the hands this device missed does not follow from the last hand it verified');
  });

  deal('a hand reported as missed to a player who never left is refused: the play checks cannot be dodged', () => {
    const t = table('DG5');
    t.until(() => handNow(t) === 0 && t.host.phase === 'playing' && t.host.game!.turnCounter >= 6);
    // The table plays hand 0 out for A (as if it were away) and files the result as a missed hand.
    const seatA = t.a.state.seat!;
    const peerA = t.h.seats[seatA].peerId!;
    const origSend = t.h.sendTo.bind(t.host);
    t.h.sendTo = (peer, msg) => {
      if (peer === peerA && msg.t === 'hand_over' && msg.audit.handNumber === 0) origSend(peer, { t: 'hand_missed', audit: msg.audit });
      else origSend(peer, msg);
    };
    t.until(() => handNow(t) === 1 && t.host.phase === 'playing');
    expect(t.a.state.auditStatus).toBe('failed');
    t.until(() => handNow(t) === 2 && t.host.phase === 'playing');
    expect(summary(t.a)).toBe('1:failed');
    expect(failuresOf(t.a)).toEqual(expect.arrayContaining(['Host reported a hand as missed although this device was connected throughout', 'Host started another hand before the one in progress had ended']));
  });
});
