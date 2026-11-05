/**
 * Coaching layer ("Learn" mode). Turns engine analysis into human-readable
 * advice: what you are waiting on, how far from ready you are, which discard is
 * best and why, and what a claim would cost or gain in 台.
 *
 * Every sentence also has a machine-readable form: a stable `…Key` naming a
 * template in ENGINE_REASON_KEYS (see review.ts) and the `…Params` that fill
 * it, so the app can show the advice in the player's language. Each English
 * text field is exactly the English template filled with those params.
 */
import { coachAction, COACH_SKILL, currentShanten, rankDiscards, shantenAfterClaim, unseenCounts, valueKinds, type DiscardAdvice } from './bot';
import { countsFromKinds, TOTAL_SETS, waits } from './hand';
import { type Action, type GameState, legalActions, buildWinContext, sameAction, waitsFor } from './game';
import { scoreWin, type ScoreResult } from './scoring';
import { kindInfo, kindOf, type Kind, type TileId } from './tiles';

/** Values for a reason template's %{name} placeholders: tile codes, tile names and numbers. */
export type ReasonParams = Record<string, string | number>;

/** An English and a first-pass Traditional Chinese template, in i18n-js %{param} syntax. */
export interface ReasonTemplate {
  en: string;
  'zh-TW': string;
}

export type ReasonLocale = keyof ReasonTemplate;

/** A key into ENGINE_REASON_KEYS plus the params its template needs. */
export interface Reason {
  key: string;
  params: ReasonParams;
}

/** Fills %{name} placeholders; a missing param is left as written so a gap is visible rather than blank. */
export function fillTemplate(template: string, params: ReasonParams): string {
  return template.replace(/%\{(\w+)\}/g, (whole: string, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}

/** The placeholder names a template uses, each once, in order of first appearance. */
export function templateParams(template: string): string[] {
  return [...new Set([...template.matchAll(/%\{(\w+)\}/g)].map((m) => m[1]))];
}

const LOSES_CONCEALED_EN = ' You would lose 門清 (1 台, or 門清自摸 3 台).';
const LOSES_CONCEALED_ZH = '會失去門清（1 台，門清自摸則是 3 台）。';

/** A claim reason and its "you would lose 門清" form, as two keys (i18n-js templates have no conditionals). */
function withConcealedVariant<K extends string>(key: K, en: string, zh: string): Record<K | `${K}Concealed`, ReasonTemplate> {
  return {
    [key]: { en, 'zh-TW': zh },
    [`${key}Concealed`]: { en: en + LOSES_CONCEALED_EN, 'zh-TW': zh + LOSES_CONCEALED_ZH },
  } as Record<K | `${K}Concealed`, ReasonTemplate>;
}

/**
 * Coach templates. Tile params come in three forms: `tile` (code such as "5m"),
 * `tileName` (Chinese and English name, used by the English text) and `tileZh`
 * (Chinese name only). zh-TW templates: first pass, needs native review.
 */
export const HINT_REASON_KEYS = {
  'hint.status.handOver': { en: 'Hand over', 'zh-TW': '本局結束' },
  'hint.status.canWinSelfDraw': { en: 'You can win now (%{how}) for %{tai} 台.', 'zh-TW': '現在就能胡（%{how}），共 %{tai} 台。' },
  'hint.status.canWinDiscard': { en: 'You can win on this discard for %{tai} 台.', 'zh-TW': '這張可以胡，共 %{tai} 台。' },
  'hint.status.readyAfterDiscard': { en: 'Ready (聽牌) after this discard.', 'zh-TW': '打完這張就聽牌。' },
  'hint.status.oneAway': { en: 'One tile from ready (一向聽).', 'zh-TW': '一向聽：再進一張就聽牌。' },
  'hint.status.twoAway': { en: 'Two tiles from ready (兩向聽).', 'zh-TW': '兩向聽：還差兩張才聽牌。' },
  'hint.status.manyAway': { en: '%{shanten} tiles from ready — build sets, keep pairs.', 'zh-TW': '%{shanten} 向聽：先湊面子，留住對子。' },
  'hint.status.readyCount': { en: 'Ready — waiting on %{kinds} kind(s).', 'zh-TW': '聽牌：聽 %{kinds} 種牌。' },
  'hint.status.readyWaits': { en: 'Ready (聽牌) — waiting on %{waits}', 'zh-TW': '聽牌：聽 %{waits}' },

  'hint.discard.fold': {
    en: 'An opponent looks ready. Discard %{tileName}, a safer tile, rather than pushing a dangerous one: losing this hand costs less than paying for theirs.',
    'zh-TW': '有對手看起來已經聽牌。打 %{tileZh} 這張較安全的牌，不要硬打危險牌：放棄這手牌，比付對方的台便宜。',
  },
  'hint.discard.ready': { en: 'Discard %{tileName} to be ready, waiting on %{waits}.', 'zh-TW': '打 %{tileZh} 就聽牌，聽 %{waits}。' },
  'hint.discard.readyNoWaits': { en: 'Discard %{tileName} to be ready, waiting on nothing visible.', 'zh-TW': '打 %{tileZh} 就聽牌，但看不到還能聽的牌。' },
  'hint.discard.isolated': { en: 'Discard %{tileName}; it does not fit any set you are building.', 'zh-TW': '打 %{tileZh}：它跟你正在湊的面子都搭不上。' },
  'hint.discard.efficiency': {
    en: 'Discard %{tileName}. %{kinds} kinds (%{accepts}) then improve your hand — %{copies} copies still unseen.',
    'zh-TW': '打 %{tileZh}。之後有 %{kinds} 種牌（%{accepts}）能改善手牌，還有 %{copies} 張沒出現。',
  },

  'hint.label.kongSelf': { en: 'Kong %{tileName}', 'zh-TW': '槓 %{tileZh}' },
  'hint.label.hu': { en: 'Win (胡) on %{tileName}', 'zh-TW': '胡 %{tileZh}' },
  'hint.label.pong': { en: 'Pong (碰) %{tileName}', 'zh-TW': '碰 %{tileZh}' },
  'hint.label.kong': { en: 'Kong (槓) %{tileName}', 'zh-TW': '槓 %{tileZh}' },
  'hint.label.chi': { en: 'Chi (吃) %{handTiles} + %{tileName}', 'zh-TW': '吃 %{handTiles} + %{tileZh}' },
  'hint.label.other': { en: '%{action}', 'zh-TW': '%{action}' },

  'hint.claim.kongSelf': {
    en: 'A kong draws a replacement tile and can add 槓上開花 (1 台) if you win on it. Skip it if the four tiles are part of two sets.',
    'zh-TW': '開槓可以補一張牌，補到胡牌還能加槓上開花（1 台）。如果這四張牌分屬兩組面子，就別槓。',
  },
  'hint.claim.hu': { en: 'Take the win. Compare with your waits only if you are chasing a much bigger hand.', 'zh-TW': '胡下去吧。只有在做更大的牌時，才需要跟你聽的牌比較。' },
  'hint.claim.kongGood': { en: 'Kong: adds a replacement draw and keeps all four tiles together.', 'zh-TW': '槓：多補一張牌，四張也留在一起。' },
  'hint.claim.kongBad': { en: 'The kong would break up sets you are using elsewhere.', 'zh-TW': '槓了會拆散你別處要用的面子。' },
  ...withConcealedVariant('hint.claim.recommendedReady', 'This claim makes you ready.', '吃碰這張就能聽牌。'),
  ...withConcealedVariant('hint.claim.recommendedCloser', 'This claim brings you closer to ready.', '吃碰這張能讓你更接近聽牌。'),
  ...withConcealedVariant('hint.claim.improvesReady', 'This claim would make you ready, but your concealed hand is worth more here.', '吃碰這張雖然能聽牌，但這裡保持門清更有價值。'),
  ...withConcealedVariant(
    'hint.claim.improvesCloser',
    'This claim would bring you closer to ready, but your concealed hand is worth more here.',
    '吃碰這張雖然能更接近聽牌，但這裡保持門清更有價值。',
  ),
  ...withConcealedVariant('hint.claim.alreadyReady', 'You are already ready; claiming would not help.', '你已經聽牌了，吃碰沒有幫助。'),
  ...withConcealedVariant('hint.claim.noGain', 'This does not reduce your shanten count.', '吃碰這張不會降低你的向聽數。'),
} satisfies Record<string, ReasonTemplate>;

export type HintReasonKey = keyof typeof HINT_REASON_KEYS;

function reason(key: HintReasonKey, params: ReasonParams = {}): Reason {
  return { key, params };
}

function englishOf(r: Reason): string {
  return fillTemplate(HINT_REASON_KEYS[r.key as HintReasonKey].en, r.params);
}

export interface WaitInfo {
  kind: Kind;
  /** Copies not visible to the player. */
  remaining: number;
}

export interface ClaimAdvice {
  action: Action;
  label: string;
  /** Machine-readable form of `label`. */
  labelKey: string;
  labelParams: ReasonParams;
  recommended: boolean;
  reason: string;
  /** Machine-readable form of `reason`. */
  reasonKey: string;
  reasonParams: ReasonParams;
}

export interface Hint {
  seat: number;
  phase: GameState['phase'];
  shanten: number;
  /** Plain-language status, e.g. "Ready (聽牌) — waiting on 3 kinds". */
  status: string;
  /** Machine-readable form of `status`. */
  statusKey: string;
  statusParams: ReasonParams;
  waits: WaitInfo[];
  discards: DiscardAdvice[];
  bestDiscard?: DiscardAdvice;
  discardReason?: string;
  /** Machine-readable form of `discardReason`, present whenever it is. */
  discardReasonKey?: string;
  discardReasonParams?: ReasonParams;
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

/** The three forms of a tile a template may use: code, bilingual name and Chinese name. */
function tileParams(k: Kind | null): ReasonParams {
  if (k === null) return { tile: '', tileName: '', tileZh: '' };
  const i = kindInfo(k);
  return { tile: i.code, tileName: describeKind(k), tileZh: i.nameZh };
}

function setStatus(h: Hint, r: Reason): void {
  h.status = englishOf(r);
  h.statusKey = r.key;
  h.statusParams = r.params;
}

function claimAdvice(action: Action, label: Reason, recommended: boolean, why: Reason): ClaimAdvice {
  return {
    action,
    label: englishOf(label),
    labelKey: label.key,
    labelParams: label.params,
    recommended,
    reason: englishOf(why),
    reasonKey: why.key,
    reasonParams: why.params,
  };
}

export function hintFor(s: GameState, seat: number): Hint {
  const actions = legalActions(s, seat);
  const valueTiles = [...valueKinds(s, seat)];
  const base: Hint = {
    seat,
    phase: s.phase,
    shanten: 0,
    status: '',
    statusKey: '',
    statusParams: {},
    waits: [],
    discards: [],
    claims: [],
    valueTiles,
  };
  if (s.phase === 'ended') {
    setStatus(base, reason('hint.status.handOver'));
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
    base.discards = rankDiscards(s, seat, COACH_SKILL);
    base.bestDiscard = base.discards[0];
    if (canHu) {
      setStatus(base, reason('hint.status.canWinSelfDraw', { how: selfDrawLabel(s), tai: base.winPreview!.tai }));
    } else if (base.bestDiscard) {
      const d = base.bestDiscard;
      const afterWaits = d.shanten === 0 ? waitsAfterDiscard(s, seat, d.tile, unseen) : [];
      base.waits = afterWaits;
      const why = explainDiscard(d, afterWaits, base.discards);
      base.discardReason = englishOf(why);
      base.discardReasonKey = why.key;
      base.discardReasonParams = why.params;
      setStatus(base, statusText(d.shanten));
    }
    const kongs = actions.filter((a) => a.type === 'kong');
    const pick = kongs.length > 0 ? coachAction(s, seat) : null;
    for (const k of kongs) {
      const recommended = pick !== null && sameAction(k, pick, s, seat);
      base.claims.push(claimAdvice(k, reason('hint.label.kongSelf', tileParams(kindOf((k as { tile: TileId }).tile))), recommended, reason('hint.claim.kongSelf')));
    }
    return base;
  }

  if (s.phase === 'claim') {
    const sh = currentShanten(s, seat);
    base.shanten = sh;
    base.waits = waitsFor(s, seat).map((k) => ({ kind: k, remaining: unseen[k] }));
    setStatus(base, sh === 0 ? reason('hint.status.readyCount', { kinds: base.waits.length }) : statusText(sh));
    const botPick = coachAction(s, seat);
    for (const a of actions) {
      if (a.type === 'pass') continue;
      const recommended = botPick !== null && sameAction(a, botPick, s, seat);
      base.claims.push(claimAdvice(a, claimLabel(a, s), recommended, claimReason(a, s, seat, sh, recommended)));
    }
    if (canHu) setStatus(base, reason('hint.status.canWinDiscard', { tai: base.winPreview!.tai }));
    return base;
  }

  base.shanten = currentShanten(s, seat);
  base.waits = waitsFor(s, seat).map((k) => ({ kind: k, remaining: unseen[k] }));
  setStatus(
    base,
    base.shanten === 0
      ? reason('hint.status.readyWaits', { waits: base.waits.map((w) => kindInfo(w.kind).nameZh).join(' '), tiles: codes(base.waits.map((w) => w.kind)) })
      : statusText(base.shanten),
  );
  return base;
}

function codes(kinds: readonly Kind[]): string {
  return kinds.map((k) => kindInfo(k).code).join(' ');
}

function selfDrawLabel(s: GameState): string {
  return s.drawSource === 'kong' ? '槓上開花' : s.drawSource === 'flower' ? '花上自摸' : '自摸';
}

function statusText(sh: number): Reason {
  if (sh <= 0) return reason('hint.status.readyAfterDiscard');
  if (sh === 1) return reason('hint.status.oneAway');
  if (sh === 2) return reason('hint.status.twoAway');
  return reason('hint.status.manyAway', { shanten: sh });
}

function waitsAfterDiscard(s: GameState, seat: number, tile: TileId, unseen: number[]): WaitInfo[] {
  const p = s.players[seat];
  const rest = p.hand.filter((t) => t !== tile).map(kindOf);
  return waits(countsFromKinds(rest), TOTAL_SETS - p.melds.length).map((k) => ({ kind: k, remaining: unseen[k] }));
}

function explainDiscard(d: DiscardAdvice, afterWaits: WaitInfo[], all: readonly DiscardAdvice[]): Reason {
  const tile = tileParams(d.kind);
  // The coach gave up speed for safety: say so rather than calling the tile efficient.
  if (all.some((o) => o.shanten < d.shanten && o.danger > d.danger)) return reason('hint.discard.fold', tile);
  if (d.shanten === 0) {
    if (afterWaits.length === 0) return reason('hint.discard.readyNoWaits', tile);
    const w = afterWaits.map((x) => `${kindInfo(x.kind).nameZh}×${x.remaining}`).join(', ');
    return reason('hint.discard.ready', { ...tile, waits: w, tiles: codes(afterWaits.map((x) => x.kind)) });
  }
  if (d.accepts.length === 0) return reason('hint.discard.isolated', tile);
  const acc = d.accepts.slice(0, 6).map((k) => kindInfo(k).nameZh).join(' ');
  return reason('hint.discard.efficiency', {
    ...tile,
    kinds: d.accepts.length,
    accepts: `${acc}${d.accepts.length > 6 ? '…' : ''}`,
    tiles: codes(d.accepts),
    copies: d.acceptance,
  });
}

function claimLabel(a: Action, s: GameState): Reason {
  const tile = tileParams(s.pending ? kindOf(s.pending.tile) : null);
  switch (a.type) {
    case 'hu':
      return reason('hint.label.hu', tile);
    case 'pong':
      return reason('hint.label.pong', tile);
    case 'kong':
      return reason('hint.label.kong', tile);
    case 'chi': {
      const own = a.tiles.map((t) => kindOf(t));
      return reason('hint.label.chi', { ...tile, handTiles: own.map((k) => kindInfo(k).nameZh).join(''), handCodes: codes(own) });
    }
    default:
      return reason('hint.label.other', { action: a.type });
  }
}

function claimReason(a: Action, s: GameState, seat: number, sh: number, recommended: boolean): Reason {
  const p = s.players[seat];
  const concealed = p.melds.every((m) => m.concealed);
  if (a.type === 'hu') return reason('hint.claim.hu');
  if (a.type === 'kong') return reason(recommended ? 'hint.claim.kongGood' : 'hint.claim.kongBad');
  const after = shantenAfterClaim(s, seat, a);
  const improves = after < sh;
  const readyAfter = after === 0;
  const params: ReasonParams = { shanten: sh, shantenAfter: after };
  // Each reason has a twin that adds the 門清 warning when the hand is still concealed.
  const pick = (k: 'recommendedReady' | 'recommendedCloser' | 'improvesReady' | 'improvesCloser' | 'alreadyReady' | 'noGain'): Reason =>
    reason(`hint.claim.${k}${concealed ? 'Concealed' : ''}`, params);
  if (recommended) return pick(readyAfter ? 'recommendedReady' : 'recommendedCloser');
  if (improves) return pick(readyAfter ? 'improvesReady' : 'improvesCloser');
  if (sh === 0) return pick('alreadyReady');
  return pick('noGain');
}
