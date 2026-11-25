/**
 * Strict intake. Everything the phone shows or acts on is something it files and later checks.
 *
 * Every frame type a seat is sent has a contract (`FRAME_FIELDS`): the fields an honest host always sends in it, and
 * their types. The table client puts each frame through it (`intake`) before it uses anything of it. A frame of a
 * known type that does not meet it is malformed: nothing of it is shown, acted on or filed, and it fails the hand on
 * show (`malformedFrame`), where an honest host never sends one. So a state whose view has no turn counter, a state with
 * no hash, a deadline sent as text and a refusal of a seated player's move that names no turn are each red, where each
 * was once shown (or acted on) and never checked.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { commitFor, failureKey, LoopbackHub, TableClient, TableHost, transportLink, type HostMessage, type Link } from '../src/index';
import { makeSecret } from '../src/fairness';
import { FRAME_FIELDS, intake } from '../src/intake';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const SEATS = [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, peerId: seat === 0 ? 'p0' : null, isBot: seat !== 0, connected: true, timeBank: 30 }));
const players = [0, 1, 2, 3].map(() => ({ handCount: 16, melds: [], flowers: [], discards: [] }));
const VIEW = { handNumber: 0, turnCounter: 3, players, scores: [0, 0, 0, 0] };
const AUDIT = { matchId: 'm-IN', handNumber: 0, seed: 's', commits: [], reveals: [], log: [], finalHash: 'h', rngVersion: 'v', ceremonyAttempts: 1, restarts: [], restartReasons: [] };
const COMMITS = [0, 1, 2, 3, 4].map((seat) => ({ seat, hash: commitFor(makeSecret()) }));

/** One frame of each type, as an honest host sends it (`TableHost`). */
const SAMPLES: { [T in HostMessage['t']]: Record<string, unknown> } = {
  welcome: { t: 'welcome', seat: 0, roomCode: 'IN', rules: NORMAL, seats: SEATS, matchId: 'm-IN', token: 'a'.repeat(32), botSkill: 'club', clockMs: 3_000, elsewhere: true },
  lobby: { t: 'lobby', seats: SEATS },
  commit_request: { t: 'commit_request', handNumber: 0, attempt: 1 },
  commits: { t: 'commits', handNumber: 0, commits: COMMITS },
  reveal_request: { t: 'reveal_request', handNumber: 0 },
  stand_in: { t: 'stand_in', handNumber: 0, attempt: 1 },
  disconnected: { t: 'disconnected' },
  state: { t: 'state', view: VIEW, hash: '0a1b2c3d', deadline: 5_015_000, timeBank: 30, inTimeBank: false, now: 5_000_000 },
  hand_over: { t: 'hand_over', result: { winner: null }, audit: AUDIT, view: VIEW, now: 5_000_000, deadline: 5_030_000 },
  match_over: { t: 'match_over', scores: [0, 0, 0, 0], view: VIEW },
  hand_missed: { t: 'hand_missed', audit: AUDIT },
  restored: { t: 'restored', handNumber: 0, turnCounter: -1 },
  error: { t: 'error', code: 'illegal', message: 'Not your turn', turnCounter: 3 },
  chat: { t: 'chat', seat: 1, name: 'P1', text: 'gg' },
  emote: { t: 'emote', seat: 1, emote: 'thumbs' },
  pong: { t: 'pong', at: 4_999_900, now: 5_000_000 },
  clock: { t: 'clock', now: 5_000_000, hand: 0, tc: 3 },
};

/** Values of every JSON type and then some: for each field, those its check refuses are values of the wrong type. */
const ODD: unknown[] = ['x', '', 5, -1, 1.5, true, false, null, {}, [], [1, 2], Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, '5'];

/** Every malformed variant of every frame type: each required field left out, and each field given a value its check refuses. */
function malformedVariants(): Array<{ t: string; field: string; how: string; frame: Record<string, unknown> }> {
  const out: Array<{ t: string; field: string; how: string; frame: Record<string, unknown> }> = [];
  for (const [t, fields] of Object.entries(FRAME_FIELDS)) {
    const sample = SAMPLES[t as HostMessage['t']];
    for (const [name, field] of Object.entries(fields)) {
      if (!field.optional && !field.optionalIf?.(sample)) {
        const frame = { ...sample };
        delete frame[name];
        out.push({ t, field: name, how: 'missing', frame });
      }
      for (const v of ODD) if (!field.check(v, sample)) out.push({ t, field: name, how: `= ${typeof v === 'number' ? String(v) : JSON.stringify(v)}`, frame: { ...sample, [name]: v } });
    }
  }
  return out;
}

describe('the contract of each frame type', () => {
  it('names every frame type a seat is sent, and each honest sample meets it', () => {
    expect(Object.keys(FRAME_FIELDS).sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const [t, sample] of Object.entries(SAMPLES)) expect(intake(sample), t).toEqual({ ok: true, frame: sample });
  });

  it('a frame with a required field left out, or any field of the wrong type, is malformed, and names that field', () => {
    let fields = 0;
    for (const [t, fields_] of Object.entries(FRAME_FIELDS)) {
      for (const [name, field] of Object.entries(fields_)) {
        fields++;
        // Each field refuses some value: a check that took anything would be no contract.
        expect(ODD.some((v) => !field.check(v, SAMPLES[t as HostMessage['t']])), `${t}.${name}`).toBe(true);
      }
    }
    expect(fields).toBeGreaterThanOrEqual(40);
    for (const v of malformedVariants()) expect(intake(v.frame), `${v.t}.${v.field} ${v.how}`).toEqual({ ok: false, t: v.t, field: v.field });
  });

  it('an optional field may be left out; a refusal of a seated player’s move must name its turn, another refusal need not', () => {
    for (const [t, fields] of Object.entries(FRAME_FIELDS)) {
      for (const [name, field] of Object.entries(fields)) {
        if (!field.optional) continue;
        const frame = { ...SAMPLES[t as HostMessage['t']] };
        delete frame[name];
        expect(intake(frame), `${t} without ${name}`).toEqual({ ok: true, frame });
      }
    }
    for (const code of ['illegal', 'not_playing', 'wrong_seat']) expect(intake({ t: 'error', code, message: 'm' })).toEqual({ ok: false, t: 'error', field: 'turnCounter' });
    for (const code of ['not_seated', 'full', 'evicted', 'ceremony_failed', 'table_closed']) expect(intake({ t: 'error', code, message: 'm' })?.ok).toBe(true);
  });

  it('a type no seat is sent is not read at all', () => {
    for (const m of [{ t: 'something_new' }, { t: 'join', name: 'x' }, { t: 'ping', at: 1 }, null, 5, { t: 7 }]) expect(intake(m)).toBeNull();
  });

  it('every frame an honest table sends a seat meets its contract: a hand with a dropped link, an app restart and a server restart', () =>
    scenario((i) => {
      const seen = new Map<string, number>();
      let bad: string[] = [];
      const w = wire({
        code: `INH${i}`,
        rules: NORMAL,
        botDelayMs: 300,
        map: (m) => {
          seen.set(m.t, (seen.get(m.t) ?? 0) + 1);
          const r = intake(m);
          if (!r?.ok) bad = [...bad, `${m.t}: ${JSON.stringify(r)}`];
          return m;
        },
      });
      need(w.toDiscard(2));
      w.dropNow();
      need(w.toDiscard(1));
      w.restart();
      need(w.toDiscard(1));
      w.restartHost();
      w.finish();
      expect(bad).toEqual([]);
      for (const t of ['welcome', 'lobby', 'commit_request', 'commits', 'reveal_request', 'state', 'hand_over', 'pong', 'restored']) expect(seen.get(t) ?? 0, t).toBeGreaterThan(0);
      expect(w.c.state.audits.flatMap((a) => a.failures)).toEqual([]);
    }));
});

/** A playing table over the loopback, with a way to put any frame straight onto the seat's link and to see what the seat sends. */
function playing(code: string) {
  const clock = { now: 5_000_000 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: NORMAL, now: () => clock.now, matchId: `m-${code}` });
  const base = transportLink(hub.create('p0'), 'host');
  let cb: ((m: HostMessage) => void) | null = null;
  const sent: unknown[] = [];
  const link: Link = {
    ...base,
    send: (m) => {
      sent.push(m);
      base.send(m);
    },
    onMessage: (f) => {
      cb = f;
      return base.onMessage(f);
    },
  };
  const c = new TableClient(link, 'Victim', undefined, {}, { now: () => clock.now });
  c.join();
  host.start();
  for (let i = 0; i < 20 && !(c.state.view && host.phase === 'playing'); i++) {
    clock.now += 500;
    host.tick();
  }
  expect(c.state.view).not.toBeNull();
  return { clock, host, c, sent, inject: (m: unknown) => cb?.(m as HostMessage) };
}

/** What the client has filed, as it would save it, with its flags and its last error line left out. */
const filed = (c: TableClient) => {
  const { tamper: _t, state, ...rest } = c.serialize();
  const { lastError: _e, lastErrorCode: _c, ...st } = state;
  void _t;
  void _e;
  void _c;
  return JSON.stringify({ ...rest, state: st });
};
/** What the client shows, its last error line left out. */
const shown = (c: TableClient) => {
  const { lastError: _e, lastErrorCode: _c, ...st } = c.state;
  void _e;
  void _c;
  return JSON.stringify(st);
};

describe('a malformed frame on a playing table', () => {
  it('each malformed variant of each frame type: not shown, not acted on, nothing filed, and the hand on show fails', () => {
    const t = playing('INM');
    const flags = () => (t.c as unknown as { tamper: Map<number, string[]> }).tamper.get(0) ?? [];
    const variants = malformedVariants();
    expect(variants.length).toBeGreaterThanOrEqual(150);
    for (const v of variants) {
      const before = { shown: shown(t.c), filed: filed(t.c), sent: t.sent.length };
      t.inject(v.frame);
      const what = `${v.t}.${v.field} ${v.how}`;
      expect(shown(t.c), what).toBe(before.shown);
      expect(filed(t.c), what).toBe(before.filed);
      expect(t.sent.length, what).toBe(before.sent);
      expect(flags().map(failureKey), what).toContain(v.t === 'commits' && v.field === 'commits' ? 'commitsMalformed' : 'malformedFrame');
      expect(t.c.state.lastError, what).not.toBeNull();
    }
    // The hand plays on, and its audit fails over them.
    for (let i = 0; i < 2_000 && t.c.state.lastResult === null; i++) {
      t.clock.now += 1_000;
      t.host.tick();
    }
    expect(t.c.state.auditStatus).toBe('failed');
    expect(t.c.state.auditFailures.map(failureKey)).toEqual(expect.arrayContaining(['malformedFrame', 'commitsMalformed']));
  });

  it('the same frames well formed are taken (a chat line, a pong, a clock frame for the turn on show)', () => {
    const t = playing('INW');
    t.inject({ t: 'chat', seat: 1, name: 'P1', text: 'gg' });
    expect(t.c.state.chat.map((l) => l.text)).toEqual(['gg']);
    t.inject({ t: 'clock', now: t.clock.now, hand: 0, tc: t.c.state.view!.turnCounter });
    expect((t.c as unknown as { tamper: Map<number, string[]> }).tamper.get(0) ?? []).toEqual([]);
  });
});

const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
/** The seat's own moves in the hand so far. */
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;
/** The turn of the hand on the table, when the table owes the phone's seat its third discard and shows it. */
const thirdDiscard = (w: Wire) => w.host.phase === 'playing' && !!w.host.game && w.discardTurn() && w.current() && mine(w) >= 2;
/** The state the host sends is the one that shows the seat its third discard turn (its own turn, not a claim). */
const thirdDue = (w: Wire, m: Extract<HostMessage, { t: 'state' }>) =>
  !!w.host.game && w.owes() && mine(w) >= 2 && w.host.game.turnCounter === m.view.turnCounter && legalActions(w.host.game, 0).every((a) => a.type === 'discard');
const moved = new WeakSet<Wire>();
/**
 * On turn `target`, a second after the phone was shown it, the seat makes a legal discard the table's timeout rule would
 * not make (once): so the table's own move, when the clock runs out, is another.
 */
function moveOn(w: Wire, target: number | null): void {
  const g = w.host.game;
  if (target === null || moved.has(w) || !g || w.host.phase !== 'playing' || g.turnCounter !== target || !w.current()) return;
  if (w.clock.now - (w.shown.get(target) ?? Infinity) < 1_000) return;
  const timeout = host(w).timeoutAction(g, 0);
  const move = legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
  if (!move) return;
  moved.add(w);
  w.c.act(move);
}

/**
 * Normal. On the seat's third discard turn the seat's move is dropped on its way (the table never sees it) and the
 * server answers it with a refusal: `notc`, code `illegal` and no turn; `notSeated`, code `not_seated` and no turn; `tc`,
 * code `illegal` with the turn the move was made on; `silent`, none. The seat does not try again, and the table plays its
 * own move when the clock runs out.
 */
function refused(code: string, mode: 'notc' | 'notSeated' | 'tc' | 'silent') {
  let target: number | null = null;
  let dropped = 0;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? Infinity : 600),
    onTick: (w) => moveOn(w, target),
    map: (m, w) => {
      if (target === null && m.t === 'state' && thirdDue(w, m)) target = m.view.turnCounter;
      return m;
    },
    upFilter: (m, w) => {
      if (m.t !== 'action' || target === null || m.turnCounter !== target) return true;
      if (dropped++ === 0) {
        if (mode === 'notc') w.line.inject({ t: 'error', code: 'illegal', message: 'That move is not allowed now.' } as HostMessage);
        if (mode === 'notSeated') w.line.inject({ t: 'error', code: 'not_seated', message: 'Join the table first.' } as HostMessage);
        if (mode === 'tc') w.line.inject({ t: 'error', code: 'illegal', message: 'That move is not allowed now.', turnCounter: m.turnCounter });
      }
      return false;
    },
  });
  w.finish();
  const entry = target === null ? undefined : w.c.state.lastAudit?.log.find((e) => e.seat === 0 && e.n === target);
  return { w, attacked: dropped > 0 && !!entry && entry.source !== 'player' };
}

/**
 * Normal. On the seat's third discard turn its move is dropped on its way and the server answers `not_seated`, with no
 * turn, on the connection it seated the phone on; the seat, told its move went nowhere, makes another legal discard, and
 * the table plays that one (so the table never moves for it, and no clock rule is reached).
 */
function notSeatedThenOwn(code: string) {
  let target: number | null = null;
  let first: Action | null = null;
  let second = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? Infinity : 600),
    onTick: (w) => {
      moveOn(w, target);
      const g = w.host.game;
      if (second || first === null || !g || g.turnCounter !== target || w.c.state.lastErrorCode !== 'not_seated') return;
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
      if (m.t !== 'action' || target === null || m.turnCounter !== target || first !== null) return true;
      first = m.action;
      w.line.inject({ t: 'error', code: 'not_seated', message: 'Join the table first.' } as HostMessage);
      return false;
    },
  });
  w.finish();
  const entry = target === null ? undefined : w.c.state.lastAudit?.log.find((e) => e.seat === 0 && e.n === target);
  return { w, attacked: second && !!entry && entry.source === 'player' };
}

describe('a refusal that names no turn', () => {
  it('a legal move dropped and answered "not seated" on the connection the table seated the phone on, then another move of the seat played in its place: red (it was once green)', () =>
    scenario((i) => {
      const a = notSeatedThenOwn(`INO${i}`);
      need(a.attacked);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['seatDenied', 'moveDropped'] });
    }));

  it('"not seated" where an honest table sends it: to a connection it took the seat away on (a club eviction), or never seated the phone on: nothing failed', () => {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'INE', rules: NORMAL, matchId: 'm-INE' });
    const down: HostMessage[] = [];
    const tap = (id: string): Link => {
      const base = transportLink(hub.create(id), 'host');
      return { ...base, onMessage: (cb) => base.onMessage((m) => (down.push(m), cb(m))) };
    };
    const a = new TableClient(tap('pA'), 'A', undefined, { userId: 'user-evicted-1' });
    a.join();
    expect(a.state.seat).toBe(0);
    host.evictUser('user-evicted-1');
    a.chat('gg');
    // A full table seats nobody on the fifth connection: it is answered as one that holds no seat.
    for (const id of ['pB', 'pC', 'pD', 'pE']) new TableClient(transportLink(hub.create(id), 'host'), id).join();
    const e = new TableClient(tap('pF'), 'F');
    e.join();
    e.chat('gg');
    expect(down.filter((m) => m.t === 'error').map((m) => (m as { code: string }).code)).toEqual(['evicted', 'not_seated', 'full', 'not_seated']);
    expect(a.serialize().tamper).toEqual([]);
    expect(e.serialize().tamper).toEqual([]);
  });

  it('a legal move dropped and refused as illegal with no turn named: red, the refusal is malformed (it was once green); named: red, a legal move refused', () =>
    scenario((i) => {
      const a = refused(`INR${i}`, 'notc');
      need(a.attacked);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['malformedFrame']));
      const b = refused(`INR${i}`, 'tc');
      need(b.attacked);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['legalMoveRefused'] });
    }));

  it('the same refused as not seated, with no turn: red, an answer an honest table gives only to a connection it seats no one on; it excuses nothing, so the move counts as one the table ignored, as when no refusal comes', () =>
    scenario((i) => {
      // (And once the seat's next move on that link is played, the table played it over one it never answered in order,
      // `moveDropped`.)
      const a = refused(`INS${i}`, 'notSeated');
      need(a.attacked);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['seatDenied', 'moveIgnored']));
      const b = refused(`INS${i}`, 'silent');
      need(b.attacked);
      expect(b.w.verdict().status).toBe('failed');
      expect(b.w.verdict().failures).toEqual(expect.arrayContaining(['moveIgnored']));
      expect(b.w.verdict().failures).not.toEqual(expect.arrayContaining(['seatDenied']));
    }));
});

/**
 * Normal. On the seat's third discard turn the server delivers the host's state, then a copy of it edited by `edit`
 * (`copy`), or delivers only the edited state (`only`). The seat makes its move 1 s after the turn was shown; the
 * server drops it, and the table plays its own move when the clock runs out.
 */
function edited(code: string, edit: ((m: Extract<HostMessage, { t: 'state' }>) => Record<string, unknown>) | null, how: 'copy' | 'only') {
  let target: number | null = null;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: (_k, tc) => (tc === target ? Infinity : 600),
    onTick: (w) => moveOn(w, target),
    map: (m, w) => {
      if (target !== null || m.t !== 'state' || !thirdDue(w, m)) return m;
      target = m.view.turnCounter;
      return how === 'only' && edit ? (edit(m) as unknown as HostMessage) : m;
    },
    after: (m) => (how === 'copy' && edit && m.t === 'state' && m.view.turnCounter === target ? [edit(m) as unknown as HostMessage] : []),
    upFilter: (m) => !(m.t === 'action' && target !== null && m.turnCounter === target),
  });
  w.finish();
  return { w, target };
}

describe('a state the phone cannot file', () => {
  it('a copy of the turn’s state with no turn counter in its view: red, the copy is malformed (it was once shown, and the move made on it went out unrecorded); without the copy: red, the move was ignored', () =>
    scenario((i) => {
      const a = edited(`INT${i}`, (m) => ({ ...m, view: { ...m.view, turnCounter: undefined } }), 'copy');
      need(a.target !== null);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['malformedFrame']));
      const b = edited(`INT${i}`, null, 'copy');
      need(b.target !== null);
      expect(b.w.verdict().status).toBe('failed');
      expect(b.w.verdict().failures).toEqual(expect.arrayContaining(['moveIgnored']));
    }));

  it('the turn’s state with no hash, or its deadline sent as text: red, malformed, never shown (each was once shown and left unchecked)', () =>
    scenario((i) => {
      const a = edited(`INH${i}`, (m) => ({ ...m, hash: undefined }), 'only');
      need(a.target !== null);
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['malformedFrame']));
      const b = edited(`IND${i}`, (m) => ({ ...m, deadline: String((m.now as number) + 3_000) }), 'only');
      need(b.target !== null);
      expect(b.w.verdict().failures).toEqual(expect.arrayContaining(['malformedFrame']));
      for (const w of [a.w, b.w]) expect(w.verdict().status).toBe('failed');
    }));

  it('a time bank or a time-bank flag of the wrong type, and a stamp that is not a number, are malformed too', () =>
    scenario((i) => {
      for (const [k, edit] of [
        ['B', (m: Extract<HostMessage, { t: 'state' }>) => ({ ...m, timeBank: '30' })],
        ['F', (m: Extract<HostMessage, { t: 'state' }>) => ({ ...m, inTimeBank: 'no' })],
        ['S', (m: Extract<HostMessage, { t: 'state' }>) => ({ ...m, now: String(m.now) })],
      ] as const) {
        const a = edited(`INX${k}${i}`, edit, 'only');
        need(a.target !== null);
        expect(a.w.verdict().failures, k).toEqual(expect.arrayContaining(['malformedFrame']));
      }
    }));
});

/** A table move the seat's own clock did not allow is still judged when it comes with a malformed frame first. */
describe('a malformed frame does not excuse the table', () => {
  it('a move the table makes for the seat 2 s into its turn after a malformed clock frame: red, both named', () =>
    scenario((i) => {
      let played = false;
      const w = wire({
        code: `INE${i}`,
        rules: NORMAL,
        botDelayMs: 700,
        think: () => 5_000,
        onTick: (w) => {
          const g = w.host.game;
          if (played || !g || !thirdDiscard(w) || w.clock.now - (w.shown.get(g.turnCounter) ?? Infinity) < 2_000) return;
          w.line.inject({ t: 'clock', now: 'soon', hand: 0, tc: g.turnCounter } as unknown as HostMessage);
          host(w).apply(0, host(w).timeoutAction(g, 0), 'timeout');
          played = true;
        },
      });
      w.finish();
      need(played);
      expect(w.verdict().status).toBe('failed');
      expect(w.verdict().failures).toEqual(expect.arrayContaining(['malformedFrame', 'playedEarly']));
    }));
});
