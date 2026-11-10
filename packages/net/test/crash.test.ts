/**
 * A server that crashes restores each table from its last saved snapshot, which can be a moment
 * older than what the players were shown. The restored host says where it resumed; a client whose
 * link dropped drops what it had been shown beyond that point, and the hand is `partial` with the
 * caveat that the server restarted, never `ok` and never `failed`. Without the notice, without a
 * lost link, or a second time in one hand, turns played again are a rewind and fail as before.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type GameState, type MatchSnapshot } from '@mjm/engine';
import { AUDIT_CAVEATS, LoopbackHub, TableClient, TableHost, transportLink, type HostMessage, type Link, type SerializedHost } from '../src/index';

interface HostInternals {
  phase: string;
  game: GameState | null;
  snapshot: MatchSnapshot;
  seats: Array<{ seat: number; peerId: string | null }>;
  sendTo: (peerId: string, msg: HostMessage) => void;
  broadcastState: () => void;
  armClocks: () => void;
}
const internals = (host: TableHost) => host as unknown as HostInternals;

const RULES = withRules({ handsPerMatch: 8 });

function filtered(hub: LoopbackHub, id: string, deliver: (m: HostMessage) => HostMessage | null): Link {
  const base = transportLink(hub.create(id), 'host');
  return {
    ...base,
    onMessage: (cb) =>
      base.onMessage((m) => {
        const out = deliver(m);
        if (out) cb(out);
      }),
  };
}

function table(code: string) {
  const clock = { now: 1_000_000 };
  let hub = new LoopbackHub();
  const mk = (h: LoopbackHub, restore?: SerializedHost) => new TableHost(h.create('host'), { roomCode: code, rules: RULES, now: () => clock.now, matchId: `m-${code}`, intermissionSeconds: 5, restore });
  let gen = 0;
  const t = {
    clock,
    host: mk(hub),
    /** The players make other moves than they would have (set once turns are being played again). */
    vary: false,
    a: null as unknown as TableClient,
    b: null as unknown as TableClient,
    snap(): SerializedHost {
      return JSON.parse(JSON.stringify(t.host.serialize())) as SerializedHost;
    },
    /** One move by a human, or the clock moves on. */
    step() {
      const host = t.host;
      if (host.phase === 'playing') {
        for (const c of [t.a, t.b]) {
          const s = c.localState();
          const seat = c.state.seat!;
          if (s && c.state.connected && s.handNumber === host.game!.handNumber && s.turnCounter === host.game!.turnCounter && legalActions(s, seat).length > 0) {
            const usual = chooseAction(s, seat, { seed: 'p' })!;
            // After a restart the players do not make the same moves again.
            const other = t.vary && usual.type === 'discard' ? legalActions(s, seat).find((x) => x.type === 'discard' && x.tile !== usual.tile) : undefined;
            c.act(other ?? usual);
            return;
          }
        }
      }
      if (host.phase === 'hand_over') for (const c of [t.a, t.b]) c.ready();
      clock.now += host.phase === 'playing' ? 60_000 : 6_000;
      host.tick();
    },
    until(done: () => boolean) {
      let guard = 0;
      while (!done() && guard++ < 20_000) t.step();
      expect(done()).toBe(true);
    },
    /** The process dies and a new one restores the table from `snapshot`; both players reconnect. */
    crash(snapshot: SerializedHost, deliver: (m: HostMessage) => HostMessage | null = (m) => m) {
      t.host.close();
      hub = new LoopbackHub();
      t.host = mk(hub, snapshot);
      gen++;
      t.vary = true;
      for (const [c, id] of [
        [t.a, 'pA'],
        [t.b, 'pB'],
      ] as const) {
        c.rebind(filtered(hub, `${id}${gen}`, deliver));
        c.join();
      }
    },
  };
  t.a = new TableClient(transportLink(hub.create('pA'), 'host'), 'A', undefined, {}, { now: () => clock.now });
  t.b = new TableClient(transportLink(hub.create('pB'), 'host'), 'B', undefined, {}, { now: () => clock.now });
  t.a.join();
  t.b.join();
  t.host.start();
  return t;
}

type T = ReturnType<typeof table>;
const hand = (t: T) => internals(t.host).snapshot.handNumber;
const turn = (t: T) => t.host.game?.turnCounter ?? 0;
const playing = (t: T, h: number, tc = 0) => hand(t) === h && t.host.phase === 'playing' && turn(t) >= tc;
/**
 * A human is about to discard: a snapshot taken here is followed by a move the player will not
 * repeat after a restart, so the turns played again are sure to differ from the ones first seen.
 */
const humanToDiscard = (t: T, h: number, tc: number) => {
  const g = t.host.game;
  return playing(t, h, tc) && !!g && g.phase === 'discard' && [t.a.state.seat, t.b.state.seat].includes(g.turn) && t.a.state.view?.turnCounter === g.turnCounter;
};
const last = (c: TableClient) => c.state.audits[c.state.audits.length - 1];
const summary = (c: TableClient) => c.state.audits.map((x) => `${x.audit.handNumber}:${x.status}`).join(' ');

describe('a server crash in the middle of a hand', () => {
  it('turns played again after the restart make the hand partial for every player, with the reason, never failed', () => {
    const t = table('CR1');
    t.until(() => humanToDiscard(t, 0, 10));
    const saved = t.snap();
    t.until(() => playing(t, 0, saved.game!.turnCounter + 5));
    t.crash(saved);
    t.until(() => playing(t, 1));
    for (const c of [t.a, t.b]) {
      expect([last(c).status, last(c).failures]).toEqual(['partial', []]);
      expect(last(c).caveats).toEqual([AUDIT_CAVEATS.serverRestart]);
    }
    // The next hand is watched whole again.
    t.until(() => playing(t, 2));
    expect([summary(t.a), summary(t.b)]).toEqual(['0:partial 1:ok', '0:partial 1:ok']);
  });

  it('an orderly restart that lost nothing keeps the hand verified', () => {
    const t = table('CR2');
    t.until(() => playing(t, 0, 12));
    t.crash(t.snap());
    t.until(() => playing(t, 1));
    for (const c of [t.a, t.b]) expect([last(c).status, last(c).failures, last(c).caveats]).toEqual(['ok', [], []]);
  });

  it('the same turns played again with no notice from the host fail, as any rewind does', () => {
    const t = table('CR3');
    t.until(() => humanToDiscard(t, 0, 10));
    const saved = t.snap();
    t.until(() => playing(t, 0, saved.game!.turnCounter + 5));
    t.crash(saved, (m) => (m.t === 'restored' ? null : m));
    t.until(() => playing(t, 1));
    expect(last(t.a).status).toBe('failed');
    expect(last(t.a).failures.join(' ')).toContain('two different states');
  });

  it('a "restart" announced over a link that never dropped does not excuse a rewind', () => {
    const t = table('CR4');
    t.until(() => humanToDiscard(t, 0, 10));
    const h = internals(t.host);
    const earlier = structuredClone(t.host.game!);
    t.until(() => playing(t, 0, earlier.turnCounter + 5));
    // The host announces a restart to the players it is still connected to, and goes back five turns.
    for (const s of h.seats) if (s.peerId && !s.peerId.startsWith('gone-')) h.sendTo(s.peerId, { t: 'restored', handNumber: 0, turnCounter: earlier.turnCounter });
    t.host.game = earlier;
    t.vary = true;
    h.armClocks();
    h.broadcastState();
    t.until(() => playing(t, 1));
    expect(last(t.a).status).toBe('failed');
    expect(last(t.a).failures.join(' ')).toContain('two different states');
  });

  it('a second restart of the same hand fails it', () => {
    const t = table('CR5');
    t.until(() => humanToDiscard(t, 0, 8));
    const first = t.snap();
    t.until(() => playing(t, 0, first.game!.turnCounter + 4));
    t.crash(first);
    t.until(() => humanToDiscard(t, 0, first.game!.turnCounter + 6));
    const second = t.snap();
    t.until(() => playing(t, 0, second.game!.turnCounter + 4));
    t.crash(second);
    t.until(() => playing(t, 1));
    expect(last(t.a).status).toBe('failed');
    expect(last(t.a).failures).toContain('Host said it restarted this hand more than once');
  });
});

describe('a server crash around a deal', () => {
  it('a snapshot from the result screen, with the next hand already dealt and under way: that hand is dealt again and is partial, not failed', () => {
    const t = table('CR6');
    t.until(() => hand(t) === 0 && t.host.phase === 'hand_over');
    const saved = t.snap();
    t.until(() => playing(t, 1, 6));
    t.crash(saved);
    expect(t.host.phase).toBe('hand_over');
    t.until(() => playing(t, 2));
    for (const c of [t.a, t.b]) {
      expect(summary(c)).toBe('0:ok 1:partial');
      expect(last(c).failures).toEqual([]);
      expect(last(c).caveats).toContain(AUDIT_CAVEATS.serverRestart);
    }
  });

  it('a snapshot from the result screen with nothing of the next hand seen yet: the next hand is verified as usual', () => {
    const t = table('CR7');
    t.until(() => hand(t) === 0 && t.host.phase === 'hand_over');
    t.crash(t.snap());
    t.until(() => playing(t, 2));
    for (const c of [t.a, t.b]) expect(summary(c)).toBe('0:ok 1:ok');
  });

  it('a snapshot from the middle of the ceremony, with the hand since dealt and under way: dealt again, partial, not failed', () => {
    const t = table('CR8');
    t.until(() => hand(t) === 0 && t.host.phase === 'hand_over');
    // Snapshot taken while hand 1's shares were being collected (the host waits for a held commitment).
    const h = internals(t.host);
    const origSend = h.sendTo.bind(t.host);
    let saved: SerializedHost | null = null;
    h.sendTo = (peer, msg) => {
      if (msg.t === 'commit_request' && msg.handNumber === 1 && !saved) saved = t.snap();
      origSend(peer, msg);
    };
    t.until(() => playing(t, 1, 6));
    expect(saved).not.toBeNull();
    expect(saved!.phase).toBe('commit');
    t.crash(saved!);
    t.until(() => playing(t, 2));
    for (const c of [t.a, t.b]) {
      expect(summary(c)).toBe('0:ok 1:partial');
      expect(last(c).failures).toEqual([]);
      expect(last(c).caveats).toEqual(expect.arrayContaining([AUDIT_CAVEATS.serverRestart, AUDIT_CAVEATS.restarted]));
    }
  });
});
