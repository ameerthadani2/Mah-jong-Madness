/**
 * Scenarios drawn from a seed. An honest scenario holds only what an honest server, network and phone do (`HONEST_ACTS`):
 * cuts, delays and stalls within the stated bounds, lost answers to pings, app restarts and resumes, a saved record that
 * failed to be written, a reinstall, the player really opening the seat on another phone, a server restart, sleep, and
 * an app update when a second build is loaded. A mixed scenario adds one or two attacks, each a chain of steps the
 * server takes, each step drawn from its part of the vocabulary and set on the moment the step before it began or ended:
 * - a disruption (a cut, a restart or resume of the app, a notice, a stand-in, an eviction, the table said to be gone, a
 *   server restart, a new phone), at a moment of the match;
 * - a concealment (states withheld while pings are answered, a stall, lost answers to pings, a slow link);
 * - an exploitation (moves written into the log as the player's or the table's, a move of the player's lost and answered
 *   any way, a changed view, a share picked again, a hand's result withheld);
 * - a cover-up (the player's app restarted or resumed, the table said to be gone, a new phone, a cut).
 * Any step may be missing; the rest of the chain then sets on the moment of the match the missing step would have.
 */
import { Rng } from './random';
import { CLOCKS, type Act, type Anchor, type Event, type MoveKind, type Scenario, type Speed, type StateKind } from './scenario';

/**
 * `honest` and `mixed` as above; `direct`: attacks without the concealment a mixed chain adds after a cut at the deal's
 * ceremony, so the rules that concealment would trip decide nothing and the rules behind them decide alone: a cut at the
 * commit request (the hand dealt with a stand-in share) followed at once by moves written for the seat; a cut at the reveal
 * (the share sent again on the next link) followed by moves written for the seat, or by the deal's frames lost on that link
 * while the table plays the seat; and the app's own records (other tables filling the archive, a storage that refuses the
 * archive's writes, a slow journal, a resume or restart right after the evidence). Its own stream of draws: the seeds of
 * `honest` and `mixed` name the same scenarios as before it.
 */
export type Mode = 'honest' | 'mixed' | 'direct';

export interface GenOptions {
  /** A second build is loaded: honest scenarios may hold an app update. */
  update?: boolean;
}

const SPEEDS: ReadonlyArray<readonly [Speed, number]> = [
  ['normal', 4],
  ['turbo', 2],
  ['fast', 1.5],
  ['relaxed', 1],
  ['hyper', 1.5],
];

function moment(rng: Rng, hands: number, prefer?: Array<readonly [Anchor['on'], number]>): Anchor {
  const hand = rng.int(0, hands - 1);
  const on = rng.weighted(
    prefer ?? [
      ['state', 5],
      ['move', 3],
      ['commit', 1],
      ['reveal', 1],
      ['deal', 1],
      ['result', 1],
    ],
  );
  const ms = rng.weighted([
    [0, 4],
    [1, 2],
    [500, 1],
    [2_000, 1],
  ]);
  switch (on) {
    case 'state':
      return { on, hand, kind: rng.weighted<StateKind>([['any', 3], ['own', 2], ['claim', 1.5], ['win', 1], ['other', 1.5]]), k: rng.int(1, 4), ms };
    case 'move':
      return { on, hand, kind: rng.weighted<MoveKind>([['any', 3], ['discard', 2], ['claim', 1], ['hu', 1], ['pass', 1]]), k: rng.int(1, 3), ms };
    case 'result':
      return { on, hand: Math.max(0, Math.min(hand, hands - 2)), ms };
    default:
      return { on, hand, ms } as Anchor;
  }
}

const after = (event: number, edge: 'start' | 'end', ms = 0): Anchor => ({ on: 'after', event, edge, ...(ms ? { ms } : {}) });

// ------------------------------------------------------------------- honest acts

function honestAct(rng: Rng, opts: GenOptions): Act {
  const kinds: Array<readonly [Act['a'], number]> = [
    ['cut', 5],
    ['latency', 2],
    ['stall', 2],
    ['pingLoss', 1.5],
    ['restart', 3],
    ['resume', 2],
    ['fresh', 0.7],
    ['saveFails', 0.7],
    ['otherDevice', 1.5],
    ['serverRestart', 1],
    ['sleep', 1.5],
  ];
  if (opts.update) kinds.push(['update', 4]);
  const a = rng.weighted(kinds);
  switch (a) {
    case 'cut':
      return { a, downMs: rng.pick([500, 1_000, 3_000, 8_000, 15_000]), ...(rng.chance(0.3) ? { half: true } : {}), ...(rng.chance(0.35) ? { lose: true } : {}), ...(rng.chance(0.2) ? { noPing: true } : {}) };
    case 'latency':
      return { a, ms: rng.pick([100, 300, 800, 1_500]), forMs: rng.pick([5_000, 20_000, 60_000]) };
    case 'stall':
      return { a, forMs: rng.pick([1_000, 3_000, 6_000, 9_000]) };
    case 'pingLoss':
      return { a, rate: rng.pick([0.5, 0.9, 1]), forMs: rng.pick([10_000, 60_000]) };
    case 'restart':
      return { a, downMs: rng.pick([1_000, 3_000, 10_000]) };
    case 'resume':
      return { a, afterMs: rng.pick([0, 500, 2_000]) };
    case 'fresh':
      return { a, afterMs: rng.pick([2_000, 10_000]) };
    case 'saveFails':
      return { a };
    case 'update':
      return { a, downMs: rng.pick([500, 1_000, 3_000]) };
    case 'otherDevice':
      return { a, forMs: rng.pick([3_000, 10_000, 30_000]) };
    case 'serverRestart':
      return { a, downMs: rng.pick([1_000, 3_000]) };
    default:
      return { a: 'sleep', forMs: rng.pick([2_000, 10_000, 30_000]), mono: rng.chance(0.5) ? 'stops' : 'runs' };
  }
}

/** Where an honest event happens: an update between hands, a lost share at the reveal, the rest anywhere. */
function honestAnchor(rng: Rng, act: Act, hands: number): Anchor {
  if (act.a === 'update' && hands > 1 && rng.chance(0.6)) return { on: 'result', hand: rng.int(0, hands - 2), ms: rng.pick([300, 1_000, 3_000]) };
  if (act.a === 'cut' && act.lose && rng.chance(0.4)) return { on: rng.pick(['reveal', 'commit'] as const), hand: rng.int(0, hands - 1) };
  return moment(rng, hands);
}

// ------------------------------------------------------------------- the server's acts

function disruption(rng: Rng): Act {
  const a = rng.weighted<Act['a']>([
    ['cut', 3],
    ['restart', 2],
    ['resume', 1],
    ['seatTaken', 1.5],
    ['elsewhere', 1],
    ['evicted', 1.5],
    ['gone', 0.7],
    ['standIn', 0.4],
    ['restored', 0.5],
    ['newMatch', 0.3],
    ['fresh', 0.4],
    ['serverRestart', 0.5],
  ]);
  switch (a) {
    case 'cut':
      return { a, downMs: rng.pick([1_000, 3_000, 9_000, 12_000, 20_000]), ...(rng.chance(0.4) ? { half: true } : {}), ...(rng.chance(0.5) ? { lose: true } : {}), ...(rng.chance(0.25) ? { noPing: true } : {}) };
    case 'restart':
      return { a, downMs: rng.pick([1_000, 3_000, 10_000]) };
    case 'resume':
      return { a, afterMs: rng.pick([0, 1_000, 3_000]) };
    case 'seatTaken':
      return { a, resumeMs: rng.pick([1_000, 3_000, 10_000]) };
    case 'elsewhere':
      return { a, downMs: rng.pick([1_000, 3_000]), resumeMs: rng.pick([1_000, 3_000, 10_000]) };
    case 'evicted':
      return { a, back: rng.weighted<'none' | 'afterTable' | number>([['afterTable', 3], ['none', 1], [5_000, 1], [20_000, 1]]) };
    case 'gone':
      return { a, route: rng.pick(['same', 'moved', 'expired', 'pushed', 'stale', 'fakeEnd'] as const), reseatMs: rng.pick([3_000, 8_000]) };
    case 'restored':
      return { a, back: rng.int(0, 3) };
    case 'fresh':
      return { a, afterMs: rng.pick([2_000, 8_000]) };
    case 'serverRestart':
      return { a, downMs: rng.pick([1_000, 3_000]) };
    default:
      return { a } as Act;
  }
}

/** The moments a disruption is set on, by kind (a cut around the deal or a result, a notice on a decision, ...). */
function disruptionAnchor(rng: Rng, act: Act, hands: number): Anchor {
  switch (act.a) {
    case 'cut':
      return moment(rng, hands, [['result', 2], ['commit', 2], ['reveal', 2.5], ['state', 2.5], ['move', 1], ['deal', 0.5]]);
    case 'standIn':
      return moment(rng, hands, [['commit', 2], ['reveal', 1], ['deal', 1], ['state', 1]]);
    case 'gone':
    case 'fresh':
      return moment(rng, hands, [['state', 3], ['result', 1]]);
    default:
      return moment(rng, hands, [['state', 4], ['move', 1.5], ['deal', 0.5], ['result', 0.5]]);
  }
}

function concealment(rng: Rng): Act {
  const a = rng.weighted<Act['a']>([
    ['withhold', 5],
    ['stall', 0.5],
    ['drop', 0.6],
    ['latency', 0.4],
  ]);
  switch (a) {
    case 'withhold':
      return {
        a,
        what: rng.chance(0.85) ? 'states' : 'all',
        forMs: rng.weighted<number | 'hand' | 'line'>([['hand', 3.5], ['line', 2.5], [5_000, 1], [20_000, 1.5], [60_000, 1]]),
        release: rng.weighted<'fresh' | 'held' | 'none'>([['fresh', 2], ['held', 1], ['none', 2]]),
      };
    case 'stall':
      return { a, forMs: rng.pick([6_000, 12_000, 20_000]) };
    case 'drop':
      return { a, what: rng.pick(['pong', 'state', 'clock'] as const), forMs: rng.pick([5_000, 20_000, 60_000]) };
    default:
      return { a: 'latency', ms: rng.pick([2_000, 5_000, 12_000]), forMs: rng.pick([10_000, 30_000]) };
  }
}

function exploitation(rng: Rng): Act {
  const a = rng.weighted<Act['a']>([
    ['forge', 4.5],
    ['dropMove', 3.5],
    ['doctor', 1],
    ['repick', 0.3],
    ['withholdRecord', 0.4],
    ['dup', 0.3],
    ['reorder', 0.3],
  ]);
  switch (a) {
    case 'forge':
      return { a, label: rng.chance(0.75) ? 'player' : 'auto', policy: rng.chance(0.7) ? 'other' : 'timeout', n: rng.weighted<number | 'hand'>([['hand', 2], [1, 2], [3, 2]]), delayMs: rng.pick([0, 300, 800, 3_000]) };
    case 'dropMove':
      return {
        a,
        kind: rng.weighted<MoveKind>([['any', 2], ['hu', 1.5], ['claim', 1.5], ['discard', 1], ['pass', 0.5]]),
        busy: rng.chance(0.6),
        refuse: rng.weighted<'none' | 'now' | 'afterState'>([['none', 2], ['now', 1], ['afterState', 2]]),
        code: rng.weighted([['illegal', 3], ['not_playing', 1], ['wrong_seat', 0.5], ['busy', 0.5], ['zzz', 0.5], ['not_seated', 0.5]]),
        turn: rng.weighted<'same' | 'before' | 'none'>([['same', 3], ['before', 1], ['none', 1]]),
        times: rng.pick([1, 2, 2]),
        ...(rng.chance(0.4) ? { contested: true } : {}),
      };
    case 'doctor':
      return { a, field: rng.pick(['scores', 'tile', 'offer', 'drawn'] as const), n: rng.int(1, 3) };
    case 'dup':
      return { a, n: rng.int(1, 3) };
    default:
      return { a } as Act;
  }
}

function coverUp(rng: Rng): Act {
  const a = rng.weighted<Act['a']>([
    ['resume', 2],
    ['restart', 1.5],
    ['gone', 1.5],
    ['fresh', 0.5],
    ['cut', 1],
    ['seatTaken', 1],
  ]);
  switch (a) {
    case 'resume':
      return { a, afterMs: rng.pick([0, 1_000, 3_000]) };
    case 'restart':
      return { a, downMs: rng.pick([1_000, 3_000]) };
    case 'gone':
      return { a, route: rng.pick(['same', 'moved', 'expired', 'pushed', 'stale', 'fakeEnd'] as const), reseatMs: rng.pick([3_000, 8_000]) };
    case 'fresh':
      return { a, afterMs: rng.pick([2_000, 8_000]) };
    case 'cut':
      return { a, downMs: rng.pick([1_000, 5_000]) };
    default:
      return { a: 'seatTaken', resumeMs: rng.pick([1_000, 3_000]) };
  }
}

/** One attack: its steps, appended to `events`. */
function chain(rng: Rng, hands: number, events: Event[]): void {
  let prev: number | null = null;
  const add = (at: Anchor, act: Act) => {
    events.push({ at, do: act });
    prev = events.length - 1;
  };
  if (rng.chance(0.7)) {
    let d = disruption(rng);
    const at = disruptionAnchor(rng, d, hands);
    // A cut at the deal's ceremony matters most when the message it was set on is lost with it, or the server keeps
    // the seat as if the link were up.
    if (d.a === 'cut' && (at.on === 'commit' || at.on === 'reveal')) d = { a: 'cut', downMs: d.downMs, ...(rng.chance(0.5) ? { half: true } : {}), ...(rng.chance(0.7) ? { lose: true } : {}), ...(d.noPing ? { noPing: true } : {}) };
    add(at, d);
  }
  if (rng.chance(0.65)) {
    const c = concealment(rng);
    add(prev === null ? moment(rng, hands) : rng.chance(0.75) ? after(prev, 'end') : after(prev, 'start', rng.pick([0, 1])), c);
  }
  if (rng.chance(0.85)) {
    const x = exploitation(rng);
    const at = prev === null ? moment(rng, hands) : rng.chance(0.7) ? after(prev, 'start', rng.pick([0, 0, 300, 1_000])) : after(prev, 'end', rng.pick([0, 1_000]));
    // A lost move set on a moment of the match waits for the move it is for: at the deal of a hand, any of its moves.
    add(x.a === 'dropMove' && at.on !== 'after' && rng.chance(0.5) ? { on: 'deal', hand: 'hand' in at ? (at as { hand: number }).hand : 0 } : at, x);
  }
  if (prev !== null && rng.chance(0.3)) add(after(prev, 'end', rng.pick([0, 1_000, 2_000, 6_000])), coverUp(rng));
}

/**
 * One attack of the `direct` mode: its steps, appended to `events`. True when the attack needs the fastest clock (a table
 * move for the seat timed after the seat's whole clock, while the deal's frames are still lost: the scenario then plays at
 * `hyper`, four seconds a turn and no bank, so the link stays quiet for less than its watch allows).
 */
function directChain(rng: Rng, hands: number, events: Event[]): boolean {
  const base = events.length;
  const at = (i: number, edge: 'start' | 'end', ms = 0): Anchor => after(base + i, edge, ms);
  const hand = rng.int(0, hands - 1);
  const forge = (): Act => ({ a: 'forge', label: rng.chance(0.75) ? 'player' : 'auto', policy: rng.chance(0.7) ? 'other' : 'timeout', n: rng.weighted<number | 'hand'>([['hand', 2], [1, 2], [3, 2]]), delayMs: rng.pick([0, 300, 800, 3_000]) });
  const kind = rng.weighted<'standIn' | 'reveal' | 'crowded' | 'archive' | 'journal' | 'window'>([
    ['standIn', 3],
    ['reveal', 2],
    ['crowded', 1],
    ['archive', 1],
    ['journal', 0.7],
    ['window', 1.3],
  ]);
  switch (kind) {
    case 'standIn':
      // The link cut at the commit request (the hand dealt with a stand-in share), then moves written for the seat while
      // it is down or once it is back, with no hold between: the stand-in ledger decides alone.
      events.push({ at: { on: 'commit', hand, ms: rng.pick([0, 1, 500]) }, do: { a: 'cut', downMs: rng.pick([3_000, 9_000, 20_000]), ...(rng.chance(0.5) ? { half: true } : {}), ...(rng.chance(0.8) ? { lose: true } : {}) } });
      events.push({ at: rng.chance(0.6) ? at(0, 'start', rng.pick([300, 1_000, 3_000])) : at(0, 'end', rng.pick([0, 1_000])), do: rng.chance(0.85) ? forge() : { a: 'repick' } });
      break;
    case 'reveal':
      // The link cut at the reveal (the share sent again on the next link), then either moves written for the seat at
      // once, or the deal's frames lost on that link for a while, every frame or the states, with the join's ping lost or
      // not, and the table playing the seat meanwhile: nothing but the link the share went out on says the deal was due
      // on it (the reveal-link rule decides alone).
      events.push({ at: { on: 'reveal', hand, ms: rng.pick([0, 1, 500]) }, do: { a: 'cut', downMs: rng.pick([1_000, 3_000, 9_000]), ...(rng.chance(0.5) ? { half: true } : {}), lose: true, ...(rng.chance(0.5) ? { noPing: true } : {}) } });
      if (rng.chance(0.3)) {
        events.push({ at: at(0, 'end', rng.pick([0, 1_000])), do: rng.chance(0.85) ? forge() : { a: 'repick' } });
        break;
      }
      {
        // The table's move for the seat once its whole clock (`hyper`: four seconds) could have run out, so no timing
        // check of the move decides either.
        const playAt = CLOCKS.hyper.turn * 1_000 + rng.pick([500, 2_000]);
        events.push({ at: { on: 'deal', hand }, do: { a: 'drop', what: rng.chance(0.7) ? 'any' : 'state', forMs: playAt + rng.pick([2_000, 5_000]) } });
        events.push({ at: at(1, 'start', playAt), do: rng.chance(0.7) ? { a: 'forge', label: 'auto', policy: 'timeout', n: 1, delayMs: 0 } : forge() });
      }
      return true;
    case 'crowded':
      // The table said gone, other tables leaving Home meanwhile, moves written for the seat while it is away.
      events.push({ at: moment(rng, hands, [['state', 3], ['move', 1]]), do: { a: 'gone', route: 'pushed', reseatMs: rng.pick([8_000, 20_000]), others: rng.pick([3, 12, 20, 31, 40]) } });
      events.push({ at: at(0, 'start', rng.pick([1_000, 3_000])), do: forge() });
      break;
    case 'archive':
      // A storage that refuses the archive's writes, the table given up and sat at again (or said gone), then a cold start.
      events.push({ at: moment(rng, hands, [['state', 2], ['deal', 1]]), do: { a: 'saveFails', what: 'archive' } });
      events.push({ at: at(0, 'end', rng.pick([2_000, 8_000])), do: rng.chance(0.6) ? { a: 'leave', backMs: rng.pick([3_000, 8_000]) } : { a: 'gone', route: rng.pick(['same', 'pushed'] as const), reseatMs: rng.pick([3_000, 8_000]) } });
      events.push({ at: at(1, 'start', rng.pick([1_000, 2_000])), do: { a: 'restart', downMs: rng.pick([1_000, 3_000]) } });
      if (rng.chance(0.5)) events.push({ at: at(1, 'start', 500), do: forge() });
      break;
    case 'journal':
      // A slow journal (honest), with or without moves written for the seat meanwhile.
      events.push({ at: moment(rng, hands, [['state', 3], ['move', 1]]), do: { a: 'slowJournal', ms: rng.pick([5_000, 20_000, 45_000]), forMs: rng.pick([1_500, 20_000, 60_000]) } });
      if (rng.chance(0.5)) events.push({ at: at(0, 'start', rng.pick([500, 3_000])), do: forge() });
      break;
    default: {
      // Evidence (a changed view, a move lost and answered any way, a move written for the seat), then a resume or a
      // restart right after it, within the save delay or just past it.
      const x = exploitation(rng);
      events.push({ at: x.a === 'dropMove' ? { on: 'deal', hand } : moment(rng, hands), do: x });
      events.push({ at: at(0, 'end', rng.pick([0, 100, 300, 600])), do: rng.chance(0.7) ? { a: 'resume', afterMs: rng.pick([0, 1_000]) } : { a: 'restart', downMs: rng.pick([1_000, 3_000]) } });
    }
  }
  return false;
}

export function generate(seed: number, mode: Mode, opts: GenOptions = {}): Scenario {
  if (mode === 'direct') return generateDirect(seed);
  const rng = new Rng(seed ^ (mode === 'honest' ? 0x5bd1e995 : 0x27d4eb2f));
  const hands = rng.weighted([
    [1, 4],
    [2, 4],
    [3, 2],
  ]);
  const think = rng.pick<[number, number]>([
    [300, 800],
    [600, 1_500],
    [1_000, 3_000],
    [2_000, 6_000],
  ]);
  const s: Scenario = {
    seed,
    speed: rng.weighted(SPEEDS),
    hands,
    othersPresent: rng.chance(0.65),
    botDelayMs: rng.pick([300, 700, 700, 1_200]),
    player: {
      thinkMs: think,
      retry: { kind: rng.weighted<'none' | 'same' | 'other'>([['none', 1], ['same', 1], ['other', 2]]), afterMs: rng.pick([0, 500, 1_500, 3_000]) },
      readyMs: rng.chance(0.15) ? null : rng.pick([300, 1_000, 3_000]),
    },
    events: [],
  };
  if (mode === 'mixed') {
    const n = rng.chance(0.6) ? 1 : 2;
    for (let i = 0; i < n; i++) chain(rng, hands, s.events);
    if (s.events.length === 0) chain(rng, hands, s.events);
  }
  const noise = mode === 'honest' ? rng.weighted([[0, 1], [1, 3], [2, 3], [3, 1]]) : rng.weighted([[0, 3], [1, 2], [2, 1]]);
  for (let i = 0; i < noise; i++) {
    const act = honestAct(rng, opts);
    s.events.push({ at: honestAnchor(rng, act, hands), do: act });
  }
  // With a second build loaded, half the honest tables also lose the player's share at the first deal: an update then
  // finds a record whose audit names a restarted deal (what the saved record of the earlier build holds differs most).
  if (mode === 'honest' && opts.update && rng.chance(0.5)) s.events.push({ at: { on: rng.pick(['reveal', 'commit'] as const), hand: 0 }, do: { a: 'cut', downMs: rng.pick([1_000, 3_000]), lose: true } });
  return s;
}

/** A scenario of the `direct` mode (its own stream of draws). */
function generateDirect(seed: number): Scenario {
  const rng = new Rng(seed ^ 0x3c6ef372);
  const hands = rng.weighted([
    [1, 3],
    [2, 4],
    [3, 2],
  ]);
  const s: Scenario = {
    seed,
    speed: rng.weighted(SPEEDS),
    hands,
    othersPresent: rng.chance(0.65),
    botDelayMs: rng.pick([300, 700, 700, 1_200]),
    player: {
      thinkMs: rng.pick<[number, number]>([
        [300, 800],
        [600, 1_500],
        [1_000, 3_000],
      ]),
      retry: { kind: rng.weighted<'none' | 'same' | 'other'>([['none', 1], ['same', 1], ['other', 2]]), afterMs: rng.pick([0, 500, 1_500]) },
      readyMs: rng.chance(0.15) ? null : rng.pick([300, 1_000, 3_000]),
    },
    events: [],
  };
  const n = rng.chance(0.7) ? 1 : 2;
  let hyper = false;
  for (let i = 0; i < n; i++) hyper = directChain(rng, hands, s.events) || hyper;
  if (hyper) s.speed = 'hyper';
  if (rng.chance(0.4)) {
    const act = honestAct(rng, {});
    s.events.push({ at: honestAnchor(rng, act, hands), do: act });
  }
  return s;
}
