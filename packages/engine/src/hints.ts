/**
 * Coaching layer ("Learn" mode). Turns engine analysis into human-readable
 * advice: what you are waiting on, how far from ready you are, which discard is
 * best and why, and what a claim would cost or gain in 台.
 */
import { chooseAction, currentShanten, rankDiscards, shantenAfterClaim, unseenCounts, type DiscardAdvice } from './bot';
import { countsFromKinds, TOTAL_SETS, waits } from './hand';
import { type Action, type GameState, legalActions, buildWinContext, waitsFor } from './game';
import { scoreWin, seatWindKind, prevailingWindKind, type ScoreResult } from './scoring';
import { kindInfo, kindOf, type Kind, type TileId } from './tiles';

export interface WaitInfo {
  kind: Kind;
  /** Copies not visible to the player. */
  remaining: number;
}

export interface ClaimAdvice {
  action: Action;
  label: string;
  recommended: boolean;
  reason: string;
}

export interface Hint {
  seat: number;
  phase: GameState['phase'];
  shanten: number;
  /** Plain-language status, e.g. "Ready (聽牌) — waiting on 3 kinds". */
  status: string;
  waits: WaitInfo[];
  discards: DiscardAdvice[];
  bestDiscard?: DiscardAdvice;
  discardReason?: string;
  claims: ClaimAdvice[];
  /** If the player can win right now, the projected score. */
  winPreview?: ScoreResult;
  /** Useful honor tiles for this seat this round. */
  valueTiles: Kind[];
}

export function describeKind(k: Kind): string {
  const i = kindInfo(k);
  return `${i.nameZh} (${i.nameEn})`;
}

export function hintFor(s: GameState, seat: number): Hint {
  const actions = legalActions(s, seat);
  const valueTiles = [seatWindKind(seat, s.dealerSeat), prevailingWindKind(s.prevailingWind), 31, 32, 33];
  const base: Hint = {
    seat,
    phase: s.phase,
    shanten: 0,
    status: '',
    waits: [],
    discards: [],
    claims: [],
    valueTiles,
  };
  if (s.phase === 'ended') {
    base.status = 'Hand over';
    return base;
  }
  const unseen = unseenCounts(s, seat);

  const canHu = actions.some((a) => a.type === 'hu');
  if (canHu) {
    const tile = s.phase === 'discard' ? s.lastDrawn! : s.pending!.tile;
    const selfDrawn = s.phase === 'discard';
    base.winPreview = scoreWin(buildWinContext(s, { seat, tile, selfDrawn, fromSeat: selfDrawn ? undefined : s.pending!.from, robbingKong: s.pending?.kind === 'addedKong' }));
  }

  if (s.phase === 'discard' && s.turn === seat) {
    const sh = currentShanten(s, seat);
    base.shanten = sh;
    base.discards = rankDiscards(s, seat);
    base.bestDiscard = base.discards[0];
    if (canHu) {
      base.status = `You can win now (${selfDrawLabel(s)}) for ${base.winPreview!.tai} 台.`;
    } else if (base.bestDiscard) {
      const d = base.bestDiscard;
      const afterWaits = d.shanten === 0 ? waitsAfterDiscard(s, seat, d.tile, unseen) : [];
      base.waits = afterWaits;
      base.discardReason = explainDiscard(d, afterWaits);
      base.status = statusText(d.shanten);
    }
    const kongs = actions.filter((a) => a.type === 'kong');
    for (const k of kongs) {
      base.claims.push({
        action: k,
        label: `Kong ${describeKind(kindOf((k as { tile: TileId }).tile))}`,
        recommended: ((pick) => pick?.type === 'kong' && kindOf(pick.tile) === kindOf((k as { tile: TileId }).tile))(chooseAction(s, seat)),
        reason: 'A kong draws a replacement tile and can add 槓上開花 (1 台) if you win on it. Skip it if the four tiles are part of two sets.',
      });
    }
    return base;
  }

  if (s.phase === 'claim') {
    const sh = currentShanten(s, seat);
    base.shanten = sh;
    base.waits = waitsFor(s, seat).map((k) => ({ kind: k, remaining: unseen[k] }));
    base.status = sh === 0 ? `Ready — waiting on ${base.waits.length} kind(s).` : statusText(sh);
    const botPick = chooseAction(s, seat);
    for (const a of actions) {
      if (a.type === 'pass') continue;
      const label = claimLabel(a, s);
      const recommended = botPick !== null && JSON.stringify(botPick) === JSON.stringify(a);
      base.claims.push({ action: a, label, recommended, reason: claimReason(a, s, seat, sh, recommended) });
    }
    if (canHu) base.status = `You can win on this discard for ${base.winPreview!.tai} 台.`;
    return base;
  }

  base.shanten = currentShanten(s, seat);
  base.waits = waitsFor(s, seat).map((k) => ({ kind: k, remaining: unseen[k] }));
  base.status = base.shanten === 0 ? `Ready (聽牌) — waiting on ${base.waits.map((w) => kindInfo(w.kind).nameZh).join(' ')}` : statusText(base.shanten);
  return base;
}

function selfDrawLabel(s: GameState): string {
  return s.drawSource === 'kong' ? '槓上開花' : s.drawSource === 'flower' ? '花上自摸' : '自摸';
}

function statusText(sh: number): string {
  if (sh <= 0) return 'Ready (聽牌) after this discard.';
  if (sh === 1) return 'One tile from ready (一向聽).';
  if (sh === 2) return 'Two tiles from ready (兩向聽).';
  return `${sh} tiles from ready — build sets, keep pairs.`;
}

function waitsAfterDiscard(s: GameState, seat: number, tile: TileId, unseen: number[]): WaitInfo[] {
  const p = s.players[seat];
  const rest = p.hand.filter((t) => t !== tile).map(kindOf);
  return waits(countsFromKinds(rest), TOTAL_SETS - p.melds.length).map((k) => ({ kind: k, remaining: unseen[k] }));
}

function explainDiscard(d: DiscardAdvice, afterWaits: WaitInfo[]): string {
  const name = describeKind(d.kind);
  if (d.shanten === 0) {
    const w = afterWaits.map((x) => `${kindInfo(x.kind).nameZh}×${x.remaining}`).join(', ');
    return `Discard ${name} to be ready, waiting on ${w || 'nothing visible'}.`;
  }
  if (d.accepts.length === 0) return `Discard ${name}; it does not fit any set you are building.`;
  const acc = d.accepts.slice(0, 6).map((k) => kindInfo(k).nameZh).join(' ');
  return `Discard ${name}. ${d.accepts.length} kinds (${acc}${d.accepts.length > 6 ? '…' : ''}) then improve your hand — ${d.acceptance} copies still unseen.`;
}

function claimLabel(a: Action, s: GameState): string {
  const tile = s.pending ? describeKind(kindOf(s.pending.tile)) : '';
  switch (a.type) {
    case 'hu':
      return `Win (胡) on ${tile}`;
    case 'pong':
      return `Pong (碰) ${tile}`;
    case 'kong':
      return `Kong (槓) ${tile}`;
    case 'chi':
      return `Chi (吃) ${a.tiles.map((t) => kindInfo(kindOf(t)).nameZh).join('')} + ${tile}`;
    default:
      return a.type;
  }
}

function claimReason(a: Action, s: GameState, seat: number, sh: number, recommended: boolean): string {
  const p = s.players[seat];
  const concealed = p.melds.every((m) => m.concealed);
  if (a.type === 'hu') return 'Take the win. Compare with your waits only if you are chasing a much bigger hand.';
  if (a.type === 'kong') return recommended ? 'Kong: adds a replacement draw and keeps all four tiles together.' : 'The kong would break up sets you are using elsewhere.';
  const breaksConcealed = concealed ? ' You would lose 門清 (1 台, or 門清自摸 3 台).' : '';
  const after = shantenAfterClaim(s, seat, a);
  const improves = after < sh;
  const readyAfter = after === 0;
  if (recommended) return `${readyAfter ? 'This claim makes you ready.' : 'This claim brings you closer to ready.'}${breaksConcealed}`;
  if (improves) return `${readyAfter ? 'This claim would make you ready' : 'This claim would bring you closer to ready'}, but your concealed hand is worth more here.${breaksConcealed}`;
  if (sh === 0) return `You are already ready; claiming would not help.${breaksConcealed}`;
  return `This does not reduce your shanten count.${breaksConcealed}`;
}
