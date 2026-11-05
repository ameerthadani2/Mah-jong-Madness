/**
 * Heuristic bot. Good enough to be a sparring partner and to auto-play for a
 * disconnected or timed-out player. The same evaluation drives the coach.
 *
 * Bots only use what a player could see at the table: their own hand and
 * melds, every discard, and other seats' exposed melds. Another seat's
 * concealed kong stays face down, so its tiles count as unseen.
 */
import { countsFromKinds, discardOptions, shanten, TOTAL_SETS, type Counts } from './hand';
import { type Action, type GameState, type PlayerState, legalActions } from './game';
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
  /** Estimated risk of dealing in with this kind: 0 is safe; summed over opponents who look ready. */
  danger: number;
  score: number;
}

/** Honours that score for `seat` this hand: seat wind, prevailing wind and the three dragons. */
export function valueKinds(s: GameState, seat: number): Set<Kind> {
  return new Set([seatWindKind(seat, s.dealerSeat), prevailingWindKind(s.prevailingWind), KIND_DRAGON, KIND_DRAGON + 1, KIND_DRAGON + 2]);
}

/**
 * How close each opponent visibly is to winning, from what the table shows (own seat is 0).
 * A 16-tile hand needs five sets and a pair, so four exposed melds leave one set or the pair to
 * finish (1.0); three melds after eight or more discards is a hand well on its way (0.6).
 */
export function threats(s: GameState, seat: number): number[] {
  return s.players.map((p, i) => {
    if (i === seat) return 0;
    if (p.melds.length >= 4) return 1;
    if (p.melds.length === 3 && p.discards.length >= 8) return 0.6;
    return 0;
  });
}

/**
 * Risk of discarding `kind`, summed over threatening opponents. A kind an opponent has thrown
 * themselves is treated as safe against them (players rarely wait on what they threw, although
 * Taiwanese rules have no furiten). Honours only complete a pair or a pong, so they are safer, and
 * nearly dead ones very safe; terminals join fewer chows than middle tiles.
 */
export function dealInDanger(s: GameState, seat: number, kind: Kind, levels: readonly number[], unseen: Counts): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    if (i === seat || levels[i] === 0) continue;
    if (s.players[i].discards.some((t) => kindOf(t) === kind)) continue;
    let risk: number;
    // A fully dead honour (every copy visible) cannot complete anything: no risk at all.
    if (isHonorKind(kind)) risk = unseen[kind] === 0 ? 0 : unseen[kind] === 1 ? 0.1 : 0.3;
    else if (rankOfKind(kind) === 1 || rankOfKind(kind) === 9) risk = 0.6;
    else risk = 1;
    total += levels[i] * risk;
  }
  return total;
}

/**
 * Score points per unit of danger. Pros fold (a safe tile outweighs a step of shanten) when two or
 * more from ready while someone looks ready, and only lean towards safety when close themselves.
 * Club players always lean a little; Beginners never defend.
 */
function defenceWeight(skill: BotSkill, handShanten: number, maxThreat: number): number {
  if (skill === 'beginner' || maxThreat === 0) return 0;
  if (skill === 'club') return 40;
  return handShanten >= 2 && maxThreat >= 0.6 ? 1500 : 200;
}

const suitIndex = (k: Kind): number => (k < KIND_WIND ? Math.floor(k / 9) : -1);

/** Suit (0 萬, 1 筒, 2 條) that at least 11 of the player's tiles share, unless an exposed set rules a flush out. */
function flushSuit(p: PlayerState): number | null {
  const bySuit = [0, 0, 0];
  for (const k of [...p.hand.map(kindOf), ...p.melds.flatMap((m) => m.tiles.slice(0, 3).map(kindOf))]) if (suitIndex(k) >= 0) bySuit[suitIndex(k)]++;
  const best = bySuit.indexOf(Math.max(...bySuit));
  if (bySuit[best] < 11) return null;
  return p.melds.every((m) => suitIndex(kindOf(m.tiles[0])) === -1 || suitIndex(kindOf(m.tiles[0])) === best) ? best : null;
}

/** Rank every discard for the player whose turn it is. Highest score first. */
export function rankDiscards(s: GameState, seat: number, skill: BotSkill = 'club'): DiscardAdvice[] {
  const p = s.players[seat];
  const setsNeeded = TOTAL_SETS - p.melds.length;
  const counts = countsFromKinds(p.hand.map(kindOf));
  const unseen = unseenCounts(s, seat);
  const options = discardOptions(counts, setsNeeded, unseen);
  const levels = skill === 'beginner' ? [0, 0, 0, 0] : threats(s, seat);
  const weight = defenceWeight(skill, Math.min(...options.map((o) => o.shanten)), Math.max(...levels));
  const values = valueKinds(s, seat);
  const flush = skill === 'pro' ? flushSuit(p) : null;
  const out: DiscardAdvice[] = [];
  for (const o of options) {
    const tile = p.hand.find((t) => kindOf(t) === o.kind)!;
    let score = -o.shanten * 1000 + o.acceptance * 10;
    // Prefer throwing isolated honours/terminals when otherwise equal, but keep honours that score.
    if (isHonorKind(o.kind)) score += skill !== 'beginner' && values.has(o.kind) ? 1 : 3;
    else if (rankOfKind(o.kind) === 1 || rankOfKind(o.kind) === 9) score += 2;
    // Fewer unseen copies → tile is less useful to keep.
    score += (4 - unseen[o.kind]) * 1;
    // Defence: avoid feeding a player who is visibly close to winning.
    const risk = weight > 0 ? dealInDanger(s, seat, o.kind, levels, unseen) : 0;
    score -= weight * risk;
    if (skill === 'pro') {
      // 台 value: keep value-honour pairs and pongs, and chase a flush once most tiles share a suit.
      for (const k of values) if (counts[k] - (k === o.kind ? 1 : 0) >= 2) score += 2;
      if (flush !== null && suitIndex(o.kind) >= 0 && suitIndex(o.kind) !== flush) score += 3;
    }
    out.push({ tile, kind: o.kind, shanten: o.shanten, acceptance: o.acceptance, accepts: o.accepts, danger: risk, score });
  }
  return out.sort((a, b) => b.score - a.score || a.kind - b.kind);
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
  // once ready. The earlier unpaired figures behind choosing 0 over 1 for Pro were within noise and
  // were not re-measured. The paired ladder (`simulate.ts --ladder pro 4000`, each seed also played
  // with Club in the test seat) puts Pro ahead of Club by 8.4 pts/hand, standard error 3.0, with a
  // 95% interval of [2.5, 14.3]; that is clearly positive.
  const valueConcealed = (opts.valueConcealed ?? skill !== 'beginner') && concealed && before <= (skill === 'pro' ? 0 : 1);
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
