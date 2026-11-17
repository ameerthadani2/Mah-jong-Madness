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
