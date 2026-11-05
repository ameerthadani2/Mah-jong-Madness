/**
 * Per-seat views of the table. The host strips hidden information before
 * sending state to a client so a modified client cannot see other hands, the
 * wall order, another seat's freshly drawn tile, another seat's claim options
 * or answers (including whether it has any: `pending.awaiting` lists every
 * other non-discarding seat until the window closes), or the tiles inside
 * another seat's concealed kong.
 */
import { type ClaimOffer, type ClaimResponse, type GameState, type PendingClaim, type PlayerState, tilesRemaining, drawsLeft } from './game';
import { type Meld } from './meld';
import { NUM_PLAY_KINDS, type TileId } from './tiles';

/**
 * Stand-in id for a tile the viewer may not see. Id 136 is a bonus-tile id, so it never
 * matches a play kind and cannot complete a set in the client-side engine helpers.
 */
export const PLACEHOLDER_TILE: TileId = NUM_PLAY_KINDS * 4;

export interface PlayerView extends Omit<PlayerState, 'hand'> {
  /** Own tiles, or `undefined` for other seats. */
  hand?: TileId[];
  handCount: number;
}

/** The claim window as one seat sees it: the discard is public, the other seats' options and answers are not. */
export interface PendingView extends Omit<PendingClaim, 'offers' | 'responses'> {
  /** The viewer's own offer only (empty when the viewer cannot claim). */
  offers: ClaimOffer[];
  /** The viewer's own answer only. */
  responses: Record<number, ClaimResponse>;
  /**
   * Seats the table may still be waiting on, so it can show "waiting on seat N". Independent of who
   * holds a claim option: every seat except the discarder is listed while the window is open, apart
   * from the viewer itself once it has answered (or when it has nothing to answer).
   */
  awaiting: number[];
}

export interface TableView extends Omit<GameState, 'wall' | 'players' | 'drawIndex' | 'backIndex' | 'seed' | 'pending'> {
  viewerSeat: number;
  players: PlayerView[];
  pending?: PendingView;
  tilesRemaining: number;
  drawsLeft: number;
}

/** Another seat's concealed kong: four face-down placeholders until the hand ends. */
function hideMeld(m: Meld): Meld {
  if (!m.concealed) return m;
  return { ...m, tiles: m.tiles.map(() => PLACEHOLDER_TILE), claimed: undefined };
}

function pendingFor(p: PendingClaim, seat: number): PendingView {
  const { offers, responses, ...rest } = p;
  const mine = responses[seat];
  const own = offers.filter((o) => o.seat === seat);
  // Who holds an option, and who has answered, would tell the viewer which seats can pong, kong or
  // win on this tile. So every other non-discarding seat is listed until the window closes; only the
  // viewer's own entry follows what the viewer already knows (it drops out once it owes nothing).
  const viewerOwes = own.length > 0 && mine === undefined;
  return {
    ...rest,
    offers: own,
    responses: mine === undefined ? {} : { [seat]: mine },
    awaiting: [0, 1, 2, 3].filter((s) => s !== p.from && (s !== seat || viewerOwes)),
  };
}

export function viewFor(s: GameState, seat: number): TableView {
  // The seed determines the whole wall: it must never reach a client before the hand's audit.
  const { wall: _w, drawIndex: _d, backIndex: _b, seed: _seed, actionLog: _log, players, pending, lastDrawn, ...rest } = s;
  void _w;
  void _d;
  void _b;
  void _seed;
  void _log;
  const revealAll = s.phase === 'ended';
  return {
    ...rest,
    // Only the seat that drew it may know the drawn tile (until the hand ends).
    lastDrawn: revealAll || seat === s.turn ? lastDrawn : undefined,
    pending: pending ? pendingFor(pending, seat) : undefined,
    // The log names every concealed-kong tile; the audit publishes it once the hand is over.
    actionLog: [],
    viewerSeat: seat,
    tilesRemaining: tilesRemaining(s),
    drawsLeft: drawsLeft(s),
    players: players.map((p, i) => {
      const { hand, ...pr } = p;
      const own = i === seat || revealAll;
      return {
        ...pr,
        // 過水 would tell the others that this seat could have won on a discard.
        passedWin: own ? pr.passedWin : false,
        melds: own ? pr.melds : pr.melds.map(hideMeld),
        handCount: hand.length,
        hand: own ? hand : undefined,
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
  const { viewerSeat, tilesRemaining: remaining, drawsLeft: _dl, players, pending, ...rest } = v;
  void viewerSeat;
  void _dl;
  let claim: PendingClaim | undefined;
  if (pending) {
    const { awaiting: _a, ...own } = pending;
    void _a;
    claim = own;
  }
  return {
    ...rest,
    pending: claim,
    seed: '',
    rngVersion: rest.rngVersion,
    wall: [],
    drawIndex: 0,
    backIndex: remaining,
    players: players.map((p) => {
      const { handCount, hand, ...pr } = p;
      return { ...pr, hand: hand ?? new Array<number>(handCount).fill(PLACEHOLDER_TILE) };
    }),
  };
}
