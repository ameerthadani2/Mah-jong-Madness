/**
 * Deterministic state builders for flow tests: exact hands, melds, flowers and
 * wall tiles, so end-of-wall, replacement-tile and flower-win paths can be hit
 * without searching seeds.
 *
 * Hand strings use the engine notation (`'123m 456p EEE CF B f1'`); every tile is
 * given a unique physical id, and a fifth copy of a kind throws.
 */
import {
  applyAction,
  dealWall,
  isBonusTile,
  kindOf,
  kindsFromString,
  legalActions,
  newGame,
  tilesRemaining,
  withRules,
  type Action,
  type ClaimResponse,
  type GameState,
  type Meld,
  type MeldType,
  type RuleSet,
  type ScoreResult,
  type TileId,
} from '../../src/index';

const FIRST_BONUS_KIND = 34;
const FIRST_BONUS_ID = 136;

/** Hands out unique physical tile ids: `kind * 4 + copy` for play tiles, `136 + n` for the eight bonus tiles. */
export class Alloc {
  private used = new Map<number, number>();

  id(kind: number): TileId {
    const copies = this.used.get(kind) ?? 0;
    const limit = kind >= FIRST_BONUS_KIND ? 1 : 4;
    if (copies >= limit) throw new Error(`Alloc: no copy of kind ${kind} left`);
    this.used.set(kind, copies + 1);
    return kind >= FIRST_BONUS_KIND ? FIRST_BONUS_ID + kind - FIRST_BONUS_KIND : kind * 4 + copies;
  }

  ids(hand: string): TileId[] {
    return hand.trim() === '' ? [] : kindsFromString(hand).map((k) => this.id(k));
  }

  /** One tile from a single code such as `'5p'` or `'f8'`. */
  tile(code: string): TileId {
    const ids = this.ids(code);
    if (ids.length !== 1) throw new Error(`Alloc: '${code}' is not a single tile`);
    return ids[0];
  }

  /** Every id not handed out yet, in id order. */
  free(): TileId[] {
    const taken = new Set<TileId>();
    for (const [k, n] of this.used) {
      if (k >= FIRST_BONUS_KIND) taken.add(FIRST_BONUS_ID + k - FIRST_BONUS_KIND);
      else for (let c = 0; c < n; c++) taken.add(k * 4 + c);
    }
    const out: TileId[] = [];
    for (let id = 0; id < 144; id++) if (!taken.has(id)) out.push(id);
    return out;
  }
}

export interface SeatSpec {
  hand: string;
  melds?: Array<{ type: MeldType; tiles: string; concealed?: boolean; from?: number }>;
  /** Bonus tiles already banked, as codes (`'f1 f2'`). */
  flowers?: string;
}

/** Single-tile codes; bonus tiles are `'f1'`..`'f8'`. */
export interface WallSpec {
  /** Next front draws, in order (`wall[drawIndex]`, `wall[drawIndex + 1]`, ...). */
  front?: string[];
  /** Next replacement draws from the back, in order (`wall[backIndex - 1]`, `wall[backIndex - 2]`, ...). */
  back?: string[];
}

/** A table mid-hand with every hand, meld and flower cleared and the 天/地/人胡 bookkeeping spent. */
export function blank(rules: Partial<RuleSet> = {}): GameState {
  const s = newGame('probe', withRules(rules));
  for (const p of s.players) {
    p.hand = [];
    p.melds = [];
    p.flowers = [];
    p.discards = [];
    p.draws = 1;
    p.passedWin = false;
  }
  s.anyClaimThisHand = true;
  s.dealerDiscards = 3;
  s.dealerSeat = 0;
  s.dealerStreak = 0;
  s.result = undefined;
  s.pending = undefined;
  s.lastDiscard = undefined;
  s.lastTileDrawn = false;
  s.actionLog = [];
  return s;
}

function seatSpec(x: string | SeatSpec): SeatSpec {
  return typeof x === 'string' ? { hand: x } : x;
}

/**
 * Seat 0 (the dealer) to discard with `drawsLeft` live tiles before the dead wall.
 * Seat 0 needs a 17-tile shape (less 3 per meld), the others 16.
 */
export function setup(rules: Partial<RuleSet>, seats: Array<string | SeatSpec>, drawsLeft: number, wall: WallSpec = {}): GameState {
  const s = blank(rules);
  const A = new Alloc();
  seats.map(seatSpec).forEach((spec, i) => {
    const p = s.players[i];
    p.hand = A.ids(spec.hand);
    p.melds = (spec.melds ?? []).map(
      (m): Meld => ({ type: m.type, tiles: A.ids(m.tiles), concealed: m.concealed ?? false, from: m.concealed ? undefined : (m.from ?? (i + 3) % 4) }),
    );
    p.flowers = A.ids(spec.flowers ?? '');
  });
  s.turn = 0;
  s.phase = 'discard';
  s.lastDrawn = s.players[0].hand[s.players[0].hand.length - 1];
  s.drawSource = 'wall';
  s.drawIndex = 60;
  s.backIndex = 60 + s.rules.deadWallSize + drawsLeft;
  const front = (wall.front ?? []).map((t) => A.tile(t));
  const back = (wall.back ?? []).map((t) => A.tile(t));
  // Fill the rest with unused play tiles so no stray bonus tile is ever drawn.
  const free = A.free().filter((t) => !isBonusTile(t));
  s.wall = new Array<TileId>(144);
  for (let i = 0; i < 144; i++) s.wall[i] = free[i % free.length];
  front.forEach((t, i) => (s.wall[s.drawIndex + i] = t));
  back.forEach((t, i) => (s.wall[s.backIndex - 1 - i] = t));
  return s;
}

/**
 * A real deal from an exact wall: `hands[seat]` are the 16 dealt tiles (seat 0 is
 * the dealer), `wall.front` starts with the dealer's 17th tile and `wall.back` lists
 * the bonus-tile replacements. Unused bonus tiles go to the middle of the wall.
 */
export function dealt(rules: Partial<RuleSet>, hands: string[], wall: WallSpec = {}): GameState {
  const A = new Alloc();
  const order = new Array<TileId | undefined>(144).fill(undefined);
  const dealtIds = hands.map((h) => A.ids(h));
  for (const ids of dealtIds) if (ids.length !== 16) throw new Error('dealt: every seat needs 16 tiles');
  for (let round = 0; round < 4; round++) {
    for (let seat = 0; seat < 4; seat++) {
      for (let j = 0; j < 4; j++) order[round * 16 + seat * 4 + j] = dealtIds[seat][round * 4 + j];
    }
  }
  (wall.front ?? []).forEach((t, i) => (order[64 + i] = A.tile(t)));
  (wall.back ?? []).forEach((t, i) => (order[143 - i] = A.tile(t)));
  const free = A.free();
  const flowers = free.filter(isBonusTile);
  const plain = free.filter((t) => !isBonusTile(t));
  const open = order.map((t, i) => (t === undefined ? i : -1)).filter((i) => i >= 0);
  const middle = 104;
  const byMiddle = open.slice().sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
  flowers.forEach((t, i) => (order[byMiddle[i]] = t));
  let next = 0;
  for (const i of open) if (order[i] === undefined) order[i] = plain[next++];
  const base = newGame('probe', withRules(rules));
  return dealWall({ ...base, dealerSeat: 0, dealerStreak: 0, turn: 0 }, order as TileId[]);
}

/** Every tile accounted for: hands, melds, flowers, discards and the live wall. */
export function tileTotal(s: GameState): number {
  return (
    s.players.reduce((n, p) => n + p.hand.length + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.flowers.length + p.discards.length, 0) +
    tilesRemaining(s)
  );
}

/** The id of a tile of this code in the seat's hand. */
export function find(s: GameState, seat: number, code: string): TileId {
  const k = kindsFromString(code)[0];
  const t = s.players[seat].hand.find((x) => kindOf(x) === k);
  if (t === undefined) throw new Error(`Seat ${seat} holds no ${code}`);
  return t;
}

export function discard(s: GameState, seat: number, code: string): GameState {
  return applyAction(s, seat, { type: 'discard', tile: find(s, seat, code) });
}

/** Answer every open claim offer: `answers[seat]` or pass. */
export function respond(s: GameState, answers: Record<number, ClaimResponse> = {}): GameState {
  const pending = s.pending;
  if (!pending) throw new Error('respond: no pending claim');
  for (const o of pending.offers) {
    const r = answers[o.seat] ?? { type: 'pass' };
    s = applyAction(s, o.seat, r.type === 'kong' ? { type: 'kong', tile: pending.tile } : r);
  }
  return s;
}

/** Offer summary for assertions: seat → which calls are open. */
export function offers(s: GameState): Record<number, { hu: boolean; pong: boolean; kong: boolean; chi: number }> {
  const out: Record<number, { hu: boolean; pong: boolean; kong: boolean; chi: number }> = {};
  for (const o of s.pending?.offers ?? []) out[o.seat] = { hu: o.hu, pong: o.pong, kong: o.kong, chi: o.chi.length };
  return out;
}

export const keysOf = (score: ScoreResult): string[] => score.items.map((i) => i.key).sort();

/** Legal actions other than discards (胡, kongs). */
export function nonDiscard(s: GameState, seat: number): Action[] {
  return legalActions(s, seat).filter((a) => a.type !== 'discard');
}
