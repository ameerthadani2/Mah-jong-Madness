import { kindOf, type Kind, type TileId } from './tiles';

export type MeldType = 'chow' | 'pong' | 'kong';

export interface Meld {
  type: MeldType;
  /** Physical tiles (3 for chow/pong, 4 for kong). */
  tiles: TileId[];
  /** Concealed kong (暗槓). Pongs and chows are always exposed. */
  concealed: boolean;
  /** Seat the claimed tile came from (undefined for concealed kong). */
  from?: number;
  /** The tile that was claimed / added, for display. */
  claimed?: TileId;
}

/** Kind of the meld: lowest kind of a chow, or the kind of pong/kong. */
export function meldKind(m: Meld): Kind {
  return Math.min(...m.tiles.map(kindOf));
}

export function meldKinds(m: Meld): Kind[] {
  return m.tiles.map(kindOf).sort((a, b) => a - b);
}
