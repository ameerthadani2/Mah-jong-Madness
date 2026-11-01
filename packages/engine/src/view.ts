/**
 * Per-seat views of the table. The host strips hidden information before
 * sending state to a client so a modified client cannot see other hands or
 * the wall order.
 */
import { type GameState, type PlayerState, tilesRemaining, drawsLeft } from './game';
import { NUM_PLAY_KINDS } from './tiles';
import { type TileId } from './tiles';

export interface PlayerView extends Omit<PlayerState, 'hand'> {
  /** Own tiles, or `undefined` for other seats. */
  hand?: TileId[];
  handCount: number;
}

export interface TableView extends Omit<GameState, 'wall' | 'players' | 'drawIndex' | 'backIndex'> {
  viewerSeat: number;
  players: PlayerView[];
  tilesRemaining: number;
  drawsLeft: number;
}

export function viewFor(s: GameState, seat: number): TableView {
  const { wall: _w, drawIndex: _d, backIndex: _b, players, ...rest } = s;
  void _w;
  void _d;
  void _b;
  const revealAll = s.phase === 'ended';
  return {
    ...rest,
    viewerSeat: seat,
    tilesRemaining: tilesRemaining(s),
    drawsLeft: drawsLeft(s),
    players: players.map((p, i) => {
      const { hand, ...pr } = p;
      return {
        ...pr,
        handCount: hand.length,
        hand: i === seat || revealAll ? hand : undefined,
      };
    }),
  };
}

/**
 * Rebuild a `GameState`-shaped object from a seat view so that engine helpers
 * (legalActions, hintFor, chooseAction) can run on a client that only has
 * partial information. Hidden hands are filled with placeholder tiles so
 * lengths stay consistent; the wall is empty and only its size is known.
 */
export function viewToState(v: TableView): GameState {
  const { viewerSeat, tilesRemaining: remaining, drawsLeft: _dl, players, ...rest } = v;
  void viewerSeat;
  void _dl;
  const PLACEHOLDER = NUM_PLAY_KINDS * 4; // id 136 = a bonus tile id; never matches a play kind
  return {
    ...rest,
    wall: [],
    drawIndex: 0,
    backIndex: remaining,
    players: players.map((p) => {
      const { handCount, hand, ...pr } = p;
      return { ...pr, hand: hand ?? new Array<number>(handCount).fill(PLACEHOLDER) };
    }),
  };
}
