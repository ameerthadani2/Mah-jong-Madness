/**
 * A move is answered honestly, or it is unanswered.
 *
 * An honest host answers a seated player's move by playing it (its next state shows the move) or by a refusal that names
 * the turn the move was made on (`illegal`, `not_playing`, `wrong_seat`), in the order the moves came. It welcomes a link
 * before it sends anything about the table on it, and sends nothing about the table on a link it took the seat away on
 * (`evicted`). So a legal move that the table neither played nor refused with its turn, followed on the same link by
 * another move of the seat that the table played at that turn, fails the hand (`moveDropped`), whatever the server sent
 * back in between; and a frame about the table on a link where the phone holds no seat fails it too (`unseatedFrame`).
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { isInt } from '../src/clientrecords';
import { failureKey, LoopbackHub, TableClient, TableHost, transportLink, type HostMessage, type Link } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { timeoutAction(g: GameState, seat: number): Action };
/** The seat's own moves in the hand so far. */
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;
/** The state the host sends is the one that shows the seat its third discard turn (its own turn, not a claim). */
const thirdDue = (w: Wire, m: Extract<HostMessage, { t: 'state' }>) =>
  !!w.host.game && w.owes() && mine(w) >= 2 && w.host.game.turnCounter === m.view.turnCounter && legalActions(w.host.game, 0).every((a) => a.type === 'discard');

type Answer = 'busy' | 'zzz' | 'turnBefore' | 'notSeatedTurn' | 'evicted' | 'silent' | 'refused' | 'none' | 'late1' | 'late2';

/**
 * Normal. On the seat's third discard turn its move is dropped on its way (the table never sees it) and the server
 * answers it: an error with an unknown code (`busy`, `zzz`), a refusal naming the turn before (`turnBefore`), `not_seated`
 * with the move's turn (`notSeatedTurn`), an `evicted` frame and then `not_seated` (`evicted`), nothing (`silent`), or a
 * refusal naming the move's turn (`refused`, the control); `none` drops nothing. The seat, its move gone nowhere, makes
 * another legal discard at that turn 2 s later, and the table plays that one. `late1`, `late2`: the move is answered
 * `busy`, and right behind the state that shows the other discard played the server sends one or two refusals naming
 * the turn (out of order: they come after the state showing a later move of the link).
 */
function droppedThenOwn(code: string, answer: Answer) {
  let target: number | null = null;
  let first: Action | null = null;
  let second = false;
  let sentAt = 0;
  let late = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? Infinity : 600),
    after: (m) => {
      if ((answer !== 'late1' && answer !== 'late2') || late || !second || target === null || m.t !== 'state' || m.view.turnCounter <= target) return [];
      late = true;
      const refusal = { t: 'error', code: 'illegal', message: 'That move is not allowed now.', turnCounter: target } as HostMessage;
      return answer === 'late2' ? [refusal, refusal] : [refusal];
    },
    onTick: (w) => {
      const g = w.host.game;
      if (!g || target === null || g.turnCounter !== target || w.host.phase !== 'playing' || !w.current()) return;
      if (first === null) {
        // The seat makes the move the table's timeout rule would not, a second after it was shown the turn.
        if (w.clock.now - (w.shown.get(target) ?? Infinity) < 1_000) return;
        const timeout = host(w).timeoutAction(g, 0);
        const move = legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
        if (!move) return;
        sentAt = w.clock.now;
        w.c.act(move);
        if (answer === 'none') second = true;
        return;
      }
      if (second || w.clock.now - sentAt < 2_000) return;
      const other = legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, first as Action, g, 0));
      if (!other) return;
      second = true;
      w.c.act(other);
    },
    map: (m, w) => {
      if (target === null && m.t === 'state' && thirdDue(w, m)) target = m.view.turnCounter;
      return m;
    },
    upFilter: (m, w) => {
      if (answer === 'none' || m.t !== 'action' || target === null || m.turnCounter !== target || first !== null) return true;
      first = m.action;
      const tc = m.turnCounter as number;
      const say = (x: Record<string, unknown>) => w.line.inject({ t: 'error', message: 'That move is not allowed now.', ...x } as HostMessage);
      if (answer === 'busy' || answer === 'zzz' || answer === 'late1' || answer === 'late2') say({ code: answer === 'zzz' ? 'zzz' : 'busy' });
      if (answer === 'turnBefore') say({ code: 'illegal', turnCounter: tc - 1 });
      if (answer === 'notSeatedTurn') say({ code: 'not_seated', turnCounter: tc });
      if (answer === 'refused') say({ code: 'illegal', turnCounter: tc });
      if (answer === 'evicted') {
        say({ code: 'evicted' });
        say({ code: 'not_seated' });
      }
      return false;
    },
  });
  w.finish();
  const entry = target === null ? undefined : w.c.state.lastAudit?.log.find((e) => e.seat === 0 && e.n === target);
  return { w, dropped: first !== null, late, attacked: first !== null && second && !!entry && entry.source === 'player' && JSON.stringify(entry.action) !== JSON.stringify(first) };
}

describe('a move the table neither played nor refused with its turn, then another of the seat’s played in its place', () => {
  it.each([
    ['busy', ['moveDropped']],
    ['zzz', ['moveDropped']],
    ['turnBefore', ['moveDropped']],
    // (On the connection the table seated the phone on, "not seated" fails the hand of itself, `seatDenied`.)
    ['notSeatedTurn', ['seatDenied', 'moveDropped']],
    ['silent', ['moveDropped']],
  ] as const)('answered %s: red, the move was left unanswered (it was once green)', (answer, failures) =>
    scenario((i) => {
      const a = droppedThenOwn(`AM${answer}${i}`, answer);
      need(a.attacked);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures });
    }),
  );

  it('controls: refused naming its turn while legal, red as it always was (a legal move refused); nothing dropped, green', () =>
    scenario((i) => {
      const a = droppedThenOwn(`AMR${i}`, 'refused');
      need(a.attacked);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['legalMoveRefused'] });
      const b = droppedThenOwn(`AMN${i}`, 'none');
      need(b.w.c.state.lastAudit !== null);
      expect(b.w.verdict().status).toBe('ok');
    }));
});

describe('answers come in order', () => {
  it.each(['late2', 'late1'] as const)('refusals naming the turn that come after the state showing the other move played (%s): red, they answer nothing (two of them once made the hand green)', (answer) =>
    scenario((i) => {
      const a = droppedThenOwn(`AMO${answer}${i}`, answer);
      need(a.attacked && a.late);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveDropped'] });
    }),
  );

  it('honest: two moves on the same turn, the first played and the second refused in order (it came after): green', () =>
    scenario((i) => {
      let target: number | null = null;
      let done = false;
      const w = wire({
        code: `AMD${i}`,
        rules: NORMAL,
        botDelayMs: 700,
        think: (_k, tc) => (tc === target ? Infinity : 600),
        map: (m, w) => {
          if (target === null && m.t === 'state' && thirdDue(w, m)) target = m.view.turnCounter;
          return m;
        },
        onTick: (w) => {
          const g = w.host.game;
          if (done || !g || target === null || g.turnCounter !== target || !w.current() || w.clock.now - (w.shown.get(target) ?? Infinity) < 1_000) return;
          const [a, b] = legalActions(g, 0).filter((x) => x.type === 'discard');
          if (!a || !b || sameAction(a, b, g, 0)) return;
          done = true;
          w.c.act(a);
          w.c.act(b);
        },
      });
      w.finish();
      need(done && w.c.state.lastAudit !== null);
      expect(w.verdict()).toEqual({ status: 'ok', failures: [], caveats: [] });
    }));
});

/**
 * Normal, four hands. The seat's first claim (a win, Pong, Kong or Chow on a discard) made while another seat's offer in
 * the same window is still open is dropped on its way and answered `busy`. The seat then passes, once:
 *   bump : after the next state (the other seat's response was played first, so the pass is played at a later turn);
 *   same : at once, on the claim's own turn (control).
 * An honest host would have played the claim (it was legal when made) or refused it naming its turn before it played
 * anything later of that link.
 */
function claimBump(code: string, mode: 'bump' | 'same') {
  const kinds = new Set(['hu', 'pong', 'kong', 'chi']);
  let at: number | null = null;
  let atHand = -1;
  let passed = false;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 4, turnSeconds: 15, timeBankSeconds: 30 }),
    botDelayMs: 700,
    think: (_k, tc) => (at !== null && tc >= at && !passed ? Infinity : 300),
    upFilter: (m, w) => {
      if (at !== null || m.t !== 'action' || !kinds.has(m.action.type) || !isInt(m.turnCounter)) return true;
      const g = w.host.game;
      if (!g || g.phase !== 'claim' || ![1, 2, 3].some((seat) => legalActions(g, seat).length > 0)) return true;
      at = m.turnCounter;
      atHand = g.handNumber;
      w.line.inject({ t: 'error', code: 'busy', message: 'Busy.' } as HostMessage);
      return false;
    },
    onTick: (w) => {
      const v = w.c.state.view;
      if (at === null || passed || !v || v.handNumber !== atHand || w.host.phase !== 'playing' || !w.current()) return;
      if (mode === 'bump' ? v.turnCounter <= at : v.turnCounter !== at) return;
      const s = w.c.localState();
      const pass = s ? legalActions(s, 0).find((a) => a.type === 'pass') : undefined;
      if (!pass) return;
      passed = true;
      w.c.act(pass);
    },
  });
  // (In steps of 100 ms: the seat's pass on the claim's own turn comes before the bots' answers, 700 ms in.)
  for (let k = 0; k < 200_000 && !w.c.state.matchOver; k++) w.step(100);
  const hand = w.c.state.audits.find((a) => a.audit.handNumber === atHand);
  return { w, bumped: at !== null && passed, verdict: hand ? { status: hand.status, failures: [...new Set(hand.failures.map(failureKey))] } : null };
}

describe('a dropped claim, then the seat’s pass at the next turn', () => {
  it('another seat’s response played first, the pass played a turn later: red (the claim was lost; it was green)', () =>
    scenario((i) => {
      const r = claimBump(`AMB${i}`, 'bump');
      need(r.bumped && r.verdict !== null);
      expect(r.verdict).toMatchObject({ status: 'failed', failures: expect.arrayContaining(['moveDropped']) });
    }, 60));

  it('control: the pass on the claim’s own turn: red', () =>
    scenario((i) => {
      const r = claimBump(`AMBS${i}`, 'same');
      need(r.bumped && r.verdict !== null);
      expect(r.verdict).toMatchObject({ status: 'failed', failures: expect.arrayContaining(['moveDropped']) });
    }, 60));
});

describe('a link where the phone holds no seat', () => {
  it('the seat taken away (`evicted`), then the table carries on over the same link: red, it sends the game on a link where the phone holds no seat, and the phone sends no move there', () =>
    scenario((i) => {
      const a = droppedThenOwn(`AME${i}`, 'evicted');
      need(a.w.c.state.lastAudit !== null);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['unseatedFrame']));
      expect(a.attacked).toBe(false);
    }));

  /** Normal. The server sends `extra` on the phone's first link before its welcome; the hand is then played as usual. */
  function beforeWelcome(code: string, extra: (w: Wire) => HostMessage[]) {
    let sent = false;
    const w = wire({
      code,
      rules: NORMAL,
      before: (m, w) => {
        if (sent || m.t !== 'welcome') return [];
        sent = true;
        return extra(w);
      },
    });
    w.finish();
    return w;
  }

  it('a state, a clock frame or a commit request before the table’s welcome: red', () => {
    const state = { t: 'state', view: { handNumber: 0, turnCounter: 0, players: [0, 1, 2, 3].map(() => ({ handCount: 16, melds: [], flowers: [], discards: [] })), scores: [0, 0, 0, 0] }, hash: 'ab', deadline: null, timeBank: 30, inTimeBank: false, now: 1 } as unknown as HostMessage;
    for (const [k, m] of [
      ['state', state],
      ['clock', { t: 'clock', now: 1, hand: 0, tc: 0 }],
      ['commit', { t: 'commit_request', handNumber: 0, attempt: 1 }],
    ] as const) {
      const w = beforeWelcome(`AMW${k}`, () => [m as HostMessage]);
      expect(w.verdict().status, k).toBe('failed');
      expect(w.verdict().failures, k).toEqual(expect.arrayContaining(['unseatedFrame']));
    }
  });

  it('honest: a pong and a "not seated" before the welcome (answers to what the phone sent before it joined) flag nothing', () => {
    const w = beforeWelcome('AMWH', () => [{ t: 'pong', at: 1, now: 1 } as HostMessage, { t: 'error', code: 'not_seated', message: 'Join the table first.' } as HostMessage]);
    expect(w.verdict().status).toBe('ok');
  });

  it('honest: an eviction from an in-process table, then a "not seated" and a pong on that link, flag nothing, and the phone sends no move there', () => {
    const hub = new LoopbackHub();
    const table = new TableHost(hub.create('host'), { roomCode: 'AMV', rules: NORMAL, matchId: 'm-AMV' });
    const sent: string[] = [];
    const base = transportLink(hub.create('pA'), 'host');
    const link: Link = { ...base, send: (m) => (sent.push(m.t), base.send(m)) };
    const a = new TableClient(link, 'A', undefined, { userId: 'user-evicted-2' });
    a.join();
    table.start();
    expect(a.state.view).not.toBeNull();
    table.evictUser('user-evicted-2');
    a.chat('gg');
    a.ping();
    sent.length = 0;
    a.act({ type: 'pass' });
    expect(sent).toEqual([]);
    expect(a.serialize().tamper).toEqual([]);
  });
});
