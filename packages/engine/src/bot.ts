/**
 * Heuristic bot. Good enough to be a sparring partner and to auto-play for a
 * disconnected or timed-out player. The same evaluation drives the coach.
 */
import { countsFromKinds, discardOptions, shanten, TOTAL_SETS, type Counts } from './hand';
import { type Action, type GameState, legalActions } from './game';
import { createRng } from './rng';
import { isHonorKind, kindOf, NUM_PLAY_KINDS, rankOfKind, type Kind, type TileId } from './tiles';

/** Kinds not visible to `seat`: 4 copies minus own hand, all melds, discards and the pending tile. */
export function unseenCounts(s: GameState, seat: number): Counts {
  const unseen = new Array<number>(NUM_PLAY_KINDS).fill(4);
  const see = (t: TileId) => {
    const k = kindOf(t);
    if (k < NUM_PLAY_KINDS) unseen[k]--;
  };
  for (let i = 0; i < 4; i++) {
    const p = s.players[i];
    if (i === seat) p.hand.forEach(see);
    p.melds.forEach((m) => m.tiles.forEach(see));
    p.discards.forEach(see);
  }
  if (s.pending) see(s.pending.tile);
  return unseen;
}

export interface DiscardAdvice {
  tile: TileId;
  kind: Kind;
  shanten: number;
  acceptance: number;
  accepts: Kind[];
  score: number;
}

/** Rank every discard for the player whose turn it is. Highest score first. */
export function rankDiscards(s: GameState, seat: number, skill: BotSkill = 'club'): DiscardAdvice[] {
  const p = s.players[seat];
  const setsNeeded = TOTAL_SETS - p.melds.length;
  const counts = countsFromKinds(p.hand.map(kindOf));
  const unseen = unseenCounts(s, seat);
  const options = discardOptions(counts, setsNeeded, unseen);
  const dangerous = skill === 'beginner' ? new Set<Kind>() : dangerKinds(s, seat);
  const dangerWeight = skill === 'pro' ? 120 : 40;
  const out: DiscardAdvice[] = [];
  for (const o of options) {
    const tile = p.hand.find((t) => kindOf(t) === o.kind)!;
    let score = -o.shanten * 1000 + o.acceptance * 10;
    // Prefer throwing isolated honors/terminals when otherwise equal.
    if (isHonorKind(o.kind)) score += 3;
    else if (rankOfKind(o.kind) === 1 || rankOfKind(o.kind) === 9) score += 2;
    // Fewer unseen copies → tile is less useful to keep.
    score += (4 - unseen[o.kind]) * 1;
    // Defence: avoid feeding a player who is visibly close to winning.
    if (dangerous.has(o.kind)) score -= dangerWeight;
    // Pros keep value tiles (own wind, round wind, dragons) a little longer when they still have a pair chance.
    if (skill === 'pro' && isHonorKind(o.kind) && unseen[o.kind] >= 2 && counts[o.kind] === 1 && o.shanten > 1) score -= 4;
    out.push({ tile, kind: o.kind, shanten: o.shanten, acceptance: o.acceptance, accepts: o.accepts, score });
  }
  return out.sort((a, b) => b.score - a.score || a.kind - b.kind);
}

/**
 * Crude danger model: when an opponent has 4 exposed melds they are waiting on
 * one pair-or-partial; tiles they have not discarded and that are not already
 * safe become risky. Also treats tiles the leader has discarded as safe.
 */
function dangerKinds(s: GameState, seat: number): Set<Kind> {
  const danger = new Set<Kind>();
  for (let i = 0; i < 4; i++) {
    if (i === seat) continue;
    const p = s.players[i];
    if (p.melds.length < 4) continue;
    const safe = new Set(p.discards.map(kindOf));
    for (let k = 0; k < NUM_PLAY_KINDS; k++) if (!safe.has(k)) danger.add(k);
  }
  return danger;
}

export function currentShanten(s: GameState, seat: number): number {
  const p = s.players[seat];
  return shanten(countsFromKinds(p.hand.map(kindOf)), TOTAL_SETS - p.melds.length);
}

/** Shanten of the hand after taking a claim and then making its best discard. */
function shantenAfterClaim(s: GameState, seat: number, action: Action): number {
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
  pro: { label: 'Pro', labelZh: '高手', description: 'Efficient, defends against ready players and chases value.', rating: 1900 },
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
    // Beginners pick among a wider band (including real mistakes); pros pick the best.
    const band = skill === 'beginner' ? 1200 : skill === 'club' ? 5 : 0;
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
  const valueConcealed = (opts.valueConcealed ?? skill !== 'beginner') && concealed && before <= (skill === 'pro' ? 2 : 1);
  // Beginners grab almost any pong/chi they can.
  if (skill === 'beginner') {
    const grab = actions.find((a) => a.type === 'pong' || a.type === 'kong') ?? actions.find((a) => a.type === 'chi');
    if (grab && rng.next() < 0.8) return grab;
  }
  let best: { action: Action; gain: number } | null = null;
  for (const a of actions) {
    if (a.type === 'pass' || a.type === 'hu') continue;
    const after = shantenAfterClaim(s, seat, a);
    let gain = before - after;
    if (a.type === 'kong') gain += 0.5; // extra tai and a replacement draw
    if (valueConcealed && a.type !== 'kong') gain -= 1;
    if (!greedy || gain > 0) {
      if (!best || gain > best.gain) best = { action: a, gain };
    }
  }
  return best ? best.action : { type: 'pass' };
}
