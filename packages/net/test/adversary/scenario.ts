/**
 * A scenario: a table, the player at seat 0, and a list of events. Each event is something the server does (most of
 * them against the player), something the network does, or something that happens to the player's phone, each at a
 * moment of the match (`Anchor`). Scenarios are plain data: they print as JSON, and a printed one replays exactly.
 *
 * The vocabulary (`Act`):
 * - the network: `cut` (the link breaks and the phone reconnects later; `half`: the server does not notice; `lose`: the
 *   frame the cut was set on is lost with it; `noPing`: the ping the app sends right behind its join does not reach the
 *   table), `latency`, `stall` (every frame held, then let through in order),
 *   `pingLoss` (answers to pings lost at random), `dup` (states sent twice), `reorder` (two frames swap places);
 * - withholding: `withhold` (the hand's states and clock frames kept from the phone while its pings are answered, or
 *   everything, for a while, for the rest of the hand, or until the phone is on another link; at the end the table as
 *   it stands, the held frames, or nothing);
 * - notices: `seatTaken` and `elsewhere` (the seat was opened on another device, falsely; the player resumes from Home),
 *   `evicted` (taken back with a welcome on the same link, or not), `restored` (a restart notice of the server's own
 *   making), `standIn`;
 * - the log: `forge` (a move for the player's seat written as the player's own, or as the table's, at once or late);
 * - views: `doctor` (a state's view changed, its hash kept);
 * - answers: `dropMove` (a move of the player's lost on the server's side, answered `busy`, with refusals of any code
 *   naming any turn, at once or after the next state, or not at all; `contested`: only a claim made while another
 *   seat's answer to the same discard is still open);
 * - the deal and the match: `repick` (the server's share chosen again after the phone revealed), `newMatch` (a welcome
 *   naming another match), `withholdRecord` (a hand's result kept from the phone);
 * - the app: `restart` (the app stops and starts from its saved record), `resume` (the player leaves for Home and resumes
 *   the table), `gone` (the server says the table is gone, then seats the account there again, by one of several routes),
 *   `fresh` (the account seated again on a phone with no record), `saveFails` (the app's saves stop being written),
 *   `update` (an app update between two builds);
 * - honest company: `otherDevice` (the player really opens the seat on another phone, plays there, and comes back),
 *   `serverRestart` (the server restarts and restores the table), `sleep` (the phone sleeps or the app is in the
 *   background).
 * Which of them an honest server, network or phone can do is `HONEST_ACTS`.
 */

export type Speed = 'relaxed' | 'normal' | 'fast' | 'turbo' | 'hyper';
export const CLOCKS: Record<Speed, { turn: number; bank: number }> = {
  relaxed: { turn: 30, bank: 60 },
  normal: { turn: 15, bank: 30 },
  fast: { turn: 10, bank: 20 },
  turbo: { turn: 7, bank: 10 },
  hyper: { turn: 4, bank: 0 },
};

/** A decision the table shows the player: its own discard turn, a claim it may make on a discard, a win; `other`: a state of another seat's turn. */
export type StateKind = 'any' | 'own' | 'claim' | 'win' | 'other';
export type MoveKind = 'any' | 'hu' | 'claim' | 'discard' | 'pass';

/** When an event happens: a moment of the match as the server sees it, then `ms` later. */
export type Anchor = (
  | { on: 'commit'; hand: number }
  | { on: 'reveal'; hand: number }
  | { on: 'deal'; hand: number }
  | { on: 'state'; hand: number; k: number; kind: StateKind }
  | { on: 'move'; hand: number; k: number; kind: MoveKind }
  | { on: 'result'; hand: number }
  | { on: 'after'; event: number; edge: 'start' | 'end' }
) & { ms?: number };

export type FrameKind = 'pong' | 'state' | 'clock' | 'any';
export type GoneRoute = 'same' | 'moved' | 'expired' | 'pushed' | 'stale' | 'fakeEnd';

export type Act =
  | { a: 'cut'; downMs: number; half?: boolean; lose?: boolean; noPing?: boolean }
  | { a: 'latency'; ms: number; forMs: number }
  | { a: 'stall'; forMs: number }
  | { a: 'pingLoss'; rate: number; forMs: number }
  | { a: 'drop'; what: FrameKind; forMs: number }
  | { a: 'dup'; n: number }
  | { a: 'reorder' }
  | { a: 'withhold'; what: 'states' | 'all'; forMs: number | 'hand' | 'line'; release: 'fresh' | 'held' | 'none' }
  | { a: 'seatTaken'; resumeMs: number }
  | { a: 'elsewhere'; downMs: number; resumeMs: number }
  | { a: 'evicted'; back: 'none' | 'afterTable' | number }
  | { a: 'restored'; back: number }
  | { a: 'standIn' }
  | { a: 'forge'; label: 'player' | 'auto'; policy: 'other' | 'timeout'; n: number | 'hand'; delayMs: number }
  | { a: 'doctor'; field: 'scores' | 'tile' | 'offer' | 'drawn'; n: number }
  | { a: 'dropMove'; kind: MoveKind; busy: boolean; refuse: 'none' | 'now' | 'afterState'; code: string; turn: 'same' | 'before' | 'none'; times: number; contested?: boolean }
  | { a: 'repick' }
  | { a: 'newMatch' }
  | { a: 'withholdRecord' }
  | { a: 'restart'; downMs: number }
  | { a: 'resume'; afterMs: number }
  | { a: 'gone'; route: GoneRoute; reseatMs: number }
  | { a: 'fresh'; afterMs: number }
  | { a: 'saveFails' }
  | { a: 'update'; downMs: number }
  | { a: 'otherDevice'; forMs: number }
  | { a: 'serverRestart'; downMs: number }
  | { a: 'sleep'; forMs: number; mono: 'stops' | 'runs' };

export type ActName = Act['a'];

export interface Event {
  at: Anchor;
  do: Act;
}

/** How the player plays: how long each move takes, what it does when a move seems to go nowhere, when it presses Next. */
export interface Player {
  thinkMs: [number, number];
  /** After an error, or when a move has had no effect `afterMs` later: try nothing more, the same move, or another one (also avoiding the failed one at its next move of that hand). */
  retry: { kind: 'none' | 'same' | 'other'; afterMs: number };
  /** When it presses Next after a hand's result (null: never; the table deals on its own clock). */
  readyMs: number | null;
}

export interface Scenario {
  /** Seeds the deals (the secrets), the tokens and the player's thinking times. */
  seed: number;
  speed: Speed;
  hands: number;
  /** The table goes on while the phone is away (other people sit at it): a table with nobody human waits between hands. */
  othersPresent: boolean;
  botDelayMs: number;
  player: Player;
  events: Event[];
}

/** The acts an honest server, an honest network and an honest phone can do. */
export const HONEST_ACTS: ReadonlySet<ActName> = new Set<ActName>(['cut', 'latency', 'stall', 'pingLoss', 'restart', 'resume', 'fresh', 'saveFails', 'update', 'otherDevice', 'serverRestart', 'sleep']);

/** Honest when every event is: what the oracle then holds the verdicts to is that none is red. */
export const isHonest = (s: Scenario): boolean => s.events.every((e) => HONEST_ACTS.has(e.do.a));

const anchorText = (a: Anchor): string => {
  const ms = a.ms ? `+${a.ms}` : '';
  switch (a.on) {
    case 'commit':
    case 'reveal':
    case 'deal':
    case 'result':
      return `${a.on}(${a.hand})${ms}`;
    case 'state':
    case 'move':
      return `${a.on}(${a.hand},${a.kind}#${a.k})${ms}`;
    case 'after':
      return `${a.edge}(e${a.event})${ms}`;
  }
};

/** One line per event: `e2 forge{label:player,...} @ state(0,own#2)+300`. */
export function describe(s: Scenario): string[] {
  return s.events.map((e, i) => {
    const { a, ...rest } = e.do;
    const args = Object.entries(rest)
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    return `e${i} ${a}{${args}} @ ${anchorText(e.at)}`;
  });
}
