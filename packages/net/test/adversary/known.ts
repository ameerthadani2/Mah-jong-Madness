/**
 * The gaps unit 20f's checks found, each as a scenario in the fuzzer's vocabulary, with a control: the same attack
 * without the step that made it pass. On the code those checks ran on (d6745d5) each gap's scenario fails the oracle the
 * way the gap was reported, and each control shows red; once a gap is closed its scenario passes. The fuzzer finds
 * these by itself from generated seeds (soak.ts); these fixed forms keep each one in the test that runs in CI.
 *
 * R6 needs the build an app update replaces (`ADVERSARY_OLD_TREE`, load.ts): without it the update is not modelled.
 */
import type { Player, Scenario } from './scenario';

const player = (o: Partial<Player> = {}): Player => ({ thinkMs: [1_000, 1_000], retry: { kind: 'none', afterMs: 0 }, readyMs: 500, ...o });
const table = (seed: number, o: Partial<Scenario> = {}): Scenario => ({ seed, speed: 'normal', hands: 1, othersPresent: false, botDelayMs: 700, player: player(), events: [], ...o });

export interface KnownCase {
  /** The gap (oracle.ts `KNOWN` and `FOUND`) or the gap it controls, or a rule of the audit (`rule:...`). */
  gap: string;
  /**
   * `gap`: the attack, which fails the oracle while the gap is open; `control`: red on any code that checks what it should;
   * `limit`: a case docs/FAIRNESS.md states as a limit, amber (never green) on any code that keeps the limit as stated.
   */
  role: 'gap' | 'control' | 'limit';
  what: string;
  make: (seed: number) => Scenario;
  /** A seed whose deal brings the moment the attack needs (a declared win, a claim window): 1 unless said. */
  seed?: number;
}

/** N2's table and attack: hand 2's frames held back from the phone after a short cut, its turns written as the player's. */
const n2Table: Partial<Scenario> = { speed: 'turbo', hands: 3, othersPresent: true, player: player({ thinkMs: [2_000, 6_000], retry: { kind: 'same', afterMs: 1_500 }, readyMs: 3_000 }) };
const n2Attack: Scenario['events'] = [
  { at: { on: 'result', hand: 1, ms: 1 }, do: { a: 'cut', downMs: 1_000 } },
  { at: { on: 'after', event: 0, edge: 'end' }, do: { a: 'withhold', what: 'all', forMs: 'hand', release: 'none' } },
  { at: { on: 'after', event: 1, edge: 'start', ms: 300 }, do: { a: 'forge', label: 'player', policy: 'timeout', n: 3, delayMs: 0 } },
];

/** The laundered pass's table and attack: a pass of the player's dropped, later a declared win dropped and a pass written in its place. */
const launder = (s: number, cut: boolean): Scenario =>
  table(s, {
    othersPresent: true,
    events: [
      { at: { on: 'deal', hand: 0 }, do: { a: 'dropMove', kind: 'pass', busy: true, refuse: 'none', code: 'illegal', turn: 'same', times: 1 } },
      { at: { on: 'deal', hand: 0 }, do: { a: 'dropMove', kind: 'hu', busy: true, refuse: 'none', code: 'illegal', turn: 'same', times: 1 } },
      { at: { on: 'after', event: 1, edge: 'end' }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 0 } },
      ...(cut ? [{ at: { on: 'after' as const, event: 2, edge: 'end' as const }, do: { a: 'cut' as const, downMs: 3_000 } }] : []),
    ],
  });

/** The journal cap's table: the table said gone, `others` other tables leaving Home meanwhile, the seat's turns written as the player's. */
const crowded = (s: number, others: number): Scenario =>
  table(s, {
    othersPresent: true,
    events: [
      { at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 500 }, do: { a: 'gone', route: 'pushed', reseatMs: 20_000, others } },
      { at: { on: 'after', event: 0, edge: 'start', ms: 3_000 }, do: { a: 'forge', label: 'player', policy: 'other', n: 3, delayMs: 300 } },
    ],
  });

/**
 * H1 (unit 20g): an honest table where the player plays on another phone while the app is stopped; the restarted app
 * resumes the table twice in a row, so the welcome that would say another device held the seat goes to the first client
 * and never reaches it. With the app's journal the phone knows every move it sent, so it must learn of the other device:
 * the table's count of the seat's moves between devices (`welcome.handovers`) tells it.
 */
const h1: Partial<Scenario> = { player: player({ thinkMs: [600, 1_500], readyMs: 1_000 }), botDelayMs: 300 };

export const KNOWN_CASES: KnownCase[] = [
  {
    gap: 'H1',
    role: 'gap',
    seed: 1339,
    what: 'an honest table: the player plays on another phone while the app is stopped, and the welcome that says so is lost',
    make: (s) =>
      table(s, {
        ...h1,
        events: [
          { at: { on: 'state', hand: 0, kind: 'own', k: 2 }, do: { a: 'otherDevice', forMs: 30_000 } },
          { at: { on: 'state', hand: 0, kind: 'any', k: 3, ms: 1 }, do: { a: 'resume', afterMs: 2_000 } },
          { at: { on: 'state', hand: 0, kind: 'any', k: 3, ms: 1 }, do: { a: 'restart', downMs: 10_000 } },
        ],
      }),
  },
  // Rules of the audit every gap depends on.
  {
    gap: 'rule:view',
    role: 'control',
    what: 'a tile of the player\'s own hand changed in three views, their hashes kept',
    make: (s) => table(s, { events: [{ at: { on: 'deal', hand: 0 }, do: { a: 'doctor', field: 'tile', n: 3 } }] }),
  },
  {
    gap: 'rule:inFlight',
    role: 'limit',
    seed: 2,
    what: 'a discard lost on the server\'s side with no answer and the link cut right after it, the table playing its own move when the clock runs out',
    make: (s) =>
      table(s, {
        speed: 'turbo',
        hands: 2,
        othersPresent: true,
        player: player({ thinkMs: [1_000, 2_000], readyMs: 1_000 }),
        // (With the link up, the player's next move over it is played: an honest link delivers in order, so that is red.)
        events: [
          { at: { on: 'deal', hand: 0 }, do: { a: 'dropMove', kind: 'discard', busy: false, refuse: 'none', code: 'illegal', turn: 'same', times: 1 } },
          { at: { on: 'after', event: 0, edge: 'end', ms: 100 }, do: { a: 'cut', downMs: 20_000 } },
        ],
      }),
  },
  {
    gap: 'rule:inFlight',
    role: 'control',
    seed: 2,
    what: 'the same lost discard with the link kept up: the player\'s next move over it is played, so the lost one was dropped',
    make: (s) =>
      table(s, {
        speed: 'turbo',
        hands: 2,
        othersPresent: true,
        player: player({ thinkMs: [1_000, 2_000], readyMs: 1_000 }),
        events: [{ at: { on: 'deal', hand: 0 }, do: { a: 'dropMove', kind: 'discard', busy: false, refuse: 'none', code: 'illegal', turn: 'same', times: 1 } }],
      }),
  },
  {
    gap: 'R1',
    role: 'gap',
    what: 'link cut at hand 1 (the commit request lost with it), back after a stand-in share was dealt; the hand kept silent and played in the player\'s name',
    make: (s) =>
      table(s, {
        hands: 2,
        othersPresent: true,
        events: [
          { at: { on: 'result', hand: 0 }, do: { a: 'cut', downMs: 12_000 } },
          { at: { on: 'deal', hand: 1 }, do: { a: 'withhold', what: 'states', forMs: 'hand', release: 'none' } },
          { at: { on: 'deal', hand: 1 }, do: { a: 'forge', label: 'player', policy: 'other', n: 'hand', delayMs: 0 } },
        ],
      }),
  },
  {
    gap: 'R1',
    role: 'control',
    what: 'the same silent hand played in the player\'s name, with no cut (the phone committed to the deal)',
    make: (s) =>
      table(s, {
        hands: 2,
        othersPresent: true,
        events: [
          { at: { on: 'deal', hand: 1 }, do: { a: 'withhold', what: 'states', forMs: 'hand', release: 'none' } },
          { at: { on: 'deal', hand: 1 }, do: { a: 'forge', label: 'player', policy: 'other', n: 'hand', delayMs: 0 } },
        ],
      }),
  },
  {
    gap: 'R2',
    role: 'gap',
    what: 'a declared win dropped (answered busy), the player\'s next move played, then two refusals naming the win\'s turn after the next state',
    make: (s) =>
      table(s, {
        player: player({ retry: { kind: 'other', afterMs: 0 } }),
        events: [{ at: { on: 'move', hand: 0, kind: 'hu', k: 1 }, do: { a: 'dropMove', kind: 'hu', busy: true, refuse: 'afterState', code: 'illegal', turn: 'same', times: 2 } }],
      }),
  },
  {
    gap: 'R2',
    role: 'control',
    what: 'the same dropped win with no refusal at all',
    make: (s) =>
      table(s, {
        player: player({ retry: { kind: 'other', afterMs: 0 } }),
        events: [{ at: { on: 'move', hand: 0, kind: 'hu', k: 1 }, do: { a: 'dropMove', kind: 'hu', busy: true, refuse: 'none', code: 'illegal', turn: 'same', times: 1 } }],
      }),
  },
  {
    gap: 'R3',
    role: 'gap',
    what: 'an eviction notice at the player\'s own turn, the table times the seat out, then the host\'s welcome on the same link',
    make: (s) => table(s, { player: player({ thinkMs: [1_500, 1_500] }), events: [{ at: { on: 'state', hand: 0, kind: 'own', k: 1 }, do: { a: 'evicted', back: 'afterTable' } }] }),
  },
  {
    gap: 'R4',
    role: 'gap',
    what: 'a claim dropped (busy) while another seat\'s answer is open; that seat\'s answer played first; the player\'s next move falls on the next turn',
    make: (s) =>
      table(s, {
        hands: 4,
        player: player({ thinkMs: [300, 300], retry: { kind: 'other', afterMs: 3_000 } }),
        events: [{ at: { on: 'deal', hand: 0 }, do: { a: 'dropMove', kind: 'claim', busy: true, refuse: 'none', code: 'illegal', turn: 'same', times: 1, contested: true } }],
      }),
  },
  {
    gap: 'R5',
    role: 'gap',
    what: 'the reveal lost with a half-open link, revealed again on the next link, then the hand kept silent there while pings are answered',
    make: (s) =>
      table(s, {
        events: [
          { at: { on: 'reveal', hand: 0 }, do: { a: 'cut', downMs: 1_000, half: true, lose: true } },
          { at: { on: 'deal', hand: 0 }, do: { a: 'withhold', what: 'states', forMs: 'hand', release: 'none' } },
        ],
      }),
  },
  {
    gap: 'R5',
    role: 'control',
    what: 'the same silent hand with no cut',
    make: (s) => table(s, { events: [{ at: { on: 'deal', hand: 0 }, do: { a: 'withhold', what: 'states', forMs: 'hand', release: 'none' } }] }),
  },
  {
    gap: 'R6',
    role: 'gap',
    what: 'an honest table: hand 0\'s deal restarted (the share lost with the link), the app updated between hands and resumed (needs ADVERSARY_OLD_TREE)',
    make: (s) =>
      table(s, {
        hands: 2,
        player: player({ readyMs: null }),
        events: [
          { at: { on: 'reveal', hand: 0 }, do: { a: 'cut', downMs: 1_000, lose: true } },
          { at: { on: 'result', hand: 0, ms: 500 }, do: { a: 'update', downMs: 1_000 } },
        ],
      }),
  },
  {
    gap: 'R7',
    role: 'gap',
    what: 'the table frozen after another seat\'s turn (pings answered), three of the player\'s turns written as its own, then a Resume from Home',
    make: (s) =>
      table(s, {
        events: [
          { at: { on: 'state', hand: 0, kind: 'other', k: 4, ms: 1 }, do: { a: 'withhold', what: 'states', forMs: 'line', release: 'none' } },
          { at: { on: 'after', event: 0, edge: 'start' }, do: { a: 'forge', label: 'player', policy: 'other', n: 3, delayMs: 0 } },
          { at: { on: 'after', event: 1, edge: 'end', ms: 2_000 }, do: { a: 'resume', afterMs: 0 } },
        ],
      }),
  },
  {
    gap: 'S1',
    role: 'gap',
    what: 'an app restart, then every state held for 20 s while three of the player\'s turns are written as its own',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [2_000, 2_000] }),
        events: [
          { at: { on: 'state', hand: 0, kind: 'other', k: 4, ms: 1 }, do: { a: 'restart', downMs: 3_000 } },
          { at: { on: 'after', event: 0, edge: 'end' }, do: { a: 'withhold', what: 'states', forMs: 20_000, release: 'fresh' } },
          { at: { on: 'after', event: 0, edge: 'end' }, do: { a: 'forge', label: 'player', policy: 'other', n: 3, delayMs: 500 } },
        ],
      }),
  },
  {
    gap: 'S1',
    role: 'control',
    what: 'the same restart and forged moves, written once the restored app has been shown the table',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [2_000, 2_000] }),
        events: [
          { at: { on: 'state', hand: 0, kind: 'other', k: 4, ms: 1 }, do: { a: 'restart', downMs: 3_000 } },
          { at: { on: 'after', event: 0, edge: 'end', ms: 3_000 }, do: { a: 'forge', label: 'player', policy: 'other', n: 3, delayMs: 500 } },
        ],
      }),
  },
  {
    gap: 'S2',
    role: 'gap',
    what: 'a false seat-taken notice at the player\'s turn, a move written as the player\'s own 0.3 s later, Resume 3 s after the notice',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [3_000, 3_000] }),
        events: [
          { at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 500 }, do: { a: 'seatTaken', resumeMs: 3_000 } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 300 }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 0 } },
        ],
      }),
  },
  {
    gap: 'S2',
    role: 'control',
    what: 'the same move written as the player\'s own, with no notice',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [3_000, 3_000] }),
        events: [{ at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 800 }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 0 } }],
      }),
  },
  {
    gap: 'S3',
    role: 'gap',
    what: 'a move written as the player\'s own, then the table said gone and the account seated again at another room code running the same match',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [3_000, 3_000] }),
        events: [
          { at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 500 }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 0 } },
          { at: { on: 'after', event: 0, edge: 'end', ms: 6_000 }, do: { a: 'gone', route: 'moved', reseatMs: 5_000 } },
        ],
      }),
  },
  {
    gap: 'S3',
    role: 'control',
    what: 'the same, seated again at the same room code within the day',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [3_000, 3_000] }),
        events: [
          { at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 500 }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 0 } },
          { at: { on: 'after', event: 0, edge: 'end', ms: 6_000 }, do: { a: 'gone', route: 'same', reseatMs: 5_000 } },
        ],
      }),
  },
  {
    gap: 'N1',
    role: 'gap',
    seed: 2,
    what: 'hand 1\'s states held on the link that brought hand 0 (pings answered) while the table times the seat out, then that link cut',
    make: (s) =>
      table(s, {
        speed: 'turbo',
        hands: 2,
        player: player({ thinkMs: [600, 1_500], readyMs: 1_000 }),
        events: [
          { at: { on: 'result', hand: 0, ms: 1 }, do: { a: 'withhold', what: 'states', forMs: 'hand', release: 'none' } },
          { at: { on: 'state', hand: 1, kind: 'claim', k: 4 }, do: { a: 'cut', downMs: 1_000 } },
        ],
      }),
  },
  {
    gap: 'N1',
    role: 'control',
    what: 'the same held hand with no cut',
    make: (s) =>
      table(s, {
        speed: 'turbo',
        hands: 2,
        player: player({ thinkMs: [600, 1_500], readyMs: 1_000 }),
        events: [{ at: { on: 'result', hand: 0, ms: 1 }, do: { a: 'withhold', what: 'states', forMs: 'hand', release: 'none' } }],
      }),
  },
  {
    gap: 'N2',
    role: 'gap',
    seed: 1967,
    what: 'every frame of hand 2 held back from the rejoined phone (no commit request), three of its turns written as the player\'s own, then an app restart',
    make: (s) => table(s, { ...n2Table, events: [...n2Attack, { at: { on: 'after', event: 2, edge: 'end' }, do: { a: 'restart', downMs: 1_000 } }] }),
  },
  {
    gap: 'N2',
    role: 'control',
    seed: 1967,
    what: 'the same hand held back and played in the player\'s name, with no restart',
    make: (s) => table(s, { ...n2Table, events: n2Attack }),
  },
  {
    gap: 'N3',
    role: 'gap',
    what: 'the link cut right after the commit request (the hand dealt with a stand-in share), the table\'s own move for the seat 0.3 s into the hand',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [600, 1_500] }),
        events: [
          { at: { on: 'commit', hand: 0 }, do: { a: 'cut', downMs: 1_000 } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 300 }, do: { a: 'forge', label: 'auto', policy: 'timeout', n: 1, delayMs: 300 } },
        ],
      }),
  },
  {
    gap: 'N3',
    role: 'control',
    what: 'the same early move with the link cut at the deal instead',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [600, 1_500] }),
        events: [
          { at: { on: 'deal', hand: 0 }, do: { a: 'cut', downMs: 1_000 } },
          { at: { on: 'after', event: 0, edge: 'start' }, do: { a: 'forge', label: 'auto', policy: 'timeout', n: 1, delayMs: 300 } },
        ],
      }),
  },
  {
    gap: 'N5',
    role: 'gap',
    seed: 2,
    what: 'a discard lost on the server\'s side with no answer, the table playing its own move when the clock runs out (amber inFlight), then an app restart later in the hand',
    make: (s) =>
      table(s, {
        speed: 'fast',
        hands: 2,
        othersPresent: true,
        player: player({ thinkMs: [1_000, 2_000], readyMs: 1_000 }),
        events: [
          { at: { on: 'deal', hand: 0 }, do: { a: 'dropMove', kind: 'discard', busy: true, refuse: 'none', code: 'illegal', turn: 'none', times: 1 } },
          { at: { on: 'state', hand: 0, kind: 'own', k: 4 }, do: { a: 'restart', downMs: 3_000 } },
        ],
      }),
  },
  {
    gap: 'N4',
    role: 'gap',
    seed: 409,
    what: 'an honest table: the server restarts during hand 1\'s deal and again at the player\'s first turn of it',
    make: (s) =>
      table(s, {
        hands: 2,
        botDelayMs: 1_200,
        player: player({ thinkMs: [2_000, 6_000], readyMs: 300 }),
        events: [
          { at: { on: 'state', hand: 1, kind: 'any', k: 1, ms: 1 }, do: { a: 'serverRestart', downMs: 1_000 } },
          { at: { on: 'commit', hand: 1 }, do: { a: 'serverRestart', downMs: 1_000 } },
        ],
      }),
  },
  // What unit 20h closed (on d5e6158 each gap's scenario fails the oracle as described; each control is red on both).
  {
    gap: 'launder',
    role: 'gap',
    seed: 9,
    what: 'a pass of the player\'s dropped (the table\'s own pass stands in), later a declared win dropped, a pass written in the player\'s name in its place and the link cut',
    make: (s) => launder(s, true),
  },
  {
    gap: 'launder',
    role: 'control',
    seed: 9,
    what: 'the same with the link kept up',
    make: (s) => launder(s, false),
  },
  {
    gap: 'slowLink',
    role: 'gap',
    seed: 472,
    what: 'an honest table: the connection slows toward the table by 6.5 s for 40 s, and the player tries another move when one seems lost',
    make: (s) =>
      table(s, {
        speed: 'hyper',
        hands: 5,
        botDelayMs: 300,
        player: player({ thinkMs: [600, 1_500], retry: { kind: 'other', afterMs: 1_500 }, readyMs: 3_000 }),
        events: [{ at: { on: 'move', hand: 0, kind: 'pass', k: 1, ms: 1 }, do: { a: 'latency', ms: 6_500, forMs: 40_000 } }],
      }),
  },
  {
    gap: 'slowJournal',
    role: 'gap',
    what: 'an honest table: one write of the journal of moves takes 45 s (a slow storage), so the move goes out after the table timed the seat out',
    make: (s) => table(s, { events: [{ at: { on: 'state', hand: 0, kind: 'own', k: 2 }, do: { a: 'slowJournal', ms: 45_000, forMs: 1_500 } }] }),
  },
  {
    gap: 'N6',
    role: 'gap',
    seed: 1053,
    what: 'the dealer\'s link cut 0.1 s after its turn 0 was shown, and the state of turn 0 dropped on the new link while the table times the seat out',
    make: (s) =>
      table(s, {
        player: player({ thinkMs: [6_000, 14_000] }),
        events: [
          { at: { on: 'state', hand: 0, kind: 'any', k: 1, ms: 1 }, do: { a: 'cut', downMs: 300 } },
          { at: { on: 'after', event: 0, edge: 'start' }, do: { a: 'drop', what: 'state', forMs: 5_000 } },
        ],
      }),
  },
  {
    gap: 'N6',
    role: 'control',
    seed: 1053,
    what: 'the same hold at the dealer\'s first turn of hand 1',
    make: (s) =>
      table(s, {
        hands: 2,
        player: player({ thinkMs: [6_000, 14_000] }),
        events: [
          { at: { on: 'state', hand: 1, kind: 'own', k: 1, ms: 1 }, do: { a: 'cut', downMs: 300 } },
          { at: { on: 'after', event: 0, edge: 'start' }, do: { a: 'drop', what: 'state', forMs: 5_000 } },
        ],
      }),
  },
  {
    gap: 'R1',
    role: 'gap',
    what: 'R1 in the first hand of a match: the link cut at its commit request (lost with it), two moves written in the player\'s name 0.3 s in',
    make: (s) =>
      table(s, {
        hands: 2,
        events: [
          { at: { on: 'commit', hand: 0, ms: 1 }, do: { a: 'cut', downMs: 20_000, lose: true } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 300 }, do: { a: 'forge', label: 'player', policy: 'other', n: 2, delayMs: 800 } },
        ],
      }),
  },
  {
    gap: 'restarts',
    role: 'gap',
    seed: 300462,
    what: 'an honest table: the server restarts at the commit request, then the phone\'s share is lost with its link at the reveal (one attempt more than the old cap)',
    make: (s) =>
      table(s, {
        speed: 'turbo',
        player: player({ thinkMs: [600, 1_500], retry: { kind: 'same', afterMs: 1_500 } }),
        events: [
          { at: { on: 'commit', hand: 0 }, do: { a: 'serverRestart', downMs: 1_000 } },
          { at: { on: 'reveal', hand: 0 }, do: { a: 'cut', downMs: 1_000, lose: true } },
        ],
      }),
  },
  {
    gap: 'meld',
    role: 'gap',
    what: 'a state whose other seat holds a set that is not one (refused at intake, the hand failed; before, the player\'s own engine calls threw on it)',
    make: (s) => table(s, { events: [{ at: { on: 'state', hand: 0, kind: 'any', k: 3 }, do: { a: 'doctor', field: 'meld', n: 1 } }] }),
  },
  {
    gap: 'journalCap',
    role: 'gap',
    what: 'the table said gone, 12 other tables leaving Home meanwhile (the journal used to keep 12 matches), three of the seat\'s turns written as the player\'s, then seated again',
    make: (s) => crowded(s, 12),
  },
  {
    gap: 'journalCap',
    role: 'control',
    what: 'the same with no other table',
    make: (s) => crowded(s, 0),
  },
  {
    gap: 'journalCap',
    role: 'limit',
    what: 'the same with 32 other tables (more than 31 push the record out: amber, the end not verified)',
    make: (s) => crowded(s, 32),
  },
  {
    gap: 'archiveWrite',
    role: 'gap',
    seed: 3,
    what: 'an honest table: given up and sat at again, the storage then refusing the archive\'s writes, given up again, the app started cold, sat at again',
    make: (s) =>
      table(s, {
        othersPresent: true,
        events: [
          { at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 500 }, do: { a: 'leave', backMs: 3_000 } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 100 }, do: { a: 'saveFails', what: 'archive' } },
          { at: { on: 'state', hand: 0, kind: 'own', k: 6, ms: 500 }, do: { a: 'leave', backMs: 8_000 } },
          { at: { on: 'after', event: 2, edge: 'start', ms: 2_000 }, do: { a: 'restart', downMs: 2_000 } },
        ],
      }),
  },
  {
    gap: 'saveWindow',
    role: 'gap',
    seed: 101251,
    what: 'a move lost and answered busy, refused twice after the next state; the player leaves for Home and resumes 1 s later (within the save delay)',
    make: (s) => saveWindow(s, 0),
  },
  {
    gap: 'saveWindow',
    role: 'control',
    seed: 101251,
    what: 'the same with the resume 1.5 s later (after the save)',
    make: (s) => saveWindow(s, 500),
  },
  {
    gap: 'recordLost',
    role: 'gap',
    seed: 3362,
    what: 'the app stopped late in a match and the table said gone meanwhile, three other tables leaving Home before it is seated again (the record kept)',
    make: (s) =>
      table(s, {
        speed: 'turbo',
        hands: 3,
        player: player({ thinkMs: [6_000, 14_000], readyMs: 1_000 }),
        events: [
          { at: { on: 'move', hand: 2, kind: 'any', k: 3, ms: 500 }, do: { a: 'restart', downMs: 10_000 } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 1_000 }, do: { a: 'gone', route: 'pushed', reseatMs: 3_000 } },
        ],
      }),
  },
  {
    gap: 'recordLost',
    role: 'gap',
    seed: 3516,
    what: 'the server says another device held the seat, holds states, says the table is gone; the resumed client takes the record up, and the reseat finds it in the saved slot',
    make: (s) =>
      table(s, {
        speed: 'hyper',
        player: player({ thinkMs: [2_000, 6_000], readyMs: null }),
        events: [
          { at: { on: 'move', hand: 0, kind: 'discard', k: 3 }, do: { a: 'elsewhere', downMs: 1_000, resumeMs: 10_000 } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 1 }, do: { a: 'withhold', what: 'states', forMs: 5_000, release: 'held' } },
          { at: { on: 'after', event: 1, edge: 'end' }, do: { a: 'gone', route: 'expired', reseatMs: 8_000 } },
          { at: { on: 'state', hand: 0, kind: 'claim', k: 2, ms: 1 }, do: { a: 'latency', ms: 9_000, forMs: 15_000 } },
        ],
      }),
  },
  {
    gap: 'N1w',
    role: 'gap',
    seed: 100025,
    what: 'N1 after a rejoin welcome: the link cut at the reveal (half, the share lost), the states held on the new link while pings are answered, then an app restart ends that link',
    make: (s) =>
      table(s, {
        speed: 'hyper',
        player: player({ thinkMs: [300, 800], readyMs: 3_000 }),
        events: [
          { at: { on: 'reveal', hand: 0, ms: 500 }, do: { a: 'cut', downMs: 20_000, half: true, lose: true } },
          { at: { on: 'after', event: 0, edge: 'end' }, do: { a: 'withhold', what: 'states', forMs: 'line', release: 'none' } },
          { at: { on: 'after', event: 1, edge: 'end' }, do: { a: 'restart', downMs: 3_000 } },
        ],
      }),
  },
  {
    gap: 'N1w',
    role: 'control',
    seed: 100025,
    what: 'the same hold with no restart: the link stays up',
    make: (s) =>
      table(s, {
        speed: 'hyper',
        player: player({ thinkMs: [300, 800], readyMs: 3_000 }),
        events: [
          { at: { on: 'reveal', hand: 0, ms: 500 }, do: { a: 'cut', downMs: 20_000, half: true, lose: true } },
          { at: { on: 'after', event: 0, edge: 'end' }, do: { a: 'withhold', what: 'states', forMs: 'line', release: 'none' } },
        ],
      }),
  },
  // The oracle's own rules, where the triage of the long runs found it wrong (the phone was right): each passes.
  {
    gap: 'oracle:lostPass',
    role: 'gap',
    seed: 104141,
    what: 'a pass lost while another seat\'s claim closed the window, then the player\'s own claim: nothing was taken',
    make: (s) =>
      table(s, {
        speed: 'hyper',
        hands: 2,
        player: player({ thinkMs: [300, 800], retry: { kind: 'none', afterMs: 1_500 }, readyMs: 1_000 }),
        events: [{ at: { on: 'move', hand: 1, kind: 'any', k: 2 }, do: { a: 'dropMove', kind: 'any', busy: true, refuse: 'none', code: 'busy', turn: 'same', times: 2, contested: true } }],
      }),
  },
  {
    gap: 'oracle:elsewhereSameRun',
    role: 'gap',
    seed: 101263,
    what: 'a move written in the player\'s name after an app restart, before the restored client\'s welcome, which says another device held the seat',
    make: (s) =>
      table(s, {
        speed: 'turbo',
        hands: 2,
        player: player({ thinkMs: [600, 1_500], readyMs: 1_000 }),
        events: [
          { at: { on: 'state', hand: 1, kind: 'any', k: 4 }, do: { a: 'restart', downMs: 3_000 } },
          { at: { on: 'after', event: 0, edge: 'end' }, do: { a: 'latency', ms: 5_000, forMs: 10_000 } },
          { at: { on: 'after', event: 1, edge: 'start' }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 3_000 } },
          { at: { on: 'state', hand: 1, kind: 'own', k: 4, ms: 1 }, do: { a: 'elsewhere', downMs: 3_000, resumeMs: 10_000 } },
        ],
      }),
  },
  {
    gap: 'oracle:otherDeviceRefusal',
    role: 'gap',
    seed: 101988,
    what: 'a move answered not_playing just as the player\'s other device takes the seat (honest)',
    make: (s) =>
      table(s, {
        speed: 'fast',
        hands: 2,
        botDelayMs: 300,
        player: player({ thinkMs: [2_000, 6_000], readyMs: 3_000 }),
        events: [
          { at: { on: 'move', hand: 0, kind: 'any', k: 1, ms: 2_000 }, do: { a: 'restart', downMs: 10_000 } },
          { at: { on: 'after', event: 0, edge: 'end' }, do: { a: 'withhold', what: 'states', forMs: 'line', release: 'none' } },
          { at: { on: 'after', event: 1, edge: 'start' }, do: { a: 'dropMove', kind: 'any', busy: true, refuse: 'now', code: 'not_playing', turn: 'same', times: 1 } },
          { at: { on: 'move', hand: 1, kind: 'discard', k: 1 }, do: { a: 'otherDevice', forMs: 30_000 } },
        ],
      }),
  },
  // Rules the generated sample misses (a mutant of each passes it): each fails the oracle on code that breaks the rule.
  {
    gap: 'rule:early',
    role: 'control',
    what: 'the table\'s own move for the seat 0.3 s into its turn, the link up',
    make: (s) => table(s, { othersPresent: true, events: [{ at: { on: 'state', hand: 0, kind: 'own', k: 2 }, do: { a: 'forge', label: 'auto', policy: 'timeout', n: 1, delayMs: 300 } }] }),
  },
  {
    gap: 'rule:refused',
    role: 'control',
    what: 'a legal discard refused at once, naming its turn',
    make: (s) => table(s, { othersPresent: true, events: [{ at: { on: 'deal', hand: 0 }, do: { a: 'dropMove', kind: 'discard', busy: false, refuse: 'now', code: 'illegal', turn: 'same', times: 1 } }] }),
  },
  {
    gap: 'rule:kept',
    role: 'control',
    what: 'the table said gone, the account seated again under another room code, a move written in the player\'s name meanwhile: the record found by its match at the welcome',
    make: (s) =>
      table(s, {
        othersPresent: true,
        events: [
          { at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 500 }, do: { a: 'gone', route: 'moved', reseatMs: 8_000 } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 2_000 }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 300 } },
        ],
      }),
  },
  {
    gap: 'rule:stale',
    role: 'control',
    what: 'the app closed with the table in its saved slot and opened 13 h later, a move written in the player\'s name meanwhile: the stale record kept in the archive',
    make: (s) =>
      table(s, {
        othersPresent: true,
        events: [
          { at: { on: 'state', hand: 0, kind: 'own', k: 2, ms: 500 }, do: { a: 'gone', route: 'stale', reseatMs: 8_000 } },
          { at: { on: 'after', event: 0, edge: 'start', ms: 2_000 }, do: { a: 'forge', label: 'player', policy: 'other', n: 1, delayMs: 300 } },
        ],
      }),
  },
  {
    gap: 'rule:malformed',
    role: 'gap',
    seed: 2,
    what: 'a state with its turn number sent as text (refused at intake, red), and the app restarted 0.1 s later: the red hand kept apart comes back',
    make: (s) =>
      table(s, {
        othersPresent: true,
        events: [
          { at: { on: 'state', hand: 0, kind: 'any', k: 3 }, do: { a: 'doctor', field: 'turn', n: 1 } },
          { at: { on: 'after', event: 0, edge: 'end', ms: 100 }, do: { a: 'restart', downMs: 1_000 } },
        ],
      }),
  },
  {
    gap: 'rule:journal',
    role: 'gap',
    what: 'an honest table: the app restarts 0.1 s after a move, before its save; the journal holds the move',
    make: (s) => table(s, { othersPresent: true, events: [{ at: { on: 'move', hand: 0, kind: 'discard', k: 2, ms: 100 }, do: { a: 'restart', downMs: 1_000 } }] }),
  },
];

/** The save window's attack: a move lost, answered busy and refused twice after the next state; the resume `late` ms after the 1 s. */
function saveWindow(s: number, late: number): Scenario {
  return table(s, {
    speed: 'fast',
    player: player({ thinkMs: [300, 800], retry: { kind: 'other', afterMs: 1_500 }, readyMs: 3_000 }),
    events: [
      { at: { on: 'commit', hand: 0, ms: 500 }, do: { a: 'dropMove', kind: 'any', busy: true, refuse: 'afterState', code: 'busy', turn: 'same', times: 2, contested: true } },
      { at: { on: 'after', event: 0, edge: 'end', ms: late }, do: { a: 'resume', afterMs: 1_000 } },
    ],
  });
}

