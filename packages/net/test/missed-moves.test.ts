/**
 * Hands a device missed altogether (`hand_missed`) while the table played on. Every move credited
 * to its seat there was made without it: whatever the log calls it, it is judged as a table move
 * (its rule, and the device's own time away), and the end of the match is not shown as verified
 * while any missed hand carries one.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules } from '@mjm/engine';
import { AUDIT_CAVEATS, failureKey, LoopbackHub, TableClient, TableHost, transportLink, type Link } from '../src/index';
import { seededDeals } from './support';

seededDeals();

const RULES = withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 });
let links = 0;

type Source = 'player' | 'bot' | 'timeout' | 'auto';
interface Server {
  apply: (seat: number, action: NonNullable<ReturnType<typeof chooseAction>>, source: Source) => void;
  afterHand: () => void;
}

/** One human at seat 0 and three bots, on one clock; the server may stamp its frames `ahead`. */
function seat(code: string) {
  const clock = { now: 1_000_000, ahead: 0 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, now: () => clock.now + clock.ahead, matchId: `m-${code}`, intermissionSeconds: 5 });
  const opts = { now: () => clock.now };
  let c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, opts);
  c.join();
  host.start();
  const t = {
    clock,
    host,
    get c() {
      return c;
    },
    s: host as unknown as Server,
    owes: () => host.phase === 'playing' && !!c.localState() && legalActions(c.localState()!, 0).length > 0,
    /** The seat plays its own moves to the end of the hand. */
    finish: () => {
      for (let guard = 0; guard < 6000 && host.phase === 'playing'; guard++) {
        if (t.owes()) c.act(chooseAction(c.localState()!, 0, { seed: 'p' })!);
        else {
          clock.now += 60_000;
          host.tick();
        }
      }
      expect(host.phase).not.toBe('playing');
    },
    drop: () => (c as unknown as { link: Link }).link.close(),
    /** The server plays the rest of the match: `device` ms pass on the device for each minute on the server. */
    playOut: (device: number) => {
      for (let guard = 0; guard < 20_000 && host.phase !== 'match_over'; guard++) {
        if (host.phase === 'hand_over') t.s.afterHand();
        else {
          clock.now += device;
          clock.ahead += 60_000 - device;
          host.tick();
        }
      }
      expect(host.phase).toBe('match_over');
    },
    back: () => {
      c.rebind(transportLink(hub.create(`p0r${links++}`), 'host'));
      c.join();
    },
    restore: () => {
      const saved = JSON.parse(JSON.stringify(c.serialize()));
      c = TableClient.restore(saved, transportLink(hub.create(`p0r${links++}`), 'host'), 'Victim', undefined, { token: saved.state.token }, opts);
    },
    missed: () => c.state.audits.filter((a) => a.caveats.includes(AUDIT_CAVEATS.away)),
  };
  return t;
}

/** The server writes the seat's moves down as the player's own. */
function creditToPlayer(t: ReturnType<typeof seat>) {
  const apply = t.s.apply.bind(t.host);
  t.s.apply = (s, a, src) => apply(s, a, s === 0 ? 'player' : src);
}

describe('moves credited to the seat in hands this device missed', () => {
  it('the rest of a match inside a two-second drop, with the seat’s moves written down as the player’s own, fails and the end is not verified', () => {
    const t = seat('MM1');
    t.finish();
    expect([t.c.state.auditStatus, t.c.state.auditFailures]).toEqual(['ok', []]);
    t.drop();
    creditToPlayer(t);
    // Two seconds on the device for the whole of the next hand.
    t.playOut(0);
    t.clock.now += 2_000;
    t.back();
    const missed = t.missed();
    expect(missed.length).toBeGreaterThan(0);
    for (const a of missed) {
      expect(a.status).toBe('failed');
      expect(a.failures.map(failureKey)).toContain('playedWhileDown');
    }
    expect(t.c.state.matchOver).toBe(true);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.matchEndVerified).toBe(false);
  });

  it('honest: away for longer than the clock, the table plays the seat; the missed hand is amber and the end is not shown as verified', () => {
    const t = seat('MM2');
    t.finish();
    t.drop();
    t.playOut(60_000);
    t.back();
    const missed = t.missed();
    expect(missed.length).toBeGreaterThan(0);
    for (const a of missed) expect([a.status, a.failures]).toEqual(['partial', []]);
    expect(missed.some((a) => a.caveats.includes(AUDIT_CAVEATS.tableMoved))).toBe(true);
    expect(t.c.state.matchOver).toBe(true);
    expect(t.c.state.matchEndVerified).toBe(false);
    // And it stays so across an app restart.
    t.restore();
    expect(t.c.state.matchEndVerified).toBe(false);
  });

  it('the same honest moves written down as the player’s own are still judged as the table’s: amber, with the reason', () => {
    const t = seat('MM3');
    t.finish();
    t.drop();
    creditToPlayer(t);
    t.playOut(60_000);
    t.back();
    const missed = t.missed();
    expect(missed.length).toBeGreaterThan(0);
    for (const a of missed) expect([a.status, a.failures]).toEqual(['partial', []]);
    expect(missed.some((a) => a.caveats.includes(AUDIT_CAVEATS.tableMoved))).toBe(true);
    expect(t.c.state.matchEndVerified).toBe(false);
  });

  it('a move written down as the player’s own that the table’s rule would not play fails the missed hand', () => {
    const t = seat('MM4');
    t.finish();
    t.drop();
    // A server that picks the seat's discards itself (the last legal move, not the rule's) and calls them the player's.
    const apply = t.s.apply.bind(t.host);
    let swapped = 0;
    t.s.apply = (s, a, src) => {
      if (s !== 0) return apply(s, a, src);
      const g = t.host.game!;
      const options = legalActions(g, 0).filter((x) => x.type === 'discard');
      const other = options.find((x) => JSON.stringify(x) !== JSON.stringify(a));
      if (other && g.phase === 'discard') {
        swapped++;
        return apply(s, other, 'player');
      }
      return apply(s, a, 'player');
    };
    t.playOut(60_000);
    t.back();
    expect(swapped).toBeGreaterThan(0);
    const missed = t.missed();
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.some((a) => a.status === 'failed')).toBe(true);
    expect(missed.flatMap((a) => a.failures).join('\n')).toMatch(/The table played for this seat a move other than the one its published rule gives/);
    expect(t.c.state.matchEndVerified).toBe(false);
  });

  it('honest: a match the device watched to the end is verified', () => {
    const t = seat('MM5');
    for (let guard = 0; guard < 50 && t.host.phase !== 'match_over'; guard++) {
      if (t.host.phase === 'hand_over') t.s.afterHand();
      else t.finish();
    }
    expect(t.c.state.matchOver).toBe(true);
    expect(t.c.state.auditStatus).toBe('ok');
    expect(t.c.state.matchEndVerified).toBe(true);
  });
});
