/**
 * Shared pieces for the puzzles (from puzzles.ts), above all for the table puzzles (defence, claim, value): the
 * difficulty, how a puzzle shows a meld and a seat, the explanation every puzzle gives, a pool of tiles to deal a table
 * from, random sets and a ready hand, the table built around a puzzle, the counts of steps to ready and of the tiles
 * that take a hand further, and the names of tiles and seats in both languages.
 */
import type { GameState, PlayerState } from './game';
import { isComplete, relevantKinds, shanten, type Counts } from './hand';
import type { Meld, MeldType } from './meld';
import { shuffle, WALL_RNG_VERSION, type Rng } from './rng';
import { DEFAULT_RULES } from './rules';
import { kindInfo, kindOf, KIND_WIND, NUM_PLAY_KINDS, NUM_TILES, sortTiles, SUIT_EN, type Kind, type TileId } from './tiles';

export type PuzzleDifficulty = 1 | 2 | 3;

/** An exposed (or concealed-kong) set as a puzzle shows it. */
export interface PuzzleMeld {
  type: MeldType;
  kinds: Kind[];
  concealed: boolean;
  /** Seat the claimed tile came from (absolute seat). */
  from?: number;
}

/** What another seat shows at the table: exposed sets and discards (oldest first). */
export interface PuzzleSeatView {
  /** Absolute seat; the solver always sits in seat 0, so 1 is on the right, 2 opposite, 3 on the left. */
  seat: number;
  melds: PuzzleMeld[];
  discards: Kind[];
}

/** Explanation shown after answering: a stable key plus English and Taiwanese Mandarin text. */
export interface PuzzleExplanation {
  reasonKey: string;
  explanation: string;
  explanationZh: string;
}

/** Remaining copies of each playable kind while a table is being dealt out. */
export class TilePool {
  readonly left = new Array<number>(NUM_PLAY_KINDS).fill(4);

  take(k: Kind, n = 1): boolean {
    if (this.left[k] < n) return false;
    this.left[k] -= n;
    return true;
  }

  takeAll(kinds: readonly Kind[]): void {
    for (const k of kinds) this.left[k]--;
  }

  /** `n` random tiles without removing them, or null when too few are left. */
  sample(rng: Rng, n: number, ok?: (k: Kind) => boolean): Kind[] | null {
    const bag: Kind[] = [];
    for (let k = 0; k < NUM_PLAY_KINDS; k++) if (!ok || ok(k)) for (let c = 0; c < this.left[k]; c++) bag.push(k);
    if (bag.length < n) return null;
    for (let i = 0; i < n; i++) {
      const j = i + rng.int(bag.length - i);
      const t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
    return bag.slice(0, n);
  }

  draw(rng: Rng, n: number, ok?: (k: Kind) => boolean): Kind[] | null {
    const out = this.sample(rng, n, ok);
    if (out) this.takeAll(out);
    return out;
  }
}

/** A random chow or pong taken from the pool (`suits` limits suited sets; honour pongs need `honours`). */
export function randomSet(rng: Rng, pool: TilePool, pongChance: number, suits: readonly number[] = [0, 1, 2], honours = true): Kind[] | null {
  for (let tries = 0; tries < 12; tries++) {
    if (rng.next() < pongChance) {
      const honour = honours && rng.next() < 0.3;
      const k = honour ? KIND_WIND + rng.int(7) : suits[rng.int(suits.length)] * 9 + rng.int(9);
      if (pool.take(k, 3)) return [k, k, k];
    } else {
      const start = suits[rng.int(suits.length)] * 9 + rng.int(7);
      if (pool.left[start] > 0 && pool.left[start + 1] > 0 && pool.left[start + 2] > 0) {
        pool.takeAll([start, start + 1, start + 2]);
        return [start, start + 1, start + 2];
      }
    }
  }
  return null;
}

export function randomHonourPong(rng: Rng, pool: TilePool): Kind[] | null {
  for (let tries = 0; tries < 8; tries++) {
    const k = KIND_WIND + rng.int(7);
    if (pool.take(k, 3)) return [k, k, k];
  }
  return null;
}

export interface SeatSetup {
  hand: Kind[];
  melds: PuzzleMeld[];
  discards: Kind[];
}

/**
 * A mid-hand table built from kinds: every listed tile gets its own physical copy and the
 * rest (plus the bonus tiles) form the live wall. `turn` holds 17 tiles and is to discard.
 */
export function buildTable(seats: SeatSetup[], turn: number, dealerSeat: number, prevailingWind: number, rng: Rng): GameState {
  const next = new Array<number>(NUM_PLAY_KINDS).fill(0);
  const id = (k: Kind): TileId => {
    if (next[k] >= 4) throw new Error(`puzzle table: fifth copy of kind ${k}`);
    return k * 4 + next[k]++;
  };
  const players: PlayerState[] = seats.map((seat) => {
    const hand = sortTiles(seat.hand.map(id));
    const melds: Meld[] = seat.melds.map((m) => {
      const tiles = m.kinds.map(id);
      return m.concealed ? { type: m.type, tiles, concealed: true } : { type: m.type, tiles, concealed: false, from: m.from, claimed: tiles[tiles.length - 1] };
    });
    return { hand, melds, flowers: [], discards: seat.discards.map(id), passedWin: false, draws: seat.discards.length + 1 };
  });
  const wall: TileId[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let c = next[k]; c < 4; c++) wall.push(k * 4 + c);
  for (let t = NUM_PLAY_KINDS * 4; t < NUM_TILES; t++) wall.push(t);
  shuffle(wall, rng);
  const turnHand = players[turn].hand;
  return {
    rules: DEFAULT_RULES,
    seed: 'puzzle',
    rngVersion: WALL_RNG_VERSION,
    handNumber: 0,
    dealerRotations: 0,
    dealerSeat,
    dealerStreak: 0,
    prevailingWind,
    scores: [0, 0, 0, 0],
    wall,
    drawIndex: 0,
    backIndex: wall.length,
    players,
    turn,
    phase: 'discard',
    lastDrawn: turnHand[turnHand.length - 1],
    drawSource: 'wall',
    matchOver: false,
    actionLog: [],
    turnCounter: seats.reduce((n, s) => n + s.discards.length, 0),
    anyClaimThisHand: seats.some((s) => s.melds.some((m) => !m.concealed)),
    dealerDiscards: Math.max(1, seats[dealerSeat].discards.length),
    lastTileDrawn: false,
  };
}

/** Shanten after discarding each held kind (index = kind, Infinity when not held). */
export function shantenByDiscard(counts: Counts, setsNeeded: number): number[] {
  const out = new Array<number>(NUM_PLAY_KINDS).fill(Infinity);
  const c = counts.slice();
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (c[k] === 0) continue;
    c[k]--;
    out[k] = shanten(c, setsNeeded);
    c[k]++;
  }
  return out;
}

/** Tile acceptance after discarding `kind` (the same count `discardOptions` reports, for one kind). */
export function acceptanceAfter(counts: Counts, setsNeeded: number, kind: Kind, unseen: Counts): number {
  const c = counts.slice();
  c[kind]--;
  const base = shanten(c, setsNeeded);
  let acceptance = 0;
  for (const a of relevantKinds(c)) {
    if (c[a] >= 4 || unseen[a] <= 0) continue;
    c[a]++;
    if (shanten(c, setsNeeded) < base) acceptance += unseen[a];
    c[a]--;
  }
  return acceptance;
}

/** Kinds that complete a 3n+1 hand (pure shape, a fifth copy excluded): `waits` limited to kinds near held tiles. */
export function shapeWaits(counts: Counts, setsNeeded: number): Kind[] {
  const out: Kind[] = [];
  for (const k of relevantKinds(counts)) {
    if (counts[k] >= 4) continue;
    counts[k]++;
    if (isComplete(counts, setsNeeded)) out.push(k);
    counts[k]--;
  }
  return out;
}

export const tileEn = (k: Kind): string => kindInfo(k).nameEn;
/** Two or more tiles of one kind in English: "4 Characters", "6 Dots", "5 Bamboo", "East Winds". */
export const tilesEn = (k: Kind): string => {
  const t = kindInfo(k);
  return t.isHonor ? `${t.nameEn}s` : `${t.rank} ${SUIT_EN[t.suit]}`;
};
export const tileZh = (k: Kind): string => kindInfo(k).nameZh;
export const SEAT_EN = ['you', 'the player on your right', 'the player opposite', 'the player on your left'];
export const SEAT_ZH = ['你', '下家', '對家', '上家'];
export const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function meldsView(p: PlayerState): PuzzleMeld[] {
  return p.melds.map((m) => ({ type: m.type, kinds: m.tiles.map(kindOf), concealed: m.concealed, ...(m.from !== undefined ? { from: m.from } : {}) }));
}

export function seatViews(s: GameState): PuzzleSeatView[] {
  return [1, 2, 3].map((seat) => ({ seat, melds: meldsView(s.players[seat]), discards: s.players[seat].discards.map(kindOf) }));
}

/** A ready 3n+1 hand: n sets and a pair, minus one tile; null when the pool runs short. */
export function readyHand(rng: Rng, pool: TilePool, sets: number): Kind[] | null {
  const hand: Kind[] = [];
  for (let i = 0; i < sets; i++) {
    const set = randomSet(rng, pool, 0.35);
    if (!set) return null;
    hand.push(...set);
  }
  const pair = pool.sample(rng, 1, (k) => pool.left[k] >= 2);
  if (!pair) return null;
  pool.take(pair[0], 2);
  hand.push(pair[0], pair[0]);
  const drop = hand.splice(rng.int(hand.length), 1)[0];
  pool.left[drop]++;
  return hand;
}
