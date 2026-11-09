/**
 * Recorded Pro decisions, replayed as a regression gate.
 *
 * A reference hand is a seed and the whole action log of a hand played by one Pro seat against
 * three Club seats, compactly encoded. Replaying the log with the rules engine alone (no bot code)
 * rebuilds every state exactly, so the gate can ask today's Pro what it would do at each point
 * where the recorded Pro had a real choice and compare the answer with the recorded one.
 *
 * Regenerate after an intentional change to Pro: `npm run sim -- --record-reference`.
 */
import { applyAction, chooseAction, legalActions, newGame, sameAction, type Action, type BotSkill, type GameState } from '../../src/index';

export interface ReferenceHand {
  seed: string;
  proSeat: number;
  /** Space-separated actions: seat digit then code (d<tile> discard, x pass, h 胡, p 碰, k<tile> 槓, c<tile>.<tile> 吃). */
  log: string;
  /** Indices into the log where the Pro seat chose between two or more legal actions. */
  points: number[];
}

export interface ReferenceFile {
  note: string;
  hands: ReferenceHand[];
}

export function encodeAction(seat: number, a: Action): string {
  switch (a.type) {
    case 'discard':
      return `${seat}d${a.tile}`;
    case 'pass':
      return `${seat}x`;
    case 'hu':
      return `${seat}h`;
    case 'pong':
      return `${seat}p`;
    case 'kong':
      return `${seat}k${a.tile}`;
    case 'chi':
      return `${seat}c${a.tiles[0]}.${a.tiles[1]}`;
  }
}

export function decodeAction(code: string): { seat: number; action: Action } {
  const seat = Number(code[0]);
  const rest = code.slice(2);
  switch (code[1]) {
    case 'd':
      return { seat, action: { type: 'discard', tile: Number(rest) } };
    case 'x':
      return { seat, action: { type: 'pass' } };
    case 'h':
      return { seat, action: { type: 'hu' } };
    case 'p':
      return { seat, action: { type: 'pong' } };
    case 'k':
      return { seat, action: { type: 'kong', tile: Number(rest) } };
    case 'c': {
      const [a, b] = rest.split('.').map(Number);
      return { seat, action: { type: 'chi', tiles: [a, b] } };
    }
  }
  throw new Error(`bad action code ${code}`);
}

/** Play one hand (Pro in `proSeat`, Club elsewhere) and record it with its decision points. */
export function recordHand(seed: string, proSeat: number): ReferenceHand {
  let s = newGame(seed);
  const log: string[] = [];
  const points: number[] = [];
  for (let guard = 0; s.phase !== 'ended' && guard < 3000; guard++) {
    for (let seat = 0; seat < 4; seat++) {
      const skill: BotSkill = seat === proSeat ? 'pro' : 'club';
      const a = chooseAction(s, seat, { seed: `t${seat}`, skill });
      if (!a) continue;
      if (seat === proSeat && legalActions(s, seat).length >= 2) points.push(log.length);
      log.push(encodeAction(seat, a));
      s = applyAction(s, seat, a);
      break;
    }
  }
  return { seed, proSeat, log: log.join(' '), points };
}

export interface ReplayResult {
  decisions: number;
  agree: number;
  /** Claim windows where the recorded Pro claimed (吃, 碰 or 槓), and how many of those today's Pro still takes. */
  claims: number;
  claimsKept: number;
}

/** Replay recorded hands and count how often today's Pro makes the recorded decision. */
export function replayReference(hands: readonly ReferenceHand[]): ReplayResult {
  const r: ReplayResult = { decisions: 0, agree: 0, claims: 0, claimsKept: 0 };
  for (const h of hands) {
    let s: GameState = newGame(h.seed);
    const codes = h.log.split(' ');
    const points = new Set(h.points);
    codes.forEach((code, i) => {
      const { seat, action } = decodeAction(code);
      if (points.has(i)) {
        const now = chooseAction(s, h.proSeat, { seed: 'gate', skill: 'pro' });
        const same = now !== null && sameAction(now, action, s, h.proSeat);
        r.decisions++;
        if (same) r.agree++;
        if (s.phase === 'claim' && (action.type === 'chi' || action.type === 'pong' || action.type === 'kong')) {
          r.claims++;
          if (same) r.claimsKept++;
        }
      }
      s = applyAction(s, seat, action);
    });
  }
  return r;
}
