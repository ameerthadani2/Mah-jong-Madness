/**
 * Deterministic Taiwanese 16-tile Mahjong state machine.
 *
 * The whole table is a plain JSON `GameState`. `applyAction` returns a new state
 * (it never mutates the input), so the same action log replayed on the same seed
 * produces an identical state on every peer. That property is what the P2P
 * layer relies on for lock-step sync and post-hand auditing.
 */
import { countsFromKinds, isComplete, TOTAL_SETS, waits } from './hand';
import { type Meld } from './meld';
import { createWallRng, hashString, shuffle, WALL_RNG_VERSION } from './rng';
import { DEFAULT_RULES, type RuleSet } from './rules';
import { computePayments, DEALER_KEYS, scoreWin, type FlowerWin, type Payment, type ScoreResult, type WinContext } from './scoring';
import { fullSet, isBonusTile, kindOf, sortTiles, type Kind, type TileId } from './tiles';
import { canStartChow } from './hand';

export type Phase = 'discard' | 'claim' | 'ended';

export interface PlayerState {
  /** Concealed tiles (16, or 17 while it is this player's turn to discard). */
  hand: TileId[];
  melds: Meld[];
  flowers: TileId[];
  discards: TileId[];
  /** 過水: passed on a winnable discard; cannot win by discard until next draw. */
  passedWin: boolean;
  draws: number;
}

export interface ClaimOffer {
  seat: number;
  hu: boolean;
  pong: boolean;
  kong: boolean;
  /** Pairs of hand tiles that would form a chow with the discard. */
  chi: Array<[TileId, TileId]>;
}

export type ClaimResponse =
  | { type: 'pass' }
  | { type: 'hu' }
  | { type: 'pong' }
  | { type: 'kong' }
  | { type: 'chi'; tiles: [TileId, TileId] };

export interface PendingClaim {
  tile: TileId;
  from: number;
  kind: 'discard' | 'addedKong';
  offers: ClaimOffer[];
  responses: Record<number, ClaimResponse>;
}

export type Action =
  | { type: 'discard'; tile: TileId }
  | { type: 'hu' }
  | { type: 'kong'; tile: TileId }
  | { type: 'pass' }
  | { type: 'pong' }
  | { type: 'chi'; tiles: [TileId, TileId] };

export interface WinRecord {
  seat: number;
  winningTile: TileId;
  selfDrawn: boolean;
  fromSeat?: number;
  score: ScoreResult;
  payments: Payment[];
  /**
   * Final concealed hand including the winning tile (for the result screen). After a
   * flower win (`score.flowerWin`) it is the hand as it stood, with no winning tile
   * added, and `winningTile` is the bonus tile that completed the set.
   */
  hand: TileId[];
  melds: Meld[];
  flowers: TileId[];
}

export interface HandResult {
  type: 'win' | 'draw';
  wins: WinRecord[];
  scoreDelta: number[];
  dealerContinues: boolean;
}

export interface LoggedAction {
  n: number;
  seat: number;
  action: Action;
  /**
   * Who chose the action: the seat's own player, or the table on its behalf (a bot seat, a seat
   * whose player is away, or a clock that ran out). Absent in logs written before it existed.
   * Replays and state hashes ignore it.
   */
  source?: 'player' | 'auto';
}

export interface GameState {
  rules: RuleSet;
  seed: string;
  /** Identifies the seed→wall construction so old audits stay verifiable. */
  rngVersion: string;
  handNumber: number;
  /** Number of times the dealer position has rotated; match ends at rules.handsPerMatch. */
  dealerRotations: number;
  dealerSeat: number;
  dealerStreak: number;
  prevailingWind: number;
  scores: number[];
  wall: TileId[];
  drawIndex: number;
  backIndex: number;
  players: PlayerState[];
  turn: number;
  phase: Phase;
  lastDrawn?: TileId;
  drawSource?: 'wall' | 'kong' | 'flower' | 'claim' | 'deal';
  lastDiscard?: { tile: TileId; seat: number };
  pending?: PendingClaim;
  result?: HandResult;
  matchOver: boolean;
  actionLog: LoggedAction[];
  turnCounter: number;
  /** Bookkeeping for 天胡 / 地胡 / 人胡: true once anyone has called a chi, a pong or a kong of any kind this hand. */
  anyClaimThisHand: boolean;
  dealerDiscards: number;
  /** True when the tile just drawn was the last drawable tile. */
  lastTileDrawn: boolean;
}

export class IllegalAction extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'IllegalAction';
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Start a match and deal its first hand. Like every deal, the result can already be
 * over (`phase === 'ended'` with a win result) when the deal itself completes
 * 八仙過海 or 七搶一; callers must check `phase` before waiting for an action.
 */
export function newGame(seed: string, rules: RuleSet = DEFAULT_RULES, startDealer = 0): GameState {
  const base: GameState = {
    rules,
    seed,
    rngVersion: WALL_RNG_VERSION,
    handNumber: 0,
    dealerRotations: 0,
    dealerSeat: startDealer,
    dealerStreak: 0,
    prevailingWind: 0,
    scores: [0, 0, 0, 0],
    wall: [],
    drawIndex: 0,
    backIndex: 0,
    players: [],
    turn: startDealer,
    phase: 'ended',
    matchOver: false,
    actionLog: [],
    turnCounter: 0,
    anyClaimThisHand: false,
    dealerDiscards: 0,
    lastTileDrawn: false,
  };
  return dealHand(base);
}

function emptyPlayer(): PlayerState {
  return { hand: [], melds: [], flowers: [], discards: [], passedWin: false, draws: 0 };
}

/**
 * Shuffle and deal a new hand on top of the match-level fields of `prev`. The new
 * hand may already be over: see `dealWall`.
 */
export function dealHand(prev: GameState): GameState {
  return dealWall(prev, shuffle(fullSet(), createWallRng(`${prev.seed}:${prev.handNumber}`)));
}

/**
 * Deal a new hand from an explicit wall order on top of the match-level fields of
 * `prev`. `wall` must be a permutation of `fullSet()`: tiles are dealt from the
 * front four at a time starting with the dealer, bonus tiles are replaced from
 * the back, then the dealer draws the 17th tile. `dealHand` calls it with the
 * seeded shuffle; tests use it to build exact deals.
 *
 * The returned hand can already be over (`phase === 'ended'`, `result` set): the
 * 補花 or the dealer's draw may complete 八仙過海 or 七搶一 (`score.flowerWin`).
 */
export function dealWall(prev: GameState, wall: readonly TileId[]): GameState {
  if (wall.length !== 144 || new Set(wall).size !== 144 || wall.some((t) => !Number.isInteger(t) || t < 0 || t >= 144)) {
    throw new Error('dealWall: the wall must be a permutation of the 144 tiles');
  }
  const s: GameState = {
    ...prev,
    wall: wall.slice(),
    drawIndex: 0,
    backIndex: 144,
    players: [emptyPlayer(), emptyPlayer(), emptyPlayer(), emptyPlayer()],
    turn: prev.dealerSeat,
    phase: 'discard',
    lastDrawn: undefined,
    drawSource: 'deal',
    lastDiscard: undefined,
    pending: undefined,
    result: undefined,
    actionLog: [],
    turnCounter: 0,
    anyClaimThisHand: false,
    dealerDiscards: 0,
    lastTileDrawn: false,
  };
  // Deal 4 tiles at a time, 4 rounds, starting from the dealer.
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 4; i++) {
      const seat = (s.dealerSeat + i) % 4;
      for (let j = 0; j < 4; j++) s.players[seat].hand.push(s.wall[s.drawIndex++]);
    }
  }
  // Replace bonus tiles (補花) in seat order.
  for (let i = 0; i < 4; i++) replaceFlowers(s, (s.dealerSeat + i) % 4);
  for (const p of s.players) p.hand = sortTiles(p.hand);
  // 八仙過海 / 七搶一 straight from the deal end the hand before the dealer draws.
  if (settleDealtFlowers(s)) return s;
  // Dealer draws the 17th tile.
  drawFromWall(s, s.dealerSeat, 'wall');
  return s;
}

/**
 * After the deal's 補花: one seat with all eight bonus tiles wins 八仙過海; a seat
 * with seven takes the eighth from whoever holds it for 七搶一. Returns true when
 * the hand ended.
 */
function settleDealtFlowers(s: GameState): boolean {
  const eight = s.players.findIndex((p) => p.flowers.length === 8);
  if (eight >= 0) {
    const p = s.players[eight];
    finishWin(s, [{ seat: eight, tile: p.flowers[p.flowers.length - 1], selfDrawn: true, flowerWin: 'eight' }]);
    return true;
  }
  const seven = s.players.findIndex((p) => p.flowers.length === 7);
  if (seven < 0) return false;
  for (let i = 1; i < 4; i++) {
    const holder = (seven + i) % 4;
    if (s.players[holder].flowers.length === 1) {
      robEighthFlower(s, holder, seven, s.players[holder].flowers[0]);
      return true;
    }
  }
  // The eighth bonus tile is still in the wall.
  return false;
}

/**
 * Called whenever `seat` banks bonus tile `tile` during play: all eight in one
 * seat is 八仙過海 (paid as a self-draw); otherwise a seat already holding seven
 * takes this one for 七搶一 (paid by `seat` alone). Returns true when the hand ended.
 */
function settleBankedFlower(s: GameState, seat: number, tile: TileId): boolean {
  const p = s.players[seat];
  if (p.flowers.length === 8) {
    s.turn = seat;
    s.lastDrawn = undefined;
    finishWin(s, [{ seat, tile, selfDrawn: true, flowerWin: 'eight' }]);
    return true;
  }
  for (let i = 1; i < 4; i++) {
    const q = (seat + i) % 4;
    if (s.players[q].flowers.length === 7) {
      s.turn = seat;
      s.lastDrawn = undefined;
      robEighthFlower(s, seat, q, tile);
      return true;
    }
  }
  return false;
}

/** 七搶一: `winner` (holding seven) takes `tile` from `holder`, who alone pays. */
function robEighthFlower(s: GameState, holder: number, winner: number, tile: TileId): void {
  const from = s.players[holder].flowers;
  from.splice(from.indexOf(tile), 1);
  s.players[winner].flowers.push(tile);
  finishWin(s, [{ seat: winner, tile, selfDrawn: false, fromSeat: holder, flowerWin: 'sevenRob' }]);
}

// ---------------------------------------------------------------------------
// Helpers (operate on a fresh clone; never exported with mutation semantics)
// ---------------------------------------------------------------------------

function clone(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s)) as GameState;
}

export function tilesRemaining(s: GameState): number {
  return s.backIndex - s.drawIndex;
}

export function drawsLeft(s: GameState): number {
  return Math.max(0, tilesRemaining(s) - s.rules.deadWallSize);
}

function canDraw(s: GameState): boolean {
  return tilesRemaining(s) > s.rules.deadWallSize;
}

/** Move bonus tiles out of the hand and pull replacements from the back of the wall. */
function replaceFlowers(s: GameState, seat: number): void {
  const p = s.players[seat];
  let i = 0;
  while (i < p.hand.length) {
    const t = p.hand[i];
    if (isBonusTile(t)) {
      p.hand.splice(i, 1);
      p.flowers.push(t);
      if (!canDraw(s)) break;
      p.hand.push(s.wall[--s.backIndex]);
    } else i++;
  }
}

/**
 * Draw a tile for `seat`. Bonus tiles are banked and replaced from the back.
 * Returns `'ended'` when the hand is over instead: the wall is exhausted (a draw)
 * or a banked bonus tile completed 八仙過海 / 七搶一. Callers must stop then.
 */
function drawFromWall(s: GameState, seat: number, source: 'wall' | 'kong'): 'drawn' | 'ended' {
  if (!canDraw(s)) {
    endInDraw(s);
    return 'ended';
  }
  const p = s.players[seat];
  let tile = source === 'wall' ? s.wall[s.drawIndex++] : s.wall[--s.backIndex];
  let src: GameState['drawSource'] = source;
  while (isBonusTile(tile)) {
    p.flowers.push(tile);
    if (settleBankedFlower(s, seat, tile)) return 'ended';
    if (!canDraw(s)) {
      endInDraw(s);
      return 'ended';
    }
    tile = s.wall[--s.backIndex];
    // A flower drawn as a kong replacement keeps the kong source, so the win is 槓上開花.
    if (source !== 'kong') src = 'flower';
  }
  p.hand.push(tile);
  p.draws++;
  p.passedWin = false;
  s.lastDrawn = tile;
  s.drawSource = src;
  s.lastTileDrawn = !canDraw(s);
  s.turn = seat;
  s.phase = 'discard';
  return 'drawn';
}

function endInDraw(s: GameState): void {
  s.phase = 'ended';
  s.pending = undefined;
  const dealerContinues = s.rules.drawKeepsDealer;
  s.result = { type: 'draw', wins: [], scoreDelta: [0, 0, 0, 0], dealerContinues };
}

function concealedKindsWithout(p: PlayerState, tile: TileId): Kind[] {
  const idx = p.hand.indexOf(tile);
  const rest = p.hand.slice();
  if (idx >= 0) rest.splice(idx, 1);
  return rest.map(kindOf);
}

/** Does `seat` complete a hand with `tile` added to their concealed tiles? */
export function canWinWith(s: GameState, seat: number, tile: TileId, concealedExcludes?: TileId): boolean {
  const p = s.players[seat];
  const hand = concealedExcludes === undefined ? p.hand.slice() : p.hand.filter((t) => t !== concealedExcludes);
  const counts = countsFromKinds([...hand.map(kindOf), kindOf(tile)]);
  return isComplete(counts, TOTAL_SETS - p.melds.length);
}

export function isSelfDrawWin(s: GameState, seat: number): boolean {
  const p = s.players[seat];
  if (p.hand.length !== 3 * (TOTAL_SETS - p.melds.length) + 2) return false;
  return isComplete(countsFromKinds(p.hand.map(kindOf)), TOTAL_SETS - p.melds.length);
}

function chiOptions(p: PlayerState, tile: TileId): Array<[TileId, TileId]> {
  const k = kindOf(tile);
  if (k >= 27) return [];
  const out: Array<[TileId, TileId]> = [];
  const byKind = (kk: Kind): TileId | undefined => p.hand.find((t) => kindOf(t) === kk);
  const suitBase = Math.floor(k / 9) * 9;
  const r = k - suitBase; // 0..8
  const tryShape = (a: number, b: number) => {
    if (a < 0 || b > 8) return;
    const ta = byKind(suitBase + a);
    const tb = byKind(suitBase + b);
    if (ta !== undefined && tb !== undefined) out.push([ta, tb]);
  };
  tryShape(r - 2, r - 1);
  tryShape(r - 1, r + 1);
  tryShape(r + 1, r + 2);
  // Guard shapes that cross the a<r<b pattern incorrectly
  return out.filter(([a, b]) => {
    const ks = [kindOf(a), kindOf(b), k].sort((x, y) => x - y);
    return canStartChow(ks[0]) && ks[1] === ks[0] + 1 && ks[2] === ks[0] + 2;
  });
}

function buildOffers(s: GameState, from: number, tile: TileId, kind: 'discard' | 'addedKong'): ClaimOffer[] {
  const offers: ClaimOffer[] = [];
  for (let i = 1; i < 4; i++) {
    const seat = (from + i) % 4;
    const p = s.players[seat];
    const sameKind = p.hand.filter((t) => kindOf(t) === kindOf(tile)).length;
    const hu = canWinWith(s, seat, tile) && !(s.rules.passRule && p.passedWin);
    if (kind === 'addedKong') {
      if (hu) offers.push({ seat, hu, pong: false, kong: false, chi: [] });
      continue;
    }
    // On the 河底 discard (no tile left to draw) only 胡 may be called.
    const riverBottom = !canDraw(s);
    const pong = sameKind >= 2 && !riverBottom;
    const kong = sameKind >= 3 && !riverBottom;
    const chi = s.rules.allowChi && i === 1 && !riverBottom ? chiOptions(p, tile) : [];
    if (hu || pong || kong || chi.length > 0) offers.push({ seat, hu, pong, kong, chi });
  }
  return offers;
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

export function legalActions(s: GameState, seat: number): Action[] {
  if (s.phase === 'ended') return [];
  const p = s.players[seat];
  if (s.phase === 'discard') {
    if (s.turn !== seat) return [];
    const actions: Action[] = [];
    // A self-draw win needs a drawn tile; after pong/chi the player must discard (they could have called 胡 on the claim).
    if (s.lastDrawn !== undefined && isSelfDrawWin(s, seat)) actions.push({ type: 'hu' });
    // Kongs need a replacement tile, and a tile drawn this turn (from the wall, the deal or a kong
    // replacement): a turn that began with a chi or pong ends with a discard, as at the table.
    if (s.lastDrawn !== undefined && canDraw(s)) {
      const counts = countsFromKinds(p.hand.map(kindOf));
      const seen = new Set<Kind>();
      for (const t of p.hand) {
        const k = kindOf(t);
        if (seen.has(k)) continue;
        seen.add(k);
        if (counts[k] === 4) actions.push({ type: 'kong', tile: t });
        else if (p.melds.some((m) => m.type === 'pong' && kindOf(m.tiles[0]) === k)) actions.push({ type: 'kong', tile: t });
      }
    }
    const seenDiscard = new Set<Kind>();
    for (const t of p.hand) {
      // Offer one discard per kind to keep the list compact; any copy is equivalent.
      const k = kindOf(t);
      if (seenDiscard.has(k)) continue;
      seenDiscard.add(k);
      actions.push({ type: 'discard', tile: t });
    }
    return actions;
  }
  // claim phase
  const pending = s.pending!;
  const offer = pending.offers.find((o) => o.seat === seat);
  if (!offer || pending.responses[seat]) return [];
  const actions: Action[] = [{ type: 'pass' }];
  if (offer.hu) actions.push({ type: 'hu' });
  if (offer.pong) actions.push({ type: 'pong' });
  if (offer.kong) actions.push({ type: 'kong', tile: pending.tile });
  for (const c of offer.chi) actions.push({ type: 'chi', tiles: c });
  return actions;
}

export function isLegal(s: GameState, seat: number, action: Action): boolean {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) return false;
  const canon = canonicalAction(action);
  if (!canon) return false;
  return legalActions(s, seat).some((a) => sameAction(a, canon, s, seat));
}

/** Do two actions mean the same move for `seat` in state `s` (any physical copy of a discard kind counts)? */
export function sameAction(a: Action, b: Action, s: GameState, seat: number): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'discard': {
      // Any physical copy of the same kind held in hand is acceptable.
      const bt = (b as { tile: TileId }).tile;
      return typeof bt === 'number' && s.players[seat].hand.includes(bt) && kindOf(bt) === kindOf(a.tile);
    }
    case 'kong': {
      const bt = (b as { tile: TileId }).tile;
      if (typeof bt !== 'number' || !Number.isInteger(bt)) return false;
      // In the claim phase the kong tile is the pending discard; otherwise it must be a copy held in hand.
      if (s.phase === 'claim') return s.pending !== undefined && bt === s.pending.tile;
      return s.players[seat].hand.includes(bt) && kindOf(bt) === kindOf(a.tile);
    }
    case 'chi': {
      const bt = (b as { tiles: [TileId, TileId] }).tiles;
      return Array.isArray(bt) && bt.length === 2 && a.tiles[0] === bt[0] && a.tiles[1] === bt[1];
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Strip unknown fields so only the canonical action shape is applied, logged and broadcast. */
export function canonicalAction(input: unknown): Action | null {
  if (!input || typeof input !== 'object') return null;
  const a = input as { type?: unknown; tile?: unknown; tiles?: unknown };
  switch (a.type) {
    case 'hu':
    case 'pass':
    case 'pong':
      return { type: a.type };
    case 'discard':
    case 'kong':
      return typeof a.tile === 'number' && Number.isInteger(a.tile) ? { type: a.type, tile: a.tile } : null;
    case 'chi':
      return Array.isArray(a.tiles) && a.tiles.length === 2 && a.tiles.every((t) => typeof t === 'number' && Number.isInteger(t)) ? { type: 'chi', tiles: [a.tiles[0] as TileId, a.tiles[1] as TileId] } : null;
    default:
      return null;
  }
}

export function applyAction(prev: GameState, seat: number, rawAction: Action, source?: LoggedAction['source']): GameState {
  const action = canonicalAction(rawAction);
  if (!action) throw new IllegalAction('Malformed action');
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw new IllegalAction('Bad seat');
  if (!isLegal(prev, seat, action)) {
    throw new IllegalAction(`Seat ${seat} cannot ${action.type} in phase ${prev.phase}`);
  }
  const s = clone(prev);
  s.actionLog.push(source ? { n: s.turnCounter++, seat, action, source } : { n: s.turnCounter++, seat, action });
  if (s.phase === 'discard') applyTurnAction(s, seat, action);
  else applyClaimAction(s, seat, action as ClaimResponse);
  return s;
}

function applyTurnAction(s: GameState, seat: number, action: Action): void {
  const p = s.players[seat];
  switch (action.type) {
    case 'hu': {
      const tile = s.lastDrawn!;
      finishWin(s, [{ seat, tile, selfDrawn: true }]);
      return;
    }
    case 'discard': {
      const idx = p.hand.findIndex((t) => t === action.tile);
      const tile = p.hand[idx];
      p.hand.splice(idx, 1);
      p.hand = sortTiles(p.hand);
      p.discards.push(tile);
      s.lastDiscard = { tile, seat };
      s.lastDrawn = undefined;
      if (seat === s.dealerSeat) s.dealerDiscards++;
      const offers = buildOffers(s, seat, tile, 'discard');
      if (offers.length === 0) {
        advanceToNextDraw(s, seat);
      } else {
        s.phase = 'claim';
        s.pending = { tile, from: seat, kind: 'discard', offers, responses: {} };
      }
      return;
    }
    case 'kong': {
      const k = kindOf(action.tile);
      const inHand = p.hand.filter((t) => kindOf(t) === k);
      if (inHand.length === 4) {
        // 暗槓. Like every call it ends the first uninterrupted round, so 地胡 and 人胡 are off.
        p.hand = p.hand.filter((t) => kindOf(t) !== k);
        p.melds.push({ type: 'kong', tiles: inHand, concealed: true });
        s.anyClaimThisHand = true;
        drawFromWall(s, seat, 'kong');
        return;
      }
      // 加槓: offer the robbing window first.
      const offers = buildOffers(s, seat, action.tile, 'addedKong');
      if (offers.length === 0) {
        completeAddedKong(s, seat, action.tile);
      } else {
        s.phase = 'claim';
        s.pending = { tile: action.tile, from: seat, kind: 'addedKong', offers, responses: {} };
      }
      return;
    }
    default:
      throw new IllegalAction(`Unexpected turn action ${action.type}`);
  }
}

function completeAddedKong(s: GameState, seat: number, tile: TileId): void {
  const p = s.players[seat];
  const k = kindOf(tile);
  const meld = p.melds.find((m) => m.type === 'pong' && kindOf(m.tiles[0]) === k)!;
  p.hand = p.hand.filter((t) => t !== tile);
  meld.type = 'kong';
  meld.tiles.push(tile);
  meld.claimed = tile;
  s.anyClaimThisHand = true;
  drawFromWall(s, seat, 'kong');
}

function advanceToNextDraw(s: GameState, from: number): void {
  s.pending = undefined;
  drawFromWall(s, (from + 1) % 4, 'wall');
}

function applyClaimAction(s: GameState, seat: number, response: ClaimResponse): void {
  const pending = s.pending!;
  pending.responses[seat] = response;
  if (response.type === 'pass') {
    const offer = pending.offers.find((o) => o.seat === seat)!;
    if (offer.hu) s.players[seat].passedWin = true;
  }
  if (pending.offers.some((o) => pending.responses[o.seat] === undefined)) return;
  resolveClaims(s);
}

function resolveClaims(s: GameState): void {
  const pending = s.pending!;
  const from = pending.from;
  const ordered = pending.offers
    .map((o) => ({ o, resp: pending.responses[o.seat] }))
    .sort((a, b) => ((a.o.seat - from + 4) % 4) - ((b.o.seat - from + 4) % 4));

  const huSeats = ordered.filter((x) => x.resp.type === 'hu').map((x) => x.o.seat);
  if (huSeats.length > 0) {
    const winners = s.rules.multipleWinners ? huSeats : [huSeats[0]];
    // Winning on a discard is not a "claim" for 人胡 purposes; earlier chi/pong/kong already set the flag.
    finishWin(
      s,
      winners.map((seat) => ({ seat, tile: pending.tile, selfDrawn: false, fromSeat: from, robbingKong: pending.kind === 'addedKong' })),
    );
    return;
  }
  if (pending.kind === 'addedKong') {
    completeAddedKong(s, from, pending.tile);
    return;
  }
  const pongOrKong = ordered.find((x) => x.resp.type === 'pong' || x.resp.type === 'kong');
  if (pongOrKong) {
    const seat = pongOrKong.o.seat;
    const p = s.players[seat];
    const k = kindOf(pending.tile);
    s.anyClaimThisHand = true;
    s.players[from].discards.pop();
    if (pongOrKong.resp.type === 'pong') {
      const use = p.hand.filter((t) => kindOf(t) === k).slice(0, 2);
      p.hand = p.hand.filter((t) => !use.includes(t));
      p.melds.push({ type: 'pong', tiles: [...use, pending.tile], concealed: false, from, claimed: pending.tile });
      p.passedWin = false;
      s.pending = undefined;
      s.lastDrawn = undefined;
      s.drawSource = 'claim';
      s.lastTileDrawn = false;
      s.turn = seat;
      s.phase = 'discard';
    } else {
      const use = p.hand.filter((t) => kindOf(t) === k).slice(0, 3);
      p.hand = p.hand.filter((t) => !use.includes(t));
      p.melds.push({ type: 'kong', tiles: [...use, pending.tile], concealed: false, from, claimed: pending.tile });
      s.pending = undefined;
      drawFromWall(s, seat, 'kong');
    }
    return;
  }
  const chi = ordered.find((x) => x.resp.type === 'chi');
  if (chi) {
    const seat = chi.o.seat;
    const p = s.players[seat];
    const tiles = (chi.resp as { tiles: [TileId, TileId] }).tiles;
    s.anyClaimThisHand = true;
    s.players[from].discards.pop();
    p.hand = p.hand.filter((t) => !tiles.includes(t));
    p.melds.push({ type: 'chow', tiles: sortTiles([...tiles, pending.tile]), concealed: false, from, claimed: pending.tile });
    p.passedWin = false;
    s.pending = undefined;
    s.lastDrawn = undefined;
    s.drawSource = 'claim';
    s.lastTileDrawn = false;
    s.turn = seat;
    s.phase = 'discard';
    return;
  }
  // Everyone passed.
  advanceToNextDraw(s, from);
}

/** One winner of a hand, as passed to `buildWinContext` / scoring. */
export interface WinSpec {
  seat: number;
  /** The winning tile; for a flower win, the bonus tile that completed it. */
  tile: TileId;
  selfDrawn: boolean;
  /** The seat that pays alone: the discarder, the robbed seat, or the 七搶一 victim. */
  fromSeat?: number;
  robbingKong?: boolean;
  /** 八仙過海 or 七搶一: won on bonus tiles alone, with no hand shape. */
  flowerWin?: FlowerWin;
}

export function buildWinContext(s: GameState, spec: WinSpec): WinContext {
  const p = s.players[spec.seat];
  if (spec.flowerWin) {
    return {
      rules: s.rules,
      seat: spec.seat,
      dealerSeat: s.dealerSeat,
      dealerStreak: s.dealerStreak,
      prevailingWind: s.prevailingWind,
      concealed: p.hand.map(kindOf),
      melds: p.melds,
      flowers: p.flowers.map(kindOf),
      winningTile: kindOf(spec.tile),
      selfDrawn: spec.selfDrawn,
      fromSeat: spec.fromSeat,
      flowerWin: spec.flowerWin,
    };
  }
  const concealed = spec.selfDrawn ? concealedKindsWithout(p, spec.tile) : p.hand.map(kindOf);
  const isDealer = spec.seat === s.dealerSeat;
  const noClaims = !s.anyClaimThisHand;
  const heavenlyHand = spec.selfDrawn && isDealer && p.draws === 1 && s.dealerDiscards === 0 && noClaims && s.drawSource !== 'kong';
  const earthlyHand = spec.selfDrawn && !isDealer && p.draws === 1 && noClaims && s.drawSource !== 'kong';
  const humanlyHand = !spec.selfDrawn && !isDealer && s.dealerDiscards === 1 && spec.fromSeat === s.dealerSeat && noClaims && p.draws === 0;
  return {
    rules: s.rules,
    seat: spec.seat,
    dealerSeat: s.dealerSeat,
    dealerStreak: s.dealerStreak,
    prevailingWind: s.prevailingWind,
    concealed,
    melds: p.melds,
    flowers: p.flowers.map(kindOf),
    winningTile: kindOf(spec.tile),
    selfDrawn: spec.selfDrawn,
    fromSeat: spec.fromSeat,
    afterKong: spec.selfDrawn && s.drawSource === 'kong',
    afterFlower: spec.selfDrawn && s.drawSource === 'flower',
    robbingKong: spec.robbingKong,
    lastTile: s.lastTileDrawn && (spec.selfDrawn || !canDraw(s)),
    heavenlyHand,
    earthlyHand,
    humanlyHand,
  };
}

function finishWin(s: GameState, specs: WinSpec[]): void {
  const wins: WinRecord[] = [];
  const delta = [0, 0, 0, 0];
  for (const spec of specs) {
    const ctx = buildWinContext(s, spec);
    const score = scoreWin(ctx);
    const taiWithoutDealer = score.items.filter((i) => !DEALER_KEYS.has(i.key)).reduce((a, b) => a + b.tai, 0);
    const payments = computePayments(s.rules, spec.seat, s.dealerSeat, s.dealerStreak, taiWithoutDealer, spec.selfDrawn, spec.fromSeat);
    for (const pay of payments) {
      delta[pay.from] -= pay.points;
      delta[pay.to] += pay.points;
    }
    const p = s.players[spec.seat];
    // A flower win's tile is a bonus tile already banked in `flowers`, never part of the hand.
    const finalHand = spec.flowerWin || spec.selfDrawn ? p.hand.slice() : [...p.hand, spec.tile];
    wins.push({
      seat: spec.seat,
      winningTile: spec.tile,
      selfDrawn: spec.selfDrawn,
      fromSeat: spec.fromSeat,
      score,
      payments,
      hand: sortTiles(finalHand),
      melds: JSON.parse(JSON.stringify(p.melds)) as Meld[],
      flowers: p.flowers.slice(),
    });
  }
  for (let i = 0; i < 4; i++) s.scores[i] += delta[i];
  s.phase = 'ended';
  s.pending = undefined;
  s.result = { type: 'win', wins, scoreDelta: delta, dealerContinues: specs.some((w) => w.seat === s.dealerSeat) };
}

/** Match-level fields that survive between hands. */
export interface MatchSnapshot {
  handNumber: number;
  dealerRotations: number;
  dealerSeat: number;
  dealerStreak: number;
  prevailingWind: number;
  scores: number[];
  matchOver: boolean;
}

export function matchSnapshot(s: GameState): MatchSnapshot {
  return {
    handNumber: s.handNumber,
    dealerRotations: s.dealerRotations,
    dealerSeat: s.dealerSeat,
    dealerStreak: s.dealerStreak,
    prevailingWind: s.prevailingWind,
    scores: s.scores.slice(),
    matchOver: s.matchOver,
  };
}

/** Compute the match snapshot for the hand after `prev` (dealer rotation, wind, match end). */
export function advanceMatch(prev: GameState): MatchSnapshot {
  if (prev.phase !== 'ended' || !prev.result) throw new IllegalAction('Hand is not over');
  if (prev.matchOver) throw new IllegalAction('Match is over');
  const snap = matchSnapshot(prev);
  snap.handNumber++;
  if (prev.result.dealerContinues) {
    snap.dealerStreak++;
  } else {
    snap.dealerStreak = 0;
    snap.dealerSeat = (snap.dealerSeat + 1) % 4;
    snap.dealerRotations++;
    if (snap.dealerRotations % 4 === 0) snap.prevailingWind = (snap.prevailingWind + 1) % 4;
    if (snap.dealerRotations >= prev.rules.handsPerMatch) snap.matchOver = true;
  }
  return snap;
}

/**
 * Deal a hand from a match snapshot with an explicit seed (used by the P2P host and by audits).
 * The dealt hand may already be over (`phase === 'ended'` with a win result) when
 * the deal completes 八仙過海 or 七搶一; a host must then settle the hand at once
 * instead of arming turn clocks.
 */
export function dealFromSnapshot(snap: MatchSnapshot, seed: string, rules: RuleSet): GameState {
  const base: GameState = {
    rules,
    seed,
    rngVersion: WALL_RNG_VERSION,
    ...snap,
    wall: [],
    drawIndex: 0,
    backIndex: 0,
    players: [],
    turn: snap.dealerSeat,
    phase: 'ended',
    actionLog: [],
    turnCounter: 0,
    anyClaimThisHand: false,
    dealerDiscards: 0,
    lastTileDrawn: false,
  };
  if (snap.matchOver) return base;
  return dealHand(base);
}

/**
 * Start the next hand after `phase === 'ended'`. Rotates dealer / wind as needed.
 * The new hand may already be over after its deal (see `dealFromSnapshot`).
 * Pass `seed` to use a fresh commit–reveal seed for the new hand.
 */
export function nextHand(prev: GameState, seed?: string): GameState {
  const snap = advanceMatch(prev);
  return dealFromSnapshot(snap, seed ?? prev.seed, prev.rules);
}

/** Replay one hand's action log from its snapshot and seed. */
export function replayHand(snap: MatchSnapshot, seed: string, rules: RuleSet, log: LoggedAction[]): GameState {
  let s = dealFromSnapshot(snap, seed, rules);
  for (const entry of log) s = applyAction(s, entry.seat, entry.action);
  return s;
}

/** Convenience: current waits of a seat's concealed hand (16 tiles) as kinds. */
export function waitsFor(s: GameState, seat: number): Kind[] {
  const p = s.players[seat];
  const setsNeeded = TOTAL_SETS - p.melds.length;
  const hand = p.hand.map(kindOf);
  if (hand.length === 3 * setsNeeded + 1) return waits(countsFromKinds(hand), setsNeeded);
  return [];
}

// ---------------------------------------------------------------------------
// Hashing (for lock-step verification between peers)
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function hashState(s: GameState): string {
  const { actionLog: _log, ...rest } = s;
  void _log;
  return hashString(stableStringify(rest)).toString(16).padStart(8, '0');
}

/** Replay an action log from a seed and rule set; used for auditing a finished hand. */
export function replay(seed: string, rules: RuleSet, startDealer: number, handsLog: LoggedAction[][]): GameState {
  let s = newGame(seed, rules, startDealer);
  for (let h = 0; h < handsLog.length; h++) {
    if (h > 0) s = nextHand(s);
    for (const entry of handsLog[h]) s = applyAction(s, entry.seat, entry.action);
  }
  return s;
}
