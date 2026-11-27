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
import { coachAction, COACH_SKILL, currentShanten, followsLigu, honourTai, rankDiscards, shantenAfterClaim, unseenCounts, valueKinds, type DiscardAdvice } from './bot';
import { countsFromKinds, TOTAL_SETS, waits } from './hand';
import { type Action, type GameState, legalActions, buildWinContext, sameAction, waitsFor } from './game';
import { playsLigu } from './rules';
import { scoreWin, type ScoreResult } from './scoring';
import { kindInfo, kindOf, SUIT_EN, SUIT_ZH, type Kind, type Suit, type TileId } from './tiles';

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
const LOSES_CONCEALED_ZH = '%{claimZh}了就沒有門清（1 台，門清自摸則是 3 台）。';

/** A claim reason and its "you would lose 門清" form, as two keys (i18n-js templates have no conditionals). */
function withConcealedVariant<K extends string>(key: K, en: string, zh: string): Record<K | `${K}Concealed`, ReasonTemplate> {
  return {
    [key]: { en, 'zh-TW': zh },
    [`${key}Concealed`]: { en: en + LOSES_CONCEALED_EN, 'zh-TW': zh + LOSES_CONCEALED_ZH },
  } as Record<K | `${K}Concealed`, ReasonTemplate>;
}

const MORE_TILES_EN = ' Throwing %{otherName} instead would keep more tiles that improve your hand (%{more} more).';
const MORE_TILES_ZH = '打 %{otherZh} 會多 %{more} 張進張。';
const MORE_WAITS_EN = ' Throwing %{otherName} instead would leave you more winning tiles (%{more} more).';
const MORE_WAITS_ZH = '打 %{otherZh} 會多聽 %{more} 張。';

/** A trade reason ending with the improving tiles given up, and its `Ready` form ending with the winning tiles given up. */
function withReadyVariant<K extends string>(key: K, en: string, zh: string): Record<K | `${K}Ready`, ReasonTemplate> {
  return {
    [key]: { en: en + MORE_TILES_EN, 'zh-TW': zh + MORE_TILES_ZH },
    [`${key}Ready`]: { en: en + MORE_WAITS_EN, 'zh-TW': zh + MORE_WAITS_ZH },
  } as Record<K | `${K}Ready`, ReasonTemplate>;
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
  'hint.status.oneAway': { en: 'One tile from ready.', 'zh-TW': '差一張就聽牌了。' },
  'hint.status.twoAway': { en: 'Two tiles from ready.', 'zh-TW': '還差兩張才聽牌。' },
  'hint.status.manyAway': { en: '%{shanten} tiles from ready — build sets, keep pairs.', 'zh-TW': '還差 %{shanten} 張才聽牌：先湊成順子或刻子，對子留著。' },
  // At a table that plays 嚦咕嚦咕, while seven pairs and a triplet is nearer than five sets and a pair.
  'hint.status.oneAwayLigu': { en: 'One tile from ready for 嚦咕嚦咕 (seven pairs and a triplet).', 'zh-TW': '差一張就聽嚦咕嚦咕（七對加一刻）了。' },
  'hint.status.twoAwayLigu': { en: 'Two tiles from ready for 嚦咕嚦咕 (seven pairs and a triplet).', 'zh-TW': '還差兩張才聽嚦咕嚦咕（七對加一刻）。' },
  'hint.status.manyAwayLigu': {
    en: '%{shanten} tiles from ready for 嚦咕嚦咕 (seven pairs and a triplet) — keep your pairs.',
    'zh-TW': '還差 %{shanten} 張才聽嚦咕嚦咕（七對加一刻）：對子留著。',
  },
  'hint.status.readyCount': { en: 'Ready — waiting on %{kinds} kind(s).', 'zh-TW': '聽牌：聽 %{kinds} 種牌。' },
  'hint.status.readyWaits': { en: 'Ready (聽牌) — waiting on %{waits}', 'zh-TW': '聽牌：聽 %{waitsZh}' },

  'hint.discard.fold': {
    en: 'An opponent looks ready. Discard %{tileName}, a safer tile, rather than pushing a dangerous one: losing this hand costs less than paying for theirs.',
    'zh-TW': '有對手看起來已經聽牌。打 %{tileZh} 這張較安全的牌，不要硬打危險牌：放棄這手牌，比付對方的台便宜。',
  },
  'hint.discard.ready': { en: 'Discard %{tileName} to be ready, waiting on %{waits}.', 'zh-TW': '打 %{tileZh} 就聽牌，聽 %{waitsZh}。' },
  'hint.discard.readyNoWaits': { en: 'Discard %{tileName} to be ready, waiting on nothing visible.', 'zh-TW': '打 %{tileZh} 就聽牌，但看不到還能聽的牌。' },
  'hint.discard.isolated': { en: 'Discard %{tileName}; it does not fit any set you are building.', 'zh-TW': '打 %{tileZh}：它跟你正在湊的牌都搭不上。' },
  'hint.discard.efficiency': {
    en: 'Discard %{tileName}. %{kinds} kinds (%{accepts}) then improve your hand — %{copies} copies still unseen.',
    'zh-TW': '打 %{tileZh}。之後有 %{kinds} 種牌（%{accepts}）能改善手牌，還有 %{copies} 張沒出現。',
  },

  // The coach's tile keeps fewer improving tiles than the most efficient one, `otherName`, which keeps `more` more:
  // it says what it traded them for (`tradeReason`). The Ready forms count winning tiles, for a discard that leaves the hand ready.
  ...withReadyVariant(
    'hint.discard.flush',
    'Discard %{tileName}: you are going for a flush in %{suit}.',
    '打 %{tileZh}：你在做%{suitZh}的清一色或混一色。',
  ),
  ...withReadyVariant(
    'hint.discard.keepValue',
    'Discard %{tileName} and keep your pair of %{otherName}: a pong of it is worth %{tai} 台.',
    '打 %{tileZh}，留著 %{otherZh} 這一對：碰成刻子有 %{tai} 台。',
  ),
  ...withReadyVariant(
    'hint.discard.safer',
    'Discard %{tileName}: an opponent may be close to ready, and it is the safer tile.',
    '打 %{tileZh}：有對手可能快聽牌了，這張比較安全。',
  ),

  'hint.discard.efficiencyLigu': {
    en: 'Discard %{tileName}: 嚦咕嚦咕 (seven pairs and a triplet) is your nearest hand. %{kinds} kinds (%{accepts}) then bring it closer — %{copies} copies still unseen.',
    'zh-TW': '打 %{tileZh}：嚦咕嚦咕（七對加一刻）是你最接近的牌型。之後有 %{kinds} 種牌（%{accepts}）能讓它更接近聽牌，還有 %{copies} 張沒出現。',
  },
  'hint.label.kongSelf': { en: 'Kong %{tileName}', 'zh-TW': '槓 %{tileZh}' },
  'hint.label.hu': { en: 'Win (胡) on %{tileName}', 'zh-TW': '胡 %{tileZh}' },
  'hint.label.pong': { en: 'Pong (碰) %{tileName}', 'zh-TW': '碰 %{tileZh}' },
  'hint.label.kong': { en: 'Kong (槓) %{tileName}', 'zh-TW': '槓 %{tileZh}' },
  'hint.label.chi': { en: 'Chi (吃) %{handTiles} + %{tileName}', 'zh-TW': '吃 %{handTiles} + %{tileZh}' },
  'hint.label.other': { en: '%{action}', 'zh-TW': '%{action}' },

  'hint.claim.kongSelf': {
    en: 'A kong draws a replacement tile and can add 槓上開花 (1 台) if you win on it. Skip it if the four tiles are part of two sets.',
    'zh-TW': '開槓可以補一張牌，補到胡牌還能加槓上開花（1 台）。如果這四張分在兩組裡，就別槓。',
  },
  'hint.claim.hu': { en: 'Take the win. Compare with your waits only if you are chasing a much bigger hand.', 'zh-TW': '胡下去吧。只有在做更大的牌時，才需要跟你聽的牌比較。' },
  'hint.claim.kongGood': { en: 'Kong: adds a replacement draw and keeps all four tiles together.', 'zh-TW': '槓：多補一張牌，四張也留在一起。' },
  'hint.claim.kongBad': { en: 'The kong would break up sets you are using elsewhere.', 'zh-TW': '槓了會拆掉你別處要用的順子或刻子。' },
  'hint.claim.kongBreaksConcealed': { en: 'An exposed kong would cost you 門清 on a hand that is already ready.', 'zh-TW': '已經聽牌了，明槓會失去門清。' },
  'hint.claim.takeWin': { en: 'Take the win instead.', 'zh-TW': '直接胡牌就好。' },
  'hint.claim.coachPrefers': { en: 'The coach prefers %{label}, which leaves the hand in the same shape.', 'zh-TW': '教練會選%{label}，牌型一樣好。' },
  ...withConcealedVariant('hint.claim.recommendedReady', 'This %{claimName} makes you ready.', '%{claimZh}這張就能聽牌。'),
  ...withConcealedVariant('hint.claim.recommendedCloser', 'This %{claimName} brings you closer to ready.', '%{claimZh}這張能讓你更接近聽牌。'),
  ...withConcealedVariant('hint.claim.improvesReady', 'This %{claimName} would make you ready, but your concealed hand is worth more here.', '%{claimZh}這張雖然能聽牌，但這裡保持門清更有價值。'),
  ...withConcealedVariant(
    'hint.claim.improvesCloser',
    'This %{claimName} would bring you closer to ready, but your concealed hand is worth more here.',
    '%{claimZh}這張雖然能更接近聽牌，但這裡保持門清更有價值。',
  ),
  ...withConcealedVariant('hint.claim.alreadyReady', 'You are already ready; a %{claimName} would not help.', '你已經聽牌了，%{claimZh}也沒有幫助。'),
  ...withConcealedVariant('hint.claim.noGain', 'This %{claimName} does not bring you closer to ready.', '%{claimZh}這張也不會更接近聽牌。'),
} satisfies Record<string, ReasonTemplate>;

export type HintReasonKey = keyof typeof HINT_REASON_KEYS;

function reason(key: HintReasonKey, params: ReasonParams = {}): Reason {
  return { key, params };
}

function englishOf(r: Reason): string {
  return fillTemplate(HINT_REASON_KEYS[r.key as HintReasonKey].en, r.params);
}

function chineseOf(r: Reason): string {
  return fillTemplate(HINT_REASON_KEYS[r.key as HintReasonKey]['zh-TW'], r.params);
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
    const ligu = playsLigu(s.rules);
    base.bestDiscard = base.discards[0];
    if (canHu) {
      setStatus(base, reason('hint.status.canWinSelfDraw', { how: selfDrawLabel(s), tai: base.winPreview!.tai }));
    } else if (base.bestDiscard) {
      const d = base.bestDiscard;
      // At a 嚦咕嚦咕 table the discard can leave the hand ready for seven pairs and a triplet too.
      const afterWaits = d.shanten === 0 || ligu ? waitsAfterDiscard(s, seat, d.tile, unseen) : [];
      base.waits = afterWaits;
      const why = explainDiscard(d, afterWaits, base.discards, s, seat);
      base.discardReason = englishOf(why);
      base.discardReasonKey = why.key;
      base.discardReasonParams = why.params;
      setStatus(base, statusText(afterWaits.length > 0 ? 0 : d.shanten, d.ligu === true));
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
    base.waits = waitsFor(s, seat).map((k) => ({ kind: k, remaining: unseen[k] }));
    const sh = readyShanten(currentShanten(s, seat), base.waits);
    base.shanten = sh;
    setStatus(base, sh === 0 ? reason('hint.status.readyCount', { kinds: base.waits.length }) : statusText(sh, followsLigu(s, seat)));
    const botPick = coachAction(s, seat);
    for (const a of actions) {
      if (a.type === 'pass') continue;
      const recommended = botPick !== null && sameAction(a, botPick, s, seat);
      base.claims.push(claimAdvice(a, claimLabel(a, s), recommended, claimReason(a, s, seat, sh, recommended, botPick)));
    }
    if (canHu) setStatus(base, reason('hint.status.canWinDiscard', { tai: base.winPreview!.tai }));
    return base;
  }

  base.waits = waitsFor(s, seat).map((k) => ({ kind: k, remaining: unseen[k] }));
  base.shanten = readyShanten(currentShanten(s, seat), base.waits);
  setStatus(
    base,
    base.shanten === 0
      ? reason('hint.status.readyWaits', { waits: base.waits.map((w) => kindInfo(w.kind).nameZh).join(' '), waitsZh: base.waits.map((w) => kindInfo(w.kind).nameZh).join('、'), tiles: codes(base.waits.map((w) => w.kind)) })
      : statusText(base.shanten, followsLigu(s, seat)),
  );
  return base;
}

function codes(kinds: readonly Kind[]): string {
  return kinds.map((k) => kindInfo(k).code).join(' ');
}

function selfDrawLabel(s: GameState): string {
  return s.drawSource === 'kong' ? '槓上開花' : s.drawSource === 'flower' ? '花上自摸' : '自摸';
}

/** "N tiles from ready"; `ligu` names 嚦咕嚦咕 as the hand it counts towards (the nearer path at a table that plays it). */
function statusText(sh: number, ligu = false): Reason {
  if (sh <= 0) return reason('hint.status.readyAfterDiscard');
  const tail = ligu ? 'Ligu' : '';
  if (sh === 1) return reason(`hint.status.oneAway${tail}`);
  if (sh === 2) return reason(`hint.status.twoAway${tail}`);
  return reason(`hint.status.manyAway${tail}`, { shanten: sh });
}

function waitsAfterDiscard(s: GameState, seat: number, tile: TileId, unseen: number[]): WaitInfo[] {
  const p = s.players[seat];
  const rest = p.hand.filter((t) => t !== tile).map(kindOf);
  return waits(countsFromKinds(rest), TOTAL_SETS - p.melds.length, undefined, playsLigu(s.rules)).map((k) => ({ kind: k, remaining: unseen[k] }));
}

/**
 * A hand with waits is ready. `currentShanten` already counts 嚦咕嚦咕 for a hand with no melds at a
 * table that plays it; this keeps any hand with waits at 0 whatever the distance says.
 */
function readyShanten(sh: number, handWaits: readonly WaitInfo[]): number {
  return handWaits.length > 0 && sh > 0 ? 0 : sh;
}

/**
 * The reasons that call the coach's discard the efficient one. It gives them only for a tile the discard
 * puzzles would accept (`efficientDiscard`); for any other tile it names what the coach traded for.
 */
export const EFFICIENCY_REASON_KEYS: readonly HintReasonKey[] = ['hint.discard.ready', 'hint.discard.readyNoWaits', 'hint.discard.isolated', 'hint.discard.efficiency', 'hint.discard.efficiencyLigu'];

const distance = (o: DiscardAdvice): number => o.rank ?? o.shanten;

/**
 * The discard puzzles' judge (`analysedPuzzle` in puzzlediscard.ts) on the coach's own counts: the fewest steps
 * from ready, and within 10 percent of the most improving tiles at that distance.
 */
function efficientDiscard(d: DiscardAdvice, all: readonly DiscardAdvice[]): boolean {
  const best = Math.min(...all.map(distance));
  if (distance(d) !== best) return false;
  const top = Math.max(...all.filter((o) => distance(o) === best).map((o) => o.acceptance));
  return d.acceptance >= top * 0.9;
}

/** Why the coach threw `d` rather than `e`, the most efficient tile: the part of the score that outweighs the improving tiles given up. */
function tradeReason(d: DiscardAdvice, e: DiscardAdvice, s: GameState, seat: number): Reason {
  const params: ReasonParams = { ...tileParams(d.kind), otherName: describeKind(e.kind), otherZh: kindInfo(e.kind).nameZh, other: kindInfo(e.kind).code, more: e.acceptance - d.acceptance };
  const edges: Array<[HintReasonKey, number]> = [
    ['hint.discard.flush', d.flush - e.flush],
    ['hint.discard.keepValue', d.valuePairs - e.valuePairs],
    ['hint.discard.safer', e.safety - d.safety],
  ];
  const [key] = edges.reduce((a, b) => (b[1] > a[1] ? b : a));
  // Both discards leave the hand ready (the fewest steps is 0): the tiles given up are winning tiles.
  const form = (k: HintReasonKey): HintReasonKey => (d.shanten === 0 ? (`${k}Ready` as HintReasonKey) : k);
  if (key === 'hint.discard.flush') {
    const suit = (['m', 'p', 's'] as Suit[])[d.flushSuit ?? 0];
    return reason(form(key), { ...params, suit: SUIT_EN[suit], suitZh: `${SUIT_ZH[suit]}子` });
  }
  if (key === 'hint.discard.keepValue') return reason(form(key), { ...params, tai: honourTai(s, seat, e.kind) });
  return reason(form(key), params);
}

function explainDiscard(d: DiscardAdvice, afterWaits: WaitInfo[], all: readonly DiscardAdvice[], s: GameState, seat: number): Reason {
  const tile = tileParams(d.kind);
  const best = Math.min(...all.map(distance));
  // The coach gave up a step for safety (only the fold weighs more than a step): say so rather than calling the tile efficient.
  if (distance(d) > best) return reason('hint.discard.fold', tile);
  if (!efficientDiscard(d, all)) {
    const e = all.filter((o) => distance(o) === best).reduce((a, b) => (b.acceptance > a.acceptance ? b : a));
    return tradeReason(d, e, s, seat);
  }
  if (d.shanten === 0) {
    if (afterWaits.length === 0) return reason('hint.discard.readyNoWaits', tile);
    // Each winning tile with its live count; Chinese lists them with 、, English with commas.
    const w = afterWaits.map((x) => `${kindInfo(x.kind).nameZh}×${x.remaining}`);
    return reason('hint.discard.ready', { ...tile, waits: w.join(', '), waitsZh: w.join('、'), tiles: codes(afterWaits.map((x) => x.kind)) });
  }
  if (d.accepts.length === 0) return reason('hint.discard.isolated', tile);
  const acc = d.accepts.slice(0, 6).map((k) => kindInfo(k).nameZh).join(' ');
  return reason(d.ligu ? 'hint.discard.efficiencyLigu' : 'hint.discard.efficiency', {
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

/** A claim's name in a reason: the English word and the Chinese verb, so a line names the claim on offer (吃 or 碰), never 吃碰. */
export function claimNames(type: Action['type']): { claimName: string; claimZh: string } {
  if (type === 'chi') return { claimName: 'chow', claimZh: '吃' };
  if (type === 'kong') return { claimName: 'kong', claimZh: '槓' };
  return { claimName: 'pong', claimZh: '碰' };
}

function claimReason(a: Action, s: GameState, seat: number, sh: number, recommended: boolean, coachPick: Action | null): Reason {
  const p = s.players[seat];
  const concealed = p.melds.every((m) => m.concealed);
  if (a.type === 'hu') return reason('hint.claim.hu');
  // The coach's own choice explains a rejected claim better than a generic line.
  if (!recommended && coachPick?.type === 'hu') return reason('hint.claim.takeWin');
  if (a.type === 'kong') {
    if (recommended) return reason('hint.claim.kongGood');
    if (concealed && sh === 0) return reason('hint.claim.kongBreaksConcealed');
    return reason('hint.claim.kongBad');
  }
  const after = shantenAfterClaim(s, seat, a);
  const improves = after < sh;
  const readyAfter = after === 0;
  const params: ReasonParams = { shanten: sh, shantenAfter: after, ...claimNames(a.type) };
  if (!recommended && coachPick && coachPick.type !== 'pass' && improves) {
    const other = claimLabel(coachPick, s);
    // The label is the Chinese claim text (碰 五筒 …), which the English UI already uses on its claim buttons.
    return reason('hint.claim.coachPrefers', { ...params, label: chineseOf(other) });
  }
  // Each reason has a twin that adds the 門清 warning when the hand is still concealed.
  const pick = (k: 'recommendedReady' | 'recommendedCloser' | 'improvesReady' | 'improvesCloser' | 'alreadyReady' | 'noGain'): Reason =>
    reason(`hint.claim.${k}${concealed ? 'Concealed' : ''}`, params);
  if (recommended) return pick(readyAfter ? 'recommendedReady' : 'recommendedCloser');
  if (improves) return pick(readyAfter ? 'improvesReady' : 'improvesCloser');
  if (sh === 0) return pick('alreadyReady');
  return pick('noGain');
}
