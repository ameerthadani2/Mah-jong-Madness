/**
 * The audit checks what the table played, not only when. The host's own moves follow a published
 * rule (`tableRule`): a seat whose clock ran out, or that is away after its link dropped, takes a
 * win when offered, passes any other claim on another seat's discard, and otherwise plays as a bot
 * of at least Club strength with the seed `timeout:<seat>`; a bot seat, and a seat whose player left
 * on purpose, plays as a bot of the table's strength with the seed `<matchId>:bot<seat>`. Every
 * phone recomputes each such move from the replayed state before it and fails the hand on any
 * other. A host that does not say how strong its bots are fails those hands; only a phone restored
 * from a save that predates the kept strength lets them pass as amber.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, kindOf, legalActions, withRules, type Action, type BotSkill, type GameState } from '@mjm/engine';
import { AUDIT_CAVEATS, AUDIT_FAILURES, failureKey, LoopbackHub, TableClient, TableHost, transportLink, type HostMessage, type Link } from '../src/index';
import { armedLate, clockTrack, firstSend, fixedPoint, judgeTableMove, lateAnchor, lateCountMs, lateLimitMs, lateRef, lateWatch, seatRun, seenHere, sinceFixed, turnLateBy, unstamped } from '../src/clientmoves';
import { DRIFT_RATE, LATE_MS, RTT_ALLOW_MS } from '../src/clientclock';
import { cleanCeremony, cleanPlay, cleanSeen, finiteFigure, isLateTurnRecord, savedSeen, seenSum, withLateTurns, type PlayRecord, type SeenState } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';

seededDeals(20261116);

const deal = (name: string, fn: () => void) => it(name, () => scenario(fn));
const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};

interface HostInternals {
  game: GameState | null;
  phase: string;
  apply: (seat: number, action: Action, source: 'player' | 'bot' | 'timeout') => void;
  timeoutAction: (game: GameState, seat: number) => Action;
  sendTo: (peerId: string, msg: HostMessage) => void;
  roomCode: string;
  rules: unknown;
  matchId: string;
  seatInfo: () => unknown[];
  seats: Array<{ token?: string }>;
}
const internals = (host: TableHost) => host as unknown as HostInternals;

const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

/** A link that passes every frame through `edit` on its way to the client. */
function editing(hub: LoopbackHub, id: string, edit: (m: HostMessage) => HostMessage): Link {
  const base = transportLink(hub.create(id), 'host');
  return { ...base, onMessage: (f) => base.onMessage((m) => f(edit(m))) } as Link;
}

interface Opts {
  skill?: BotSkill;
  /** Seats taken by players (from seat 0); the rest are bots. */
  humans?: number;
  /** Which players move themselves (the others never do: their clocks run out). */
  active?: boolean[];
  /** Strip the bot skill from the welcome, as a host built before it was sent would. */
  oldHost?: boolean;
  /** Bots wait this long before moving, on a queue the test runs. */
  botDelayMs?: number;
}

function table(code: string, opts: Opts = {}) {
  const clock = { now: 1_000_000 };
  const hub = new LoopbackHub();
  const queue: Array<{ at: number; fn: () => void }> = [];
  const host = new TableHost(hub.create('host'), {
    roomCode: code,
    rules: RULES,
    now: () => clock.now,
    matchId: `m-${code}`,
    botSkill: opts.skill,
    botDelayMs: opts.botDelayMs,
    schedule: (fn, ms) => queue.push({ at: clock.now + ms, fn }),
  });
  const humans = opts.humans ?? 1;
  const strip = (m: HostMessage): HostMessage => {
    if (!opts.oldHost || m.t !== 'welcome') return m;
    const { botSkill: _gone, ...rest } = m;
    return rest as HostMessage;
  };
  const clients = Array.from({ length: humans }, (_, i) => new TableClient(editing(hub, `p${i}`, strip), `P${i}`, undefined, {}, { now: () => clock.now }));
  for (const c of clients) c.join();
  host.start();
  const active = opts.active ?? clients.map(() => false);
  const t = {
    clock,
    hub,
    host,
    h: internals(host),
    clients,
    c: clients[0],
    /** One step: a player who moves itself does, due bot timers fire, or the clock runs on by half a second. */
    step() {
      for (const [i, c] of clients.entries()) {
        const s = c.localState();
        if (active[i] && s && host.phase === 'playing' && legalActions(s, i).length > 0) {
          c.act(chooseAction(s, i, { seed: 'p' })!);
          return;
        }
      }
      clock.now += 500;
      for (const job of queue.splice(0).filter((j) => (j.at <= clock.now ? true : (queue.push(j), false)))) job.fn();
      host.tick();
    },
    playOut() {
      for (let g = 0; g < 40_000 && host.phase === 'playing'; g++) t.step();
      expect(host.phase).not.toBe('playing');
      for (let g = 0; g < 200 && t.c.state.audits.length === 0; g++) t.step();
    },
    /** How many moves the log has the table making for `seat`. */
    tableMoves(seat: number) {
      return (t.c.state.lastAudit?.log ?? []).filter((e) => e.seat === seat && e.source === 'auto').length;
    },
    /** The same, in the hand under way. */
    tableMovesLive(seat: number) {
      return (internals(host).game?.actionLog ?? []).filter((e) => e.seat === seat && e.source === 'auto').length;
    },
  };
  return t;
}

const SKILL_UNPUBLISHED = AUDIT_FAILURES.skillUnpublished;
const verdict = (c: TableClient) => [c.state.auditStatus, c.state.auditFailures];
const tableMoveDiffers = (c: TableClient) => c.state.auditFailures.filter((f) => f.startsWith('The table played for this seat a move other than the one its published rule gives'));

describe('what the table plays for a seat whose time has run out is checked', () => {
  deal('a Chow, Pong or Kong forced for a timed-out seat fails the hand', () => {
    const t = table('TM1');
    const honest = t.h.timeoutAction.bind(t.host);
    let forced = 0;
    t.h.timeoutAction = (game, seat) => {
      const open = legalActions(game, seat).find((a) => a.type === 'pong' || a.type === 'chi' || a.type === 'kong');
      if (seat === 0 && game.phase === 'claim' && open && !legalActions(game, seat).some((a) => a.type === 'hu')) {
        forced++;
        return open;
      }
      return honest(game, seat);
    };
    t.playOut();
    need(forced > 0);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(tableMoveDiffers(t.c).length).toBeGreaterThan(0);
  });

  deal('a discard other than the one the rule gives, for a timed-out seat, fails the hand', () => {
    const t = table('TM2');
    const honest = t.h.timeoutAction.bind(t.host);
    let forced = 0;
    t.h.timeoutAction = (game, seat) => {
      const fair = honest(game, seat);
      if (seat === 0 && forced === 0 && fair.type === 'discard') {
        const other = legalActions(game, seat).find((a) => a.type === 'discard' && kindOf(a.tile) !== kindOf(fair.tile));
        if (other) {
          forced++;
          return other;
        }
      }
      return fair;
    };
    t.playOut();
    need(forced > 0);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(tableMoveDiffers(t.c)).toHaveLength(1);
  });

  for (const skill of ['beginner', 'club', 'pro'] as const) {
    deal(`an honest table that plays a whole hand for an idle seat stays green (${skill} bots)`, () => {
      const t = table(`TM3${skill}`, { skill });
      t.playOut();
      expect(t.tableMoves(0)).toBeGreaterThan(3);
      expect(verdict(t.c)).toEqual(['ok', []]);
    });
  }
});

describe('what the bots play is checked', () => {
  deal('a bot that discards something other than its policy’s choice fails the hand', () => {
    const t = table('TB1', { active: [true] });
    const apply = t.h.apply.bind(t.host);
    let forced = 0;
    t.h.apply = (seat, action, source) => {
      if (source === 'bot' && seat === 2 && forced === 0 && action.type === 'discard') {
        const other = legalActions(t.host.game!, seat).find((a) => a.type === 'discard' && kindOf(a.tile) !== kindOf(action.tile));
        if (other) {
          forced++;
          return apply(seat, other, source);
        }
      }
      apply(seat, action, source);
    };
    t.playOut();
    need(forced > 0);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures.filter((f) => /^The bot in seat 2 played a move other than the one its published rule gives \(turn \d+\)$/.test(f))).toHaveLength(1);
  });

  deal('a bot that passes up a claim its policy takes fails the hand', () => {
    const t = table('TB2', { active: [true], skill: 'pro' });
    const apply = t.h.apply.bind(t.host);
    let forced = 0;
    t.h.apply = (seat, action, source) => {
      if (source === 'bot' && seat !== 0 && forced === 0 && t.host.game!.phase === 'claim' && action.type !== 'pass' && action.type !== 'hu') {
        forced++;
        return apply(seat, { type: 'pass' }, source);
      }
      apply(seat, action, source);
    };
    t.playOut();
    need(forced > 0);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures.some((f) => f.startsWith('The bot in seat '))).toBe(true);
  });

  deal('honest bots that wait before moving, while a player acts in between, stay green', () => {
    const t = table('TB3', { active: [true], botDelayMs: 1_200 });
    t.playOut();
    expect(t.tableMoves(1) + t.tableMoves(2) + t.tableMoves(3)).toBeGreaterThan(10);
    expect(verdict(t.c)).toEqual(['ok', []]);
  });
});

describe('the moves the table makes for another player are checked', () => {
  deal('a Pong forced for another player whose time ran out fails the hand on this phone', () => {
    const t = table('TO1', { humans: 2, active: [true, false] });
    const honest = t.h.timeoutAction.bind(t.host);
    let forced = 0;
    t.h.timeoutAction = (game, seat) => {
      const open = legalActions(game, seat).find((a) => a.type === 'pong' || a.type === 'chi' || a.type === 'kong');
      if (seat === 1 && game.phase === 'claim' && open && !legalActions(game, seat).some((a) => a.type === 'hu')) {
        forced++;
        return open;
      }
      return honest(game, seat);
    };
    t.playOut();
    need(forced > 0);
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures.some((f) => /^The table played for seat 1 a move that neither of its published rules gives \(turn \d+\)$/.test(f))).toBe(true);
  });

  deal('an honest table that plays for another idle player stays green on both phones', () => {
    const t = table('TO2', { humans: 2, active: [true, false] });
    t.playOut();
    expect(t.tableMoves(1)).toBeGreaterThan(3);
    expect(verdict(t.clients[0])).toEqual(['ok', []]);
    expect(verdict(t.clients[1])).toEqual(['ok', []]);
  });

  deal('a player who leaves on purpose is played like a bot, and their phone accepts that when they return', () => {
    const t = table('TO3', { humans: 2, active: [true, true] });
    for (let g = 0; g < 4000 && !(t.host.phase === 'playing' && t.host.game!.turnCounter >= 6); g++) t.step();
    need(t.host.phase === 'playing');
    const b = t.clients[1];
    b.leave();
    // Seat 1 is now played by the table as a bot; seat 0 keeps playing.
    for (let g = 0; g < 4000 && t.host.phase === 'playing' && t.tableMovesLive(1) < 3; g++) t.step();
    need(t.host.phase === 'playing');
    b.rebind(transportLink(t.hub.create('p1-back'), 'host'));
    b.join();
    t.playOut();
    expect(t.c.state.auditFailures).toEqual([]);
    expect(b.state.auditFailures).toEqual([]);
  });
});

describe('the bot strength the table publishes', () => {
  deal('a host that does not say how strong its bots are fails a hand in which it moved for a bot or a seat out of time', () => {
    const t = table('TS1', { oldHost: true });
    t.playOut();
    expect(t.tableMoves(0)).toBeGreaterThan(3);
    expect(verdict(t.c)).toEqual(['failed', [SKILL_UNPUBLISHED]]);
    expect(failureKey(SKILL_UNPUBLISHED)).toBe('skillUnpublished');
    expect(t.c.state.auditCaveats).toEqual([]);
  });

  deal('a host that leaves the strength out is red even when it seats bots that read every hand', () => {
    // The fifth assessment's probe: bots that never feed this seat a win, at a table that does not say how strong they are.
    const t = table('TS1b', { oldHost: true, active: [true] });
    const apply = t.h.apply.bind(t.host);
    t.h.apply = (seat, action, source) => {
      if (seat !== 0 && source === 'bot' && action.type === 'discard' && t.h.game) {
        const alt = legalActions(t.h.game, seat).find((a) => a.type === 'discard');
        if (alt) action = alt;
      }
      apply(seat, action, source);
    };
    t.playOut();
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures).toContain(SKILL_UNPUBLISHED);
  });

  deal('an honest table that says how strong its bots are stays green with bots and a seat out of time', () => {
    const t = table('TS1c', { skill: 'club' });
    t.playOut();
    expect(t.tableMoves(0)).toBeGreaterThan(3);
    expect(verdict(t.c)).toEqual(['ok', []]);
  });

  deal('a host that changes how strong its bots are during the match fails the hand', () => {
    const t = table('TS2', { skill: 'club', active: [true] });
    for (let g = 0; g < 4000 && !(t.host.phase === 'playing' && t.host.game!.turnCounter >= 2); g++) t.step();
    need(t.host.phase === 'playing');
    t.h.sendTo('p0', { t: 'welcome', seat: 0, roomCode: t.h.roomCode, rules: t.h.rules as never, seats: t.h.seatInfo() as never, matchId: t.h.matchId, token: t.h.seats[0].token!, botSkill: 'pro' });
    t.playOut();
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures).toContain('Host changed how strong its bots are during the match');
  });

  deal('the strength is kept with the record across an app restart', () => {
    const t = table('TS3', { skill: 'pro', active: [true] });
    for (let g = 0; g < 4000 && !(t.host.phase === 'playing' && t.host.game!.turnCounter >= 2); g++) t.step();
    const saved = JSON.parse(JSON.stringify(t.c.serialize()));
    expect(saved.pinnedSkill).toBe('pro');
    // A record written before the strength was kept checks nothing it cannot: amber, not red.
    delete saved.pinnedSkill;
    const restored = TableClient.restore(saved, transportLink(t.hub.create('p0-old'), 'host'), 'P0', undefined, { token: saved.state.token }, { now: () => t.clock.now });
    expect((restored.serialize() as { pinnedSkill?: unknown }).pinnedSkill).toBe('unknown');
  });

  deal('a client restored from a save that predates the kept strength stays amber, never red', () => {
    const t = table('TS4', { skill: 'club' });
    for (let g = 0; g < 4000 && !(t.host.phase === 'playing' && t.tableMovesLive(0) >= 1); g++) t.step();
    need(t.host.phase === 'playing');
    const saved = JSON.parse(JSON.stringify(t.c.serialize()));
    delete saved.pinnedSkill;
    // The app was killed: its link just closes.
    (t.c as unknown as { link: Link }).link.close();
    const restored = TableClient.restore(saved, transportLink(t.hub.create('p0-old'), 'host'), 'P0', undefined, { token: saved.state.token }, { now: () => t.clock.now });
    restored.join();
    for (let g = 0; g < 40_000 && t.host.phase === 'playing'; g++) t.step();
    for (let g = 0; g < 200 && restored.state.audits.length === 0; g++) t.step();
    expect(restored.state.auditFailures).toEqual([]);
    expect(restored.state.auditCaveats).toContain(AUDIT_CAVEATS.skillUnknown);
  });

  deal('a table that did not say keeps failing after an app restart', () => {
    const t = table('TS5', { oldHost: true });
    for (let g = 0; g < 4000 && !(t.host.phase === 'playing' && t.host.game!.turnCounter >= 2); g++) t.step();
    const saved = JSON.parse(JSON.stringify(t.c.serialize()));
    expect(saved.pinnedSkill).toBe('unpublished');
    const restored = TableClient.restore(saved, transportLink(t.hub.create('p0-new'), 'host'), 'P0', undefined, { token: saved.state.token }, { now: () => t.clock.now });
    expect((restored.serialize() as { pinnedSkill?: unknown }).pinnedSkill).toBe('unpublished');
  });
});

/** A state as the client records it: turn `tc`, whether it showed this seat a move, and anything else given. */
const seen = (tc: number, owes: boolean, extra: Partial<SeenState> = {}): SeenState => ({ tc, epoch: 0, era: 0, at: 1_000 + tc, now: 1_000 + tc, owes, deadline: null, timeBank: 30, inBank: false, hash: `h${tc}`, ...extra });
const played = (frames: SeenState[]): PlayRecord => ({ hand: 0, seen: frames, sent: [], ledgerFrom: 0 });

describe('the states that showed this seat a move (seatRun)', () => {
  it('run back from the last state at or before the move, over every state that owed a move since the seat last moved', () => {
    const p = played([seen(3, false), seen(4, true), seen(5, true), seen(6, true)]);
    expect(seatRun(p, 6, -1)).toEqual({ run: p.seen.slice(1), i0: 1 });
    // The seat moved at turn 4: the move at turn 6 answers the states after it.
    expect(seatRun(p, 6, 4)).toEqual({ run: p.seen.slice(2), i0: 2 });
  });

  it('are none when the last state at or before the move came at or before the seat’s own previous move', () => {
    // The seat was shown turn 7 and moved there; no state came after, and the table moved for it at turn 9.
    const p = played([seen(6, false), seen(7, true)]);
    expect(seatRun(p, 9, 7)).toEqual({ run: [], i0: -1 });
    expect(seatRun(p, 9, -1)).toEqual({ run: [p.seen[1]], i0: 1 });
  });

  it('are none when the last state at or before the move showed the seat nothing to do', () => {
    expect(seatRun(played([seen(4, true), seen(5, false)]), 6, -1)).toEqual({ run: [], i0: -1 });
    expect(seatRun(played([seen(8, true)]), 6, -1)).toEqual({ run: [], i0: -1 });
  });
});

describe('the state that starts a turn gives the whole turn clock (armedLate)', () => {
  const rules = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

  it('on a link this device held, by its own deadline and stamp, with a second of slack', () => {
    expect(armedLate(seen(5, true, { onLink: true, now: 10_000, deadline: 25_000 }), rules)).toBe(false);
    expect(armedLate(seen(5, true, { onLink: true, now: 10_000, deadline: 24_000 }), rules)).toBe(false);
    // Two seconds of the turn gone before the state was stamped, or the turn already in the bank: late.
    expect(armedLate(seen(5, true, { onLink: true, now: 10_000, deadline: 23_000 }), rules)).toBe(true);
    expect(armedLate(seen(5, true, { onLink: true, now: 10_000, deadline: 40_000, inBank: true }), rules)).toBe(true);
  });

  it('is not asked of a state that came first on a new link, of one with no deadline, or of a record from an older build', () => {
    expect(armedLate(seen(5, true, { onLink: false, now: 10_000, deadline: 23_000 }), rules)).toBe(false);
    expect(armedLate(seen(5, true, { onLink: true, now: 10_000, deadline: null }), rules)).toBe(false);
    expect(armedLate(seen(5, true, { now: 10_000, deadline: 23_000 }), rules)).toBe(false);
    expect(armedLate(seen(5, true, { now: undefined, deadline: 23_000 }), rules)).toBe(false);
  });

  it('a state with no stamp on a link this device held gives no turn clock: late (an honest host stamps every state)', () => {
    expect(armedLate(seen(5, true, { onLink: true, now: undefined, deadline: 23_000 }), rules)).toBe(true);
    expect(armedLate(seen(5, true, { onLink: true, now: undefined, deadline: null }), rules)).toBe(true);
  });
});

describe('a state recorded without its stamp (unstamped)', () => {
  it('is one this build recorded with no stamp; a record from an older build, which kept no onLink, is not asked', () => {
    expect(unstamped(seen(5, true, { onLink: false, now: undefined }))).toBe(true);
    expect(unstamped(seen(5, true, { onLink: true, now: undefined }))).toBe(true);
    expect(unstamped(seen(5, true, { onLink: false }))).toBe(false);
    expect(unstamped(seen(5, true, { now: undefined }))).toBe(false);
  });
});

describe('a fixed point is worth no more than its round trip allows (fixedPoint, lateAnchor)', () => {
  // This device's clock is 10 s ahead of the host's. From the deal on, the server delays every frame it
  // sends by 25 s; the uplink takes 100 ms. The device sent its share at 100 000 on its clock; the host dealt
  // at 90 100 on its own, and the deal reached the device at 125 100. A turn the host made at 200 000
  // reached it at 235 000, when the least arrival offset seen was 35 000 (every frame was 25 s late).
  const turn = seen(40, true, { at: 235_000, atLo: 235_000, now: 200_000, ref: 35_000, run: 'r', seg: 0 });
  const scope = { run: 'r', best: null };
  const reveal = (now: number, fat = 125_100) => ({ at: 100_000, now, era: 0, run: 'r', seg: 0, fat });

  it('an honest answer: its round trip gives what its stamp gives, and the 25 s delay shows', () => {
    expect(fixedPoint(reveal(90_100), 35_000)).toBe(9_900);
    expect(lateAnchor(turn, [reveal(90_100)], scope)).toBeGreaterThan(LATE_MS);
  });

  it('the deal stamped 25 s back: its stamp would cancel the delay, its round trip does not', () => {
    expect(100_000 - 65_100).toBe(34_900);
    expect(fixedPoint(reveal(65_100), 35_000)).toBe(9_900);
    expect(lateAnchor(turn, [reveal(65_100)], scope)).toBeGreaterThan(LATE_MS);
    // The strongest fixed point carried from an earlier hand is capped the same way, by its round trip.
    expect(lateAnchor(turn, [], { run: 'r', best: { era: 0, run: 'r', seg: 0, value: 34_900, at: 100_000, rtt: 25_100 } })).toBeGreaterThan(LATE_MS);
  });

  it('the answer later on the way back than the least offset shows counts for that much less; with no round trip known, its stamp alone', () => {
    expect(fixedPoint(reveal(90_100, 125_400), 35_000)).toBe(9_600);
    expect(fixedPoint({ at: 100_000, now: 65_100 }, 35_000)).toBe(34_900);
    expect(fixedPoint(reveal(65_100), null)).toBe(34_900);
  });

  it('with no least offset before it, a frame is measured against its own', () => {
    const first = seen(0, true, { at: 125_100, atLo: 125_100, now: 65_100, ref: null, run: 'r', seg: 0 });
    // The deal itself, stamped back: its own offset holds the delay, and the round trip of the share it answers is 25.1 s.
    expect(lateAnchor(first, [reveal(65_100)], scope)).toBeCloseTo(25_100 - RTT_ALLOW_MS + DRIFT_RATE * 25_100, 6);
  });
});

describe('a move sent more than once: the first copy is the fixed point (firstSend)', () => {
  const copy = (tc: number, at: number | undefined, run = 'r', seg = 0) => ({ tc, at, run, seg });

  it('is the earliest of the copies, whichever the log matched', () => {
    const a = copy(28, 10_000);
    const b = copy(35, 29_500);
    expect(firstSend([b, a])).toBe(a);
    expect(firstSend([a])).toBe(a);
    expect(firstSend([])).toBeNull();
  });

  it('is none when a copy has no time, or was sent in another run of the app or of the device clock', () => {
    expect(firstSend([copy(28, 10_000), copy(35, undefined)])).toBeNull();
    expect(firstSend([copy(28, 10_000), copy(35, 29_500, 'other')])).toBeNull();
    expect(firstSend([copy(28, 10_000), copy(35, 29_500, 'r', 1)])).toBeNull();
  });
});

describe('a frame from a saved record keeps the fields that judge how late it came only when they are what this build writes (cleanSeen)', () => {
  // As this build records a frame: stamped, measured by the watch on a live link.
  const live = seen(40, true, { at: 235_000, atLo: 235_000, now: 200_000, ref: 35_000, wref: 35_200, live: true, working: true, seg: 0, run: 'r', onLink: true, deadline: 215_000 });
  const MEASURED = ['atLo', 'ref', 'wref', 'live', 'working', 'seg', 'run', 'onLink'];
  const dropped = (f: SeenState) => MEASURED.every((k) => !(k in f));

  it('keeps a frame as this build writes it, a stampless state with its link, and a frame from an older record, unchanged but marked as not kept: no check figure vouches for them', () => {
    expect(cleanSeen(live)).toEqual({ ...live, kept: false });
    const bare = seen(41, true, { now: undefined, run: 'r', onLink: true });
    expect(cleanSeen(bare)).toEqual({ ...bare, kept: false });
    const first = seen(0, true, { atLo: 1_000, ref: null, wref: null, live: false, working: true, seg: 0, run: 'r', onLink: false });
    expect(cleanSeen(first)).toEqual({ ...first, kept: false });
    const older = seen(42, true);
    expect(cleanSeen(older)).toEqual({ ...older, kept: false });
  });

  it('drops them all when one is junk, out of range or breaks what the others say, and keeps the rest of the frame', () => {
    const bad: Array<Partial<SeenState> | Record<string, unknown>> = [
      { atLo: null },
      { atLo: 'x' },
      { atLo: 1e300 },
      { atLo: 255_000 },
      { ref: 'x' },
      { wref: -1e300 },
      { wref: 15_000 },
      { ref: -7_000_000, wref: -7_000_000 },
      { ref: null },
      { live: 'x' },
      { live: true, working: false },
      { working: 7 },
      { seg: -1 },
      { seg: 0.5 },
      { run: 7 },
      { onLink: 'yes' },
      { deadline: -1e300 },
      { deadline: 'x' },
    ];
    for (const b of bad) {
      const out = cleanSeen({ ...live, ...b } as SeenState);
      expect(dropped(out)).toBe(true);
      expect(out).toMatchObject({ tc: 40, at: 235_000, now: 200_000, owes: true, hash: 'h40' });
    }
    // Measured fields without a stamp, or some of them without the rest.
    expect(dropped(cleanSeen({ ...live, now: undefined }))).toBe(true);
    const { wref: _w, ...partial } = live;
    void _w;
    expect(dropped(cleanSeen(partial as SeenState))).toBe(true);
  });

  it('drops a stamp no clock can make with them', () => {
    for (const now of [1e300, -1e300, null, 'x', Number.NaN]) {
      const out = cleanSeen({ ...live, now } as unknown as SeenState);
      expect(dropped(out)).toBe(true);
      expect('now' in out).toBe(false);
    }
  });

  it('marks a frame whose check figure still matches as kept, so it is judged as the run that saw it would judge it; one changed digit, a figure from another frame, or none, and it is not', () => {
    const back = (f: SeenState) => cleanSeen(JSON.parse(JSON.stringify(savedSeen(f))) as SeenState);
    const kept = back(live);
    expect(kept).toEqual({ ...live, kept: true });
    expect(seenHere(kept, 'another run')).toBe(true);
    // Saved again, the mark is not: the figure is worked out afresh from the fields.
    expect(savedSeen(kept)).not.toHaveProperty('kept');
    expect(back(kept)).toEqual({ ...live, kept: true });
    const damaged = { ...savedSeen(live), deadline: 214_000 };
    expect(cleanSeen(damaged).kept).toBe(false);
    expect(cleanSeen(damaged)).not.toHaveProperty('sum');
    expect(seenHere(cleanSeen(damaged), 'another run')).toBe(false);
    const other = { ...savedSeen(live), sum: savedSeen({ ...live, tc: 41 }).sum };
    expect(cleanSeen(other).kept).toBe(false);
    expect(cleanSeen(live).kept).toBe(false);
    // A mark saved with the frame (only damage can put it there) is not believed either.
    expect(cleanSeen({ ...live, kept: true }).kept).toBe(false);
    // A frame whose measured fields do not hold together loses them, its figure and any mark with them.
    expect(cleanSeen({ ...savedSeen(live), wref: 1 }).kept).toBe(false);
  });

  it('saves a frame restored without a matching figure without one, so a second restart reads it as damaged again, never as kept', () => {
    const damaged = cleanSeen({ ...savedSeen(live), deadline: 214_000 });
    expect(savedSeen(damaged)).not.toHaveProperty('sum');
    expect(savedSeen(damaged)).not.toHaveProperty('kept');
    const again = cleanSeen(JSON.parse(JSON.stringify(savedSeen(damaged))) as SeenState);
    expect(again.kept).toBe(false);
    expect(seenHere(again, 'a third run')).toBe(false);
    // A frame this run saw is saved with its figure.
    expect(savedSeen(live).sum).toBe(seenSum(live));
  });

  it('keeps a frame whose check figure still matches whole, with figures no honest host sends: a deadline two days before its stamp, a stamp 1.1e13 ms ahead of this device', () => {
    const back = (f: SeenState) => cleanSeen(JSON.parse(JSON.stringify(savedSeen(f))) as SeenState);
    for (const odd of [{ deadline: 200_000 - 2 * 86_400_000 }, { now: 200_000 + 1.1e13, deadline: 205_000 + 1.1e13 }, { deadline: -Number.MAX_VALUE }]) {
      const f = { ...live, ...odd };
      expect(back(f)).toEqual({ ...f, kept: true });
      // Without the figure, the same frame reads as damaged.
      expect(dropped(cleanSeen(f))).toBe(true);
    }
  });

  it('keeps an infinite clock figure from the host as the largest finite one of its sign, which a saved record holds as it is (finiteFigure)', () => {
    expect(finiteFigure(Number.NEGATIVE_INFINITY)).toBe(-Number.MAX_VALUE);
    expect(finiteFigure(Number.POSITIVE_INFINITY)).toBe(Number.MAX_VALUE);
    expect(finiteFigure(Number.NaN)).toBeNull();
    expect(finiteFigure(215_000)).toBe(215_000);
    expect(JSON.parse(JSON.stringify({ d: finiteFigure(JSON.parse('-1e400') as number) })).d).toBe(-Number.MAX_VALUE);
  });

  it('keeps the run of each move sent and each reveal only when it is what this build writes, and refuses a record that is not one', () => {
    const play = cleanPlay({ hand: 0, seen: [live], sent: [{ tc: 1, action: { type: 'pass' }, epoch: 0, at: 5, run: 'r', seg: 0 }, { tc: 2, action: { type: 'pass' }, epoch: 0, at: 6, run: 7, seg: 0 }], ledgerFrom: 0 });
    expect(play.seen[0]).toEqual({ ...live, kept: false });
    expect(play.sent[0]).toMatchObject({ run: 'r', seg: 0 });
    expect(play.sent[1]).not.toHaveProperty('run');
    expect(play.sent[1]).not.toHaveProperty('seg');
    expect(play.sent[1]).toMatchObject({ tc: 2, at: 6 });
    const rec = cleanCeremony({ hand: 0, attempts: [{ n: 1, committed: true, revealed: true, stoodIn: false, revealedAt: 9, revealedRun: 'r', revealedSeg: -2 }], fromStart: true, linkLost: false, dealt: true });
    expect(rec.attempts[0]).not.toHaveProperty('revealedRun');
    expect(rec.attempts[0]).toMatchObject({ revealedAt: 9 });
    expect(() => cleanPlay({ hand: 0, seen: [null], sent: [] })).toThrow();
    expect(() => cleanPlay({ hand: 0, seen: [], sent: 'x' })).toThrow();
    expect(() => cleanCeremony({ hand: 0, attempts: [3] })).toThrow();
  });
});

describe('how late a turn reached this device, for the Fair play count (turnLateBy, lateCountMs)', () => {
  const speed = (turnSeconds: number, timeBankSeconds: number) => withRules({ handsPerMatch: 1, turnSeconds, timeBankSeconds });

  it('a turn may be half the turn clock late, and at least 2 s (lateLimitMs); the count’s bar is half that, and at least 1 s', () => {
    const speeds = [speed(30, 60), speed(15, 30), speed(10, 20), speed(7, 10), speed(4, 0), speed(3, 0)];
    expect(speeds.map(lateLimitMs)).toEqual([15_000, 7_500, 5_000, 3_500, 2_000, 2_000]);
    expect(speeds.map(lateCountMs)).toEqual([7_500, 3_750, 2_500, 1_750, 1_000, 1_000]);
  });

  // This device's clock is 10 s ahead of the host's. Its share went out at 100 000; 0.1 s later the host answered,
  // at 90 100 by its own clock, and the answer reached the device at 100 300. The least arrival offset is 10 150, so
  // the share's fixed point is worth 9 850 (its round trip allows no more). A turn the host stamped at 200 000 then
  // reaches the device 0.25 s later, at 210 250, or later than that when it is delayed.
  const scope = { run: 'r', best: null };
  const share = { at: 100_000, now: 90_100, era: 0, run: 'r', seg: 0, fat: 100_300 };
  const turn = (at: number, now: number, extra: Partial<SeenState> = {}) => seen(40, true, { at, atLo: at, now, ref: 10_150, run: 'r', seg: 0, onLink: true, ...extra });
  const drift = (at: number) => DRIFT_RATE * (at - share.at);

  it('an honest turn: its lateness is about the round trip, against the fixed point, with no allowance for the uplink', () => {
    const f = turn(210_250, 200_000);
    expect(sinceFixed(f, [share], scope)).toBeCloseTo(400 + drift(210_250), 6);
    expect(turnLateBy(f, [share], scope)).toBeCloseTo(400 + drift(210_250), 6);
    // The audit's own measure allows 4 s for a slow uplink: it does not see a 3 s delay at all; the count does.
    expect(lateAnchor(turn(213_250, 200_000), [share], scope)).toBeLessThan(0);
    expect(turnLateBy(turn(213_250, 200_000), [share], scope)).toBeCloseTo(3_400 + drift(213_250), 6);
  });

  it('a turn held back is late against the least arrival offset, with or without a fixed point', () => {
    expect(turnLateBy(turn(215_150, 200_000), [], scope)).toBe(5_000);
    expect(turnLateBy(turn(215_150, 200_000), [share], scope)).toBeCloseTo(5_300 + drift(215_150), 6);
  });

  it('a state with no stamp is late whatever else is known; a frame of another run of the app is measured by its least offset alone', () => {
    expect(turnLateBy(turn(215_150, 200_000, { now: undefined }), [share], scope)).toBe(Number.POSITIVE_INFINITY);
    expect(turnLateBy(turn(213_250, 200_000, { run: 'old' }), [share], scope)).toBe(3_100);
    expect(sinceFixed(turn(213_250, 200_000, { run: 'old' }), [share], scope)).toBeNull();
  });

  it('a hand counted again replaces its own count, and a hand with no turn measured is left out', () => {
    const all = withLateTurns(withLateTurns([], 0, { turns: [5, 9], of: 12 }), 1, { turns: [], of: 10 });
    expect(all).toEqual([{ hand: 0, late: [5, 9], of: 12 }, { hand: 1, late: [], of: 10 }]);
    expect(withLateTurns(all, 0, { turns: [5], of: 12 })).toEqual([{ hand: 0, late: [5], of: 12 }, { hand: 1, late: [], of: 10 }]);
    expect(withLateTurns(all, 2, { turns: [], of: 0 })).toEqual(all);
    expect(isLateTurnRecord({ hand: 0, late: [1], of: 1 })).toBe(true);
    for (const bad of [{ hand: 0, late: [1, 2], of: 1 }, { hand: 0, late: 'x', of: 3 }, { hand: 'a', late: [], of: 0 }, null, { hand: 0, late: [0.5], of: 2 }]) expect(isLateTurnRecord(bad)).toBe(false);
  });
});

describe('a live turn is held only when it is late against the watch’s reference (judgeTableMove)', () => {
  const rules = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
  // One link, one clock era. The host's stamps follow real time; the downlink takes 50 ms until 30 s in,
  // then 20 050 ms and stays there (a delay that rose and stayed up): by the seat's turn at 45 s, the
  // watch's reference (the least offset of the last 20 s) has taken the new delay in.
  const ref = (at: number) => 50 + DRIFT_RATE * Math.max(0, at - 1_050);
  const frame = (tc: number, now: number, delay: number, owes: boolean, wref?: number): SeenState => {
    const at = now + delay;
    const r = tc === 0 ? null : ref(at);
    return seen(tc, owes, { epoch: 1, at, now, atLo: at, ref: r, wref: wref ?? r, live: tc > 0, working: true, seg: 0, run: 'r', onLink: tc > 0, deadline: owes ? now + 15_000 : null, inBank: false });
  };
  const judge = (r0: SeenState) => {
    const p = played([frame(0, 1_000, 50, false), frame(1, 10_000, 50, false), frame(2, 20_000, 50, false), frame(3, 40_000, 20_050, false, 20_050), r0, frame(5, 90_000, 20_050, false, 20_050)]);
    const clockBase = { era: 0, anchor: null, minOffset: null };
    return judgeTableMove({ clockBase, gapVerdicts: [], ownAbsences: [] }, p, 4, null, rules, [], clockTrack(clockBase, null, p, rules, []), new Set(), -1, null);
  };

  it('late against the least offset of its scope but not against the watch’s reference: judged late (the table played for the seat, amber), not held', () => {
    const r0 = frame(4, 45_000, 20_050, true, 20_050);
    expect(lateRef(r0)).toBeGreaterThan(17_000);
    expect(lateWatch(r0)).toBeLessThan(1);
    expect(judge(r0)).toBe('downLate');
  });

  it('late against the watch’s reference too: held', () => {
    const r0 = frame(4, 45_000, 20_050, true);
    expect(lateWatch(r0)).toBeGreaterThan(17_000);
    expect(judge(r0)).toBe('held');
  });
});
