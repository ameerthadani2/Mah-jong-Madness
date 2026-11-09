/**
 * Heuristic bot. Good enough to be a sparring partner and to auto-play for a
 * disconnected or timed-out player. The same evaluation drives the coach.
 *
 * Bots only use what a player could see at the table: their own hand and
 * melds, every discard (in order), other seats' exposed melds, the wall count,
 * the dealer and the winds. Another seat's concealed kong stays face down, so
 * its tiles count as unseen. bots.test.ts checks that every skill decides the
 * same from its own seat view (`viewFor`) as from the full table.
 *
 * Defence (`readOpponents`, `waitChance`, `dealInRisk`): each opponent gets an
 * estimated chance of being ready from its exposed sets and discard row, and each
 * tile a chance of being one of its winning tiles from the visible copies, its own
 * discards, tiles it let pass, 筋 and a flush read. Club and Pro lean away from
 * that expected cost; Pro also folds from two or more away from ready against a
 * seat that is probably ready, trading the cost against the win chance it gives
 * up (wall left, own hand value, dealer). Value: Pro keeps value-honour pairs,
 * pongs them, and chases a flush once it is in reach.
 */
import { countsFromKinds, discardOptions, shanten, TOTAL_SETS, type Counts } from './hand';
import { type Action, type GameState, type PlayerState, drawsLeft, legalActions } from './game';
import { createRng } from './rng';
import { prevailingWindKind, seatWindKind } from './scoring';
import { isHonorKind, KIND_DRAGON, KIND_WIND, kindOf, NUM_PLAY_KINDS, rankOfKind, type Kind, type TileId } from './tiles';

/** Kinds not visible to `seat`: 4 copies minus own hand, own melds, others' exposed melds, discards and the pending tile. */
export function unseenCounts(s: GameState, seat: number): Counts {
  const unseen = new Array<number>(NUM_PLAY_KINDS).fill(4);
  const see = (t: TileId) => {
    const k = kindOf(t);
    if (k < NUM_PLAY_KINDS) unseen[k]--;
  };
  for (let i = 0; i < 4; i++) {
    const p = s.players[i];
    if (i === seat) p.hand.forEach(see);
    // Another seat's concealed kong is face down: the player knows a kong is there, not what it is.
    for (const m of p.melds) if (i === seat || !m.concealed) m.tiles.forEach(see);
    p.discards.forEach(see);
  }
  // A discarded tile is already in its discarder's pool. Only an added-kong tile is newly revealed
  // (it is still in the kong-er's hand, which other seats cannot see).
  if (s.pending && s.pending.kind === 'addedKong' && seat !== s.pending.from) see(s.pending.tile);
  return unseen;
}

export interface DiscardAdvice {
  tile: TileId;
  kind: Kind;
  shanten: number;
  acceptance: number;
  accepts: Kind[];
  /** Estimated chance of dealing in (放槍) with this kind, summed over opponents: 0 is safe. */
  danger: number;
  score: number;
}

/** Honours that score for `seat` this hand: seat wind, prevailing wind and the three dragons. */
export function valueKinds(s: GameState, seat: number): Set<Kind> {
  return new Set([seatWindKind(seat, s.dealerSeat), prevailingWindKind(s.prevailingWind), KIND_DRAGON, KIND_DRAGON + 1, KIND_DRAGON + 2]);
}

/** 台 a pong of `kind` is worth to `seat`: 1 per dragon, seat wind and prevailing wind (東 for the East-round dealer is 2). */
export function honourTai(s: GameState, seat: number, kind: Kind): number {
  if (!isHonorKind(kind)) return 0;
  if (kind >= KIND_DRAGON) return 1;
  return (kind === seatWindKind(seat, s.dealerSeat) ? 1 : 0) + (kind === prevailingWindKind(s.prevailingWind) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Reading the opponents (only what the table shows)
// ---------------------------------------------------------------------------

/**
 * Chance that a seat is ready (聽牌), by exposed sets (rows, concealed kongs included) and the
 * number of tiles in its discard row (columns, the last one covers 14 and more). Measured on
 * Club-bot tables (`calib-*` seeds, 600 hands, about 90,000 readings) and smoothed so it never
 * falls as the row grows. Five sets exposed leave a single tile, which is always a wait.
 */
const TENPAI_TABLE: readonly (readonly number[])[] = [
  [0, 0, 0.003, 0.02, 0.045, 0.07, 0.12, 0.18, 0.25, 0.32, 0.38, 0.48, 0.56, 0.6, 0.62],
  [0, 0, 0.007, 0.024, 0.04, 0.062, 0.11, 0.15, 0.22, 0.26, 0.3, 0.4, 0.55, 0.65, 0.72],
  [0.05, 0.08, 0.08, 0.12, 0.16, 0.2, 0.31, 0.38, 0.42, 0.5, 0.53, 0.55, 0.63, 0.67, 0.7],
  [0.4, 0.4, 0.4, 0.41, 0.42, 0.44, 0.46, 0.52, 0.6, 0.62, 0.7, 0.75, 0.8, 0.8, 0.8],
  [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.92, 0.92, 0.93, 0.95, 0.95, 0.95, 0.95],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

/**
 * Chance that a suited kind is one of a ready hand's winning tiles, by rank (1–9), before the
 * table read below. Measured as the table above (a ready hand averages 1.55 winning kinds).
 */
const WAIT_BY_RANK = [0, 0.054, 0.071, 0.097, 0.096, 0.096, 0.096, 0.097, 0.071, 0.054];
/** Multiplier by how many copies of the kind are still unseen (0–3) for a suited kind. */
const WAIT_UNSEEN_SUITED = [0.35, 0.45, 0.75, 1.3];
/** An honour only completes a pair or a pong: chance by unseen copies (0–3). A dead honour cannot win. */
const WAIT_HONOUR = [0, 0.004, 0.018, 0.025];
/** The kind is in the seat's own discard row (熟張): measured 0.002 against 0.076 otherwise. */
const OWN_DISCARD_FACTOR = 0.03;
/** Another seat threw the kind after this seat's last discard and it did not win: measured 0.005 against 0.066. */
const PASSED_FACTOR = 0.07;
/** A tile three away was thrown by the seat (筋): a 1 or 9 behind a 4 or 6, and so on, measured per rank. */
const SUJI_FACTOR = [1, 0.2, 0.6, 0.85, 0.75, 0.75, 0.75, 0.85, 0.6, 0.2];
/** Both sides of a 4, 5 or 6 thrown (4 behind 1 and 7). */
const SUJI_BOTH_FACTOR = 0.5;

export interface OpponentRead {
  seat: number;
  /** Estimated chance this seat is ready (聽牌): 0 for the reader's own seat. */
  tenpai: number;
  /** Estimated 台 of this seat's win against the reader (dealer items included when they apply). */
  valueTai: number;
  /** The suit (0 萬, 1 筒, 2 條) its exposed sets and discards point to as a flush, or -1. */
  flushSuit: number;
  /** Kinds this seat has thrown itself. */
  ownDiscards: boolean[];
  /** Kinds other seats threw after this seat's last discard: it would have won on them if it could. */
  passed: boolean[];
}

const suitOf = (k: Kind): number => (k < KIND_WIND ? Math.floor(k / 9) : -1);

/**
 * The suit a seat looks to be collecting for a flush (混一色 / 清一色), or -1. Every exposed suited
 * set is in that suit and its discards almost avoid it; with no exposed set, a long row with none
 * of that suit at all.
 */
function readFlush(p: PlayerState): number {
  // Another seat's concealed kong is face down, so only exposed sets are read.
  const meldSuits = new Set(p.melds.filter((m) => !m.concealed).map((m) => suitOf(kindOf(m.tiles[0]))).filter((x) => x >= 0));
  const bySuit = [0, 0, 0];
  for (const t of p.discards) if (suitOf(kindOf(t)) >= 0) bySuit[suitOf(kindOf(t))]++;
  const n = p.discards.length;
  if (meldSuits.size === 1 && p.melds.length >= 2) {
    const s = [...meldSuits][0];
    return n >= 4 && bySuit[s] <= Math.floor(n * 0.15) ? s : -1;
  }
  if (meldSuits.size === 0 && n >= 10) {
    const empty = [0, 1, 2].filter((s) => bySuit[s] === 0);
    return empty.length === 1 ? empty[0] : -1;
  }
  return -1;
}

/** What the reader at `seat` can tell about each other seat. Uses public information only. */
export function readOpponents(s: GameState, seat: number): OpponentRead[] {
  const rules = s.rules;
  const dealerExtra = rules.dealerTai + rules.dealerStreakTai * s.dealerStreak;
  return s.players.map((p, i) => {
    const ownDiscards = new Array<boolean>(NUM_PLAY_KINDS).fill(false);
    const passed = new Array<boolean>(NUM_PLAY_KINDS).fill(false);
    if (i === seat) return { seat: i, tenpai: 0, valueTai: 0, flushSuit: -1, ownDiscards, passed };
    for (const t of p.discards) ownDiscards[kindOf(t)] = true;
    // Seats after `i` and before the reader in turn order have each thrown once since `i` last did.
    for (let j = (i + 1) % 4; j !== seat; j = (j + 1) % 4) {
      const d = s.players[j].discards;
      if (d.length > 0) passed[kindOf(d[d.length - 1])] = true;
    }
    const melds = Math.min(5, p.melds.length);
    const row = TENPAI_TABLE[melds];
    const tenpai = row[Math.min(row.length - 1, p.discards.length)];
    const flushSuit = readFlush(p);
    // A typical win is about 1.5 台 before patterns; exposed value pongs and a flush add to it.
    let valueTai = 1.5 + (flushSuit >= 0 ? 3 : 0);
    for (const m of p.melds) {
      if (m.type === 'chow' || m.concealed) continue;
      valueTai += honourTai(s, i, kindOf(m.tiles[0]));
    }
    if (i === s.dealerSeat || seat === s.dealerSeat) valueTai += dealerExtra;
    return { seat: i, tenpai, valueTai, flushSuit, ownDiscards, passed };
  });
}

/** Chance that `kind` is one of `r`'s winning tiles if that seat is ready. */
export function waitChance(r: OpponentRead, kind: Kind, unseen: Counts): number {
  const left = Math.max(0, Math.min(3, unseen[kind]));
  let w: number;
  if (isHonorKind(kind)) {
    w = WAIT_HONOUR[left];
    if (r.flushSuit >= 0) w *= 1.5;
  } else {
    const rank = rankOfKind(kind);
    w = WAIT_BY_RANK[rank] * WAIT_UNSEEN_SUITED[left];
    const below = rank > 3 && r.ownDiscards[kind - 3];
    const above = rank < 7 && r.ownDiscards[kind + 3];
    if (below && above) w *= SUJI_BOTH_FACTOR;
    else if (below || above) w *= SUJI_FACTOR[rank];
    if (r.flushSuit >= 0) w *= suitOf(kind) === r.flushSuit ? 2.5 : 0.25;
  }
  if (r.ownDiscards[kind]) w *= OWN_DISCARD_FACTOR;
  if (r.passed[kind]) w *= PASSED_FACTOR;
  return Math.min(1, w);
}

/** Estimated chance that throwing `kind` deals in, summed over the other seats. */
export function dealInRisk(kind: Kind, reads: readonly OpponentRead[], unseen: Counts): number {
  let total = 0;
  for (const r of reads) if (r.tenpai > 0) total += r.tenpai * waitChance(r, kind, unseen);
  return total;
}

/** Expected points lost by throwing `kind`: each seat's deal-in chance times what its win would cost. */
function dealInCost(s: GameState, kind: Kind, reads: readonly OpponentRead[], unseen: Counts): number {
  let total = 0;
  for (const r of reads) if (r.tenpai > 0) total += r.tenpai * waitChance(r, kind, unseen) * (s.rules.basePoints + s.rules.taiPoints * r.valueTai);
  return total;
}

// ---------------------------------------------------------------------------
// Own hand: speed and value
// ---------------------------------------------------------------------------

/**
 * Chance of winning the hand from a shanten (rows 0–4) with a number of draws left in the wall
 * (columns: 0–7, 8–15, …, 56 and more), measured on the same Club tables.
 */
const WIN_TABLE: readonly (readonly number[])[] = [
  [0.125, 0.24, 0.32, 0.42, 0.46, 0.54, 0.64, 0.68],
  [0.016, 0.086, 0.107, 0.14, 0.23, 0.29, 0.4, 0.45],
  [0.005, 0.03, 0.07, 0.074, 0.124, 0.207, 0.276, 0.367],
  [0, 0.01, 0.03, 0.06, 0.082, 0.131, 0.223, 0.27],
  [0, 0, 0.01, 0.03, 0.06, 0.095, 0.147, 0.198],
];

/** Estimated chance of winning from `sh` shanten with `draws` drawable tiles left. */
export function winChance(sh: number, draws: number): number {
  if (sh < 0) return 1;
  const row = WIN_TABLE[Math.min(sh, WIN_TABLE.length - 1)];
  const x = Math.max(0, Math.min(row.length - 1, draws / 8 - 0.5));
  const lo = Math.floor(x);
  const hi = Math.min(row.length - 1, lo + 1);
  const p = row[lo] + (row[hi] - row[lo]) * (x - lo);
  return sh >= WIN_TABLE.length ? p * 0.6 ** (sh - WIN_TABLE.length + 1) : p;
}

/** Suit holding most of the player's suited tiles (hand and sets), with the counts used to read a flush. */
function flushShape(p: PlayerState): { suit: number; inSuit: number; honours: number; offSuit: number; open: boolean } {
  const bySuit = [0, 0, 0];
  let honours = 0;
  const kinds = [...p.hand.map(kindOf), ...p.melds.flatMap((m) => m.tiles.slice(0, 3).map(kindOf))];
  for (const k of kinds) {
    if (k >= NUM_PLAY_KINDS) continue;
    if (suitOf(k) >= 0) bySuit[suitOf(k)]++;
    else honours++;
  }
  const suit = bySuit.indexOf(Math.max(...bySuit));
  const open = p.melds.every((m) => {
    const k = kindOf(m.tiles[0]);
    return k >= NUM_PLAY_KINDS || suitOf(k) === -1 || suitOf(k) === suit;
  });
  return { suit, inSuit: bySuit[suit], honours, offSuit: bySuit[0] + bySuit[1] + bySuit[2] - bySuit[suit], open };
}

/**
 * Tuning knobs of the Pro and Club evaluation. Tuned on seed prefix `tune` and reported on other
 * prefixes (see `scripts/simulate.ts`); exported so the tuning runs can vary them.
 */
export const BOT_WEIGHTS = {
  /** Pro: score points per point of expected deal-in cost (a light lean, as Club)... */
  proLean: 3,
  /** ...against seats estimated at least this likely to be ready (0: every seat). */
  proLeanTenpai: 0,
  /** Pro: how strongly the deal-in cost against a likely-ready seat outweighs the speed it would give up (1 = break even). */
  proFold: 1,
  /** Pro: a seat counts as likely ready from this estimate. */
  proFoldTenpai: 0.5,
  /** Pro: folds only from this shanten (and further). */
  proFoldShanten: 2,
  /** Club: score points per point of expected deal-in cost (a light lean only)... */
  clubDefence: 3,
  /** ...against seats it reads as likely ready (as the old Club defence: exposed sets and a long row). */
  clubDefenceTenpai: 0.5,
  /** Pro: score per 台 for keeping a value-honour pair or pong. */
  proValuePair: 25,
  /** Pro: score for throwing an off-suit tile once a flush is in reach (scaled by how close). */
  proFlush: 400,
  /** Pro: off-suit tiles (hand and sets) at most this many to chase a flush. */
  proFlushReach: 5,
  /** Pro: shanten-steps of credit for a value-honour pong or kong (taken even when it only keeps the shape). */
  proValuePong: 0.5,
  /**
   * Pro stays concealed (門清) rather than claim from this shanten or closer (Club: 1). At 0 Pro
   * only refuses claims once ready; the old value 2 made the paid Pro lose to the free Club.
   */
  proConcealedShanten: 0,
};

/** Rank every discard for the player whose turn it is. Highest score first. */
export function rankDiscards(s: GameState, seat: number, skill: BotSkill = 'club'): DiscardAdvice[] {
  const p = s.players[seat];
  const setsNeeded = TOTAL_SETS - p.melds.length;
  const counts = countsFromKinds(p.hand.map(kindOf));
  const unseen = unseenCounts(s, seat);
  const options = discardOptions(counts, setsNeeded, unseen);
  const defend = skill !== 'beginner';
  const reads = defend ? readOpponents(s, seat) : [];
  const threatened = reads.some((r) => r.tenpai > 0);
  const values = valueKinds(s, seat);
  const bestShanten = Math.min(...options.map((o) => o.shanten));
  // Everyone but a Beginner leans away from danger a little; a Pro also folds against a seat that is
  // probably ready, at the exchange rate of the win chance one step of shanten gives up.
  const lean = !threatened ? 0 : skill === 'pro' ? BOT_WEIGHTS.proLean : skill === 'club' ? BOT_WEIGHTS.clubDefence : 0;
  const leanFrom = skill === 'club' ? BOT_WEIGHTS.clubDefenceTenpai : BOT_WEIGHTS.proLeanTenpai;
  const leanOn = reads.filter((r) => r.tenpai > 0 && r.tenpai >= leanFrom);
  const strong = skill === 'pro' && bestShanten >= BOT_WEIGHTS.proFoldShanten ? reads.filter((r) => r.tenpai >= BOT_WEIGHTS.proFoldTenpai) : [];
  let perPoint = 0;
  if (strong.length > 0) {
    const draws = drawsLeft(s);
    const speed = Math.max(0.004, winChance(bestShanten, draws) - winChance(bestShanten + 1, draws));
    perPoint = (BOT_WEIGHTS.proFold * 1000) / (speed * winPoints(s, seat));
  }
  const flush = skill === 'pro' ? flushShape(p) : null;
  const chaseFlush = flush !== null && flush.open && flush.offSuit > 0 && flush.offSuit <= BOT_WEIGHTS.proFlushReach && flush.inSuit >= 8;
  const out: DiscardAdvice[] = [];
  for (const o of options) {
    const tile = p.hand.find((t) => kindOf(t) === o.kind)!;
    let score = -o.shanten * 1000 + o.acceptance * 10;
    // Prefer throwing isolated honours/terminals when otherwise equal, but keep honours that score:
    // the more 台 a pong of it is worth, the longer it stays (東 as the East-round dealer is worth 2).
    if (isHonorKind(o.kind)) score += skill !== 'beginner' ? 3 - 3 * honourTai(s, seat, o.kind) : 3;
    else if (rankOfKind(o.kind) === 1 || rankOfKind(o.kind) === 9) score += 2;
    // Fewer unseen copies → tile is less useful to keep.
    score += (4 - unseen[o.kind]) * 1;
    const risk = defend ? dealInRisk(o.kind, reads, unseen) : 0;
    if (lean > 0) score -= lean * dealInCost(s, o.kind, leanOn, unseen);
    if (perPoint > 0) score -= perPoint * dealInCost(s, o.kind, strong, unseen);
    if (skill === 'pro') {
      // 台 value: keep value-honour pairs and pongs, and chase a flush once it is in reach.
      for (const k of values) if (counts[k] - (k === o.kind ? 1 : 0) >= 2) score += BOT_WEIGHTS.proValuePair * honourTai(s, seat, k);
      if (chaseFlush && suitOf(o.kind) >= 0 && suitOf(o.kind) !== flush!.suit) {
        const reach = BOT_WEIGHTS.proFlushReach;
        score += (BOT_WEIGHTS.proFlush * (reach + 1 - flush!.offSuit)) / reach;
      }
    }
    out.push({ tile, kind: o.kind, shanten: o.shanten, acceptance: o.acceptance, accepts: o.accepts, danger: risk, score });
  }
  return out.sort((a, b) => b.score - a.score || a.kind - b.kind);
}

/**
 * What a win is worth to `seat` in points, roughly: a quarter of wins are self-drawn (all three
 * pay), the rest by discard; about 1.5 台 plus held value pongs and pairs, and the dealer's 台.
 */
function winPoints(s: GameState, seat: number): number {
  const p = s.players[seat];
  const rules = s.rules;
  let tai = 1.5;
  const counts = countsFromKinds(p.hand.map(kindOf));
  for (const k of valueKinds(s, seat)) if (counts[k] >= 2) tai += 0.6 * honourTai(s, seat, k);
  for (const m of p.melds) if (m.type !== 'chow') tai += honourTai(s, seat, kindOf(m.tiles[0]));
  const dealerExtra = rules.dealerTai + rules.dealerStreakTai * s.dealerStreak;
  const payers = seat === s.dealerSeat ? 1 : 1 / 3;
  return 1.5 * (rules.basePoints + rules.taiPoints * (tai + dealerExtra * payers));
}

export function currentShanten(s: GameState, seat: number): number {
  const p = s.players[seat];
  return shanten(countsFromKinds(p.hand.map(kindOf)), TOTAL_SETS - p.melds.length);
}

/** Shanten of the hand after taking a claim and then making its best discard. */
export function shantenAfterClaim(s: GameState, seat: number, action: Action): number {
  const p = s.players[seat];
  const pending = s.pending!;
  const k = kindOf(pending.tile);
  let hand = p.hand.map(kindOf);
  let melds = p.melds.length;
  if (action.type === 'pong') {
    let removed = 0;
    hand = hand.filter((x) => (x === k && removed < 2 ? (removed++, false) : true));
    melds++;
  } else if (action.type === 'kong') {
    hand = hand.filter((x) => x !== k);
    melds++;
    // Kong draws a replacement: approximate by treating hand as 3n+1 and returning shanten directly.
    return shanten(countsFromKinds(hand), TOTAL_SETS - melds);
  } else if (action.type === 'chi') {
    const [a, b] = action.tiles.map(kindOf);
    hand = removeOne(removeOne(hand, a), b);
    melds++;
  } else return currentShanten(s, seat);
  // hand now has 3n+1 tiles for the new meld count: shanten() accepts that size.
  return shanten(countsFromKinds(hand), TOTAL_SETS - melds);
}

function removeOne(arr: Kind[], k: Kind): Kind[] {
  const i = arr.indexOf(k);
  if (i < 0) return arr;
  const out = arr.slice();
  out.splice(i, 1);
  return out;
}

export type BotSkill = 'beginner' | 'club' | 'pro';

/** The skill the coach (hints) and the post-hand review both use, so their advice agrees. */
export const COACH_SKILL: BotSkill = 'pro';

export interface BotOptions {
  /** Claim pongs/chis only when they reduce shanten (default true). */
  greedyClaims?: boolean;
  /** Keep the hand concealed when already close to winning (default true). */
  valueConcealed?: boolean;
  /** Seed for tie-breaking randomness so bots do not play identically. */
  seed?: string;
  /**
   * Playing strength. `beginner` adds noise and ignores defence, `club` is the
   * plain heuristic, `pro` weighs defence and hand value more heavily.
   */
  skill?: BotSkill;
}

export const BOT_SKILLS: Record<BotSkill, { label: string; labelZh: string; description: string; rating: number }> = {
  beginner: { label: 'Beginner', labelZh: '新手', description: 'Makes efficiency mistakes and never folds. Good for learning the flow.', rating: 800 },
  club: { label: 'Club player', labelZh: '牌友', description: 'Solid tile efficiency, claims when it helps, basic defence.', rating: 1400 },
  pro: { label: 'Pro', labelZh: '高手', description: 'Fast and efficient, folds against ready players and keeps scoring tiles.', rating: 1900 },
};

/** Decide an action for `seat`, or null if it is not their move. */
export function chooseAction(s: GameState, seat: number, opts: BotOptions = {}): Action | null {
  const actions = legalActions(s, seat);
  if (actions.length === 0) return null;
  const rng = createRng(`${opts.seed ?? 'bot'}:${s.handNumber}:${s.turnCounter}:${seat}`);

  if (actions.some((a) => a.type === 'hu')) return { type: 'hu' };

  if (s.phase === 'discard') {
    const before = currentShanten(s, seat);
    // Concealed/added kong when it does not hurt the shape.
    for (const a of actions) {
      if (a.type !== 'kong') continue;
      const p = s.players[seat];
      const k = kindOf(a.tile);
      const rest = p.hand.map(kindOf).filter((x) => x !== k);
      const inHand = p.hand.filter((t) => kindOf(t) === k).length;
      const after = inHand === 4 ? shanten(countsFromKinds(rest), TOTAL_SETS - p.melds.length - 1) : shanten(countsFromKinds(removeOne(p.hand.map(kindOf), k)), TOTAL_SETS - p.melds.length);
      // `before` is measured on a 3n+2 hand; the post-kong shape is 3n+1 for one fewer set.
      if (after <= before) return a;
    }
    const skill = opts.skill ?? 'club';
    const ranked = rankDiscards(s, seat, skill);
    // Beginners pick among a wider band (acceptance mistakes rather than shanten ones). Pros always
    // take the top-ranked tile, with no random tie-break, so the coach's discard is the hint's best discard.
    const band = skill === 'beginner' ? 150 : skill === 'club' ? 5 : 0;
    if (band === 0) return { type: 'discard', tile: ranked[0].tile };
    let top = ranked.filter((r) => r.score >= ranked[0].score - band);
    // Club keeps its scoring honours whatever the random band holds: a value honour is thrown only
    // when every candidate is one (so the dealer does not throw 東 while holding a lone 北).
    if (skill === 'club') {
      const plain = top.filter((r) => honourTai(s, seat, r.kind) === 0);
      if (plain.length > 0) top = plain;
    }
    if (skill === 'beginner' && rng.next() < 0.25 && ranked.length > 1) top = ranked.slice(0, Math.min(ranked.length, 4));
    return { type: 'discard', tile: top[rng.int(top.length)].tile };
  }

  // Claim phase
  const skill = opts.skill ?? 'club';
  const greedy = opts.greedyClaims ?? true;
  const before = currentShanten(s, seat);
  const p = s.players[seat];
  const concealed = p.melds.every((m) => m.concealed);
  // Stay concealed (門清) instead of calling when already this close: Club at one from ready, Pro only
  // once ready (`BOT_WEIGHTS.proConcealedShanten`). Pro at 2 lost to Club; the CI gates (the recorded
  // decision replay in bots.test.ts and `npm run sim -- --gate`) fail if it goes back.
  const valueConcealed = (opts.valueConcealed ?? skill !== 'beginner') && concealed && before <= (skill === 'pro' ? BOT_WEIGHTS.proConcealedShanten : 1);
  // Beginners often grab a pong/chi, as long as it does not set them back.
  if (skill === 'beginner') {
    const harmless = (a: Action) => before - shantenAfterClaim(s, seat, a) >= 0;
    const grab = actions.find((a) => (a.type === 'pong' || a.type === 'kong') && harmless(a)) ?? actions.find((a) => a.type === 'chi' && harmless(a));
    if (grab && rng.next() < 0.4) return grab;
  }
  let best: { action: Action; gain: number } | null = null;
  for (const a of actions) {
    if (a.type === 'pass' || a.type === 'hu') continue;
    const after = shantenAfterClaim(s, seat, a);
    let gain = before - after;
    if (a.type === 'kong') gain += 0.5; // extra tai and a replacement draw
    // Pro: a value-honour pong (or kong) is 台 in hand, worth taking even when it only keeps the shape.
    if (skill === 'pro' && (a.type === 'pong' || a.type === 'kong') && honourTai(s, seat, kindOf(s.pending!.tile)) > 0) gain += BOT_WEIGHTS.proValuePong;
    // Kongs included: a claimed kong (明槓) exposes the hand just as a pong does and loses 門清.
    if (valueConcealed) gain -= 1;
    if (!greedy || gain > 0) {
      if (!best || gain > best.gain) best = { action: a, gain };
    }
  }
  return best ? best.action : { type: 'pass' };
}

/** The coach's pick for `seat`: the move hints recommend and the review grades against. */
export function coachAction(s: GameState, seat: number): Action | null {
  return chooseAction(s, seat, { skill: COACH_SKILL, seed: 'coach' });
}
