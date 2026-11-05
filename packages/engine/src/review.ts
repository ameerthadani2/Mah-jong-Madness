/**
 * Post-hand review ("Game Review"). Replays a hand's action log and grades
 * each decision the reviewed seat made against the coach's recommendation,
 * producing an accuracy score and a list of mistakes with explanations.
 *
 * Like the coach, every sentence also comes as a key into ENGINE_REASON_KEYS
 * plus params, so the app can translate it; the English text is the English
 * template filled with those params.
 */
import { coachAction, COACH_SKILL, currentShanten, rankDiscards, shantenAfterClaim } from './bot';
import { applyAction, dealFromSnapshot, legalActions, sameAction, type Action, type GameState, type LoggedAction, type MatchSnapshot } from './game';
import { fillTemplate, HINT_REASON_KEYS, type Reason, type ReasonLocale, type ReasonParams, type ReasonTemplate } from './hints';
import { type RuleSet } from './rules';
import { kindInfo, kindOf, type Kind, type TileId } from './tiles';

export type MoveGrade = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface ReviewedMove {
  n: number;
  phase: GameState['phase'];
  actual: Action;
  best: Action | null;
  grade: MoveGrade;
  /** Shanten before the decision (3n+2 hand for discards). */
  shantenBefore: number;
  /** Shanten after the actual move vs after the best move (discards only). */
  shantenActual?: number;
  shantenBest?: number;
  acceptanceActual?: number;
  acceptanceBest?: number;
  explanation: string;
  /** Machine-readable form of `explanation`. */
  reasonKey: string;
  reasonParams: ReasonParams;
  /** Hand (concealed tiles) at the moment of the decision, for display. */
  hand: TileId[];
  highlightActual?: Kind;
  highlightBest?: Kind;
}

export interface HandReview {
  seat: number;
  accuracy: number;
  moves: ReviewedMove[];
  counts: Record<MoveGrade, number>;
  summary: string;
  /** Machine-readable form of `summary`. */
  summaryKey: string;
  summaryParams: ReasonParams;
}

/**
 * Review templates. Discard params name tiles by `actual`/`best` (codes) and
 * `actualName`/`bestName` (Chinese tile names, used in both languages).
 * zh-TW templates: first pass, needs native review.
 */
export const REVIEW_REASON_KEYS = {
  'review.summary.none': { en: 'No decisions to review.', 'zh-TW': '沒有可以複盤的決策。' },
  'review.summary.counts': {
    en: '%{accuracy}% accuracy over %{moves} decisions — %{blunders} blunders, %{mistakes} mistakes, %{inaccuracies} inaccuracies.',
    'zh-TW': '%{moves} 個決策，準確率 %{accuracy}%：大失誤 %{blunders} 次、失誤 %{mistakes} 次、欠佳 %{inaccuracies} 次。',
  },

  'review.grade.best': { en: 'Best', 'zh-TW': '最佳' },
  'review.grade.good': { en: 'Good', 'zh-TW': '不錯' },
  'review.grade.inaccuracy': { en: 'Inaccuracy ?!', 'zh-TW': '欠佳 ?!' },
  'review.grade.mistake': { en: 'Mistake ?', 'zh-TW': '失誤 ?' },
  'review.grade.blunder': { en: 'Blunder ??', 'zh-TW': '大失誤 ??' },

  'review.discard.missedWin': { en: 'You had a winning hand and discarded instead of declaring 胡.', 'zh-TW': '你已經可以胡了，卻沒有喊胡，而是打出一張牌。' },
  'review.discard.best': { en: 'Discarding %{actualName} was the most efficient choice.', 'zh-TW': '打 %{actualName} 是效率最高的選擇。' },
  'review.discard.pushed': {
    en: 'An opponent looked ready. %{actualName} kept you closer to ready, but %{bestName} was the safer discard.',
    'zh-TW': '當時有對手看起來已經聽牌。打 %{actualName} 雖然離聽牌更近，但打 %{bestName} 比較安全。',
  },
  'review.discard.lessSafe': {
    en: '%{actualName} keeps the same shanten, but %{bestName} was safer against an opponent who looked ready.',
    'zh-TW': '打 %{actualName} 向聽數一樣，但面對看起來已經聽牌的對手，打 %{bestName} 比較安全。',
  },
  'review.discard.lessAcceptance': {
    en: '%{actualName} keeps the same shanten but accepts %{acceptanceActual} tiles; %{bestName} accepts %{acceptanceBest}.',
    'zh-TW': '打 %{actualName} 向聽數一樣，但只有 %{acceptanceActual} 張進張；打 %{bestName} 有 %{acceptanceBest} 張。',
  },
  'review.discard.worseShanten': {
    en: '%{actualName} leaves you %{shantenActual} from ready; %{bestName} would leave you %{shantenBest}.',
    'zh-TW': '打 %{actualName} 之後是 %{shantenActual} 向聽；打 %{bestName} 則是 %{shantenBest} 向聽。',
  },

  'review.call.missedWin': { en: 'You could have won on this discard.', 'zh-TW': '這張牌你可以胡。' },
  'review.call.tookWin': { en: 'You took the win on the discard.', 'zh-TW': '你胡了這張打出來的牌。' },
  'review.call.passBest': { en: 'Passing kept your hand flexible.', 'zh-TW': '不吃不碰，讓手牌保有彈性。' },
  'review.call.sameCall': { en: 'Calling here moved you closer to ready.', 'zh-TW': '在這裡吃碰，讓你更接近聽牌。' },
  'review.call.otherCallSame': {
    en: 'Calling was right; the coach preferred a different call that leaves the same shape.',
    'zh-TW': '吃碰是對的；教練偏好另一種吃碰法，留下的牌型一樣。',
  },
  'review.call.worseShanten': {
    en: 'Calling was right, but a different call would have left you %{shantenBest} from ready instead of %{shantenActual}.',
    'zh-TW': '吃碰是對的，但換一種吃碰法會是 %{shantenBest} 向聽，而不是 %{shantenActual} 向聽。',
  },
  'review.call.shouldCall': { en: 'Calling would have brought you closer to ready.', 'zh-TW': '吃碰這張能讓你更接近聽牌。' },
  'review.call.closerConcealed': {
    en: 'The call moved you closer to ready, but gave up 門清 when staying concealed was worth more.',
    'zh-TW': '吃碰讓你更接近聽牌，但保持門清更有價值，卻被你放棄了。',
  },
  'review.call.closerExposed': { en: 'The call moved you closer to ready, but exposed your hand for little gain.', 'zh-TW': '吃碰讓你更接近聽牌，但亮牌的收穫不大。' },
  'review.call.noGain': { en: 'This call did not improve your shanten.', 'zh-TW': '這次吃碰沒有降低向聽數。' },
  'review.call.noGainConcealed': { en: 'This call did not improve your shanten and gave up 門清.', 'zh-TW': '這次吃碰沒有降低向聽數，還放棄了門清。' },

  'review.turn.win': { en: 'You took the win.', 'zh-TW': '你胡牌了。' },
  'review.turn.kong': { en: 'Kong for a replacement draw.', 'zh-TW': '開槓補牌。' },
} satisfies Record<string, ReasonTemplate>;

export type ReviewReasonKey = keyof typeof REVIEW_REASON_KEYS;

/**
 * Every key the engine puts in a `…Key` field, with its English and zh-TW
 * templates (i18n-js %{param} syntax). The app registers these as translations
 * (see `engineReasonTranslations`) and renders `t(key, params)`.
 */
export const ENGINE_REASON_KEYS: Readonly<Record<string, ReasonTemplate>> = { ...HINT_REASON_KEYS, ...REVIEW_REASON_KEYS };

/** The translation key for each grade's label. */
export const MOVE_GRADE_KEYS: Record<MoveGrade, ReviewReasonKey> = {
  best: 'review.grade.best',
  good: 'review.grade.good',
  inaccuracy: 'review.grade.inaccuracy',
  mistake: 'review.grade.mistake',
  blunder: 'review.grade.blunder',
};

/** Renders an engine key in a locale; an unknown key comes back as itself. */
export function formatEngineReason(key: string, params: ReasonParams, locale: ReasonLocale = 'en'): string {
  const tpl = ENGINE_REASON_KEYS[key];
  return tpl ? fillTemplate(tpl[locale], params) : key;
}

/**
 * The templates for one locale as the nested object i18n-js expects, e.g.
 * `{ hint: { discard: { ready: '…' } } }`. Register it under its own namespace
 * (`i18n.store({ en: { engine: engineReasonTranslations('en') } })`) and look keys
 * up as `t('engine.' + key, params)` so they cannot collide with the app's own.
 */
export function engineReasonTranslations(locale: ReasonLocale): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, tpl] of Object.entries(ENGINE_REASON_KEYS)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]] = tpl[locale];
  }
  return out;
}

function reason(key: ReviewReasonKey, params: ReasonParams = {}): Reason {
  return { key, params };
}

/** The text and key fields of a move, from its reason. */
function explained(r: Reason): Pick<ReviewedMove, 'explanation' | 'reasonKey' | 'reasonParams'> {
  return { explanation: fillTemplate(REVIEW_REASON_KEYS[r.key as ReviewReasonKey].en, r.params), reasonKey: r.key, reasonParams: r.params };
}

const GRADE_WEIGHT: Record<MoveGrade, number> = { best: 1, good: 0.9, inaccuracy: 0.6, mistake: 0.3, blunder: 0 };

export function reviewHand(snapshot: MatchSnapshot, seed: string, rules: RuleSet, log: LoggedAction[], seat: number): HandReview {
  let s = dealFromSnapshot(snapshot, seed, rules);
  const moves: ReviewedMove[] = [];
  for (const entry of log) {
    if (entry.seat === seat && s.phase !== 'ended') {
      const graded = gradeMove(s, seat, entry.action, entry.n);
      if (graded) moves.push(graded);
    }
    s = applyAction(s, entry.seat, entry.action);
  }
  const counts: Record<MoveGrade, number> = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const m of moves) counts[m.grade]++;
  const accuracy = moves.length ? Math.round((moves.reduce((a, m) => a + GRADE_WEIGHT[m.grade], 0) / moves.length) * 100) : 100;
  const sum =
    moves.length === 0
      ? reason('review.summary.none')
      : reason('review.summary.counts', { accuracy, moves: moves.length, blunders: counts.blunder, mistakes: counts.mistake, inaccuracies: counts.inaccuracy });
  const summary = fillTemplate(REVIEW_REASON_KEYS[sum.key as ReviewReasonKey].en, sum.params);
  return { seat, accuracy, moves, counts, summary, summaryKey: sum.key, summaryParams: sum.params };
}

function gradeMove(s: GameState, seat: number, actual: Action, n: number): ReviewedMove | null {
  const legal = legalActions(s, seat);
  if (legal.length <= 1) return null; // forced
  const hand = s.players[seat].hand.slice();
  const best = coachAction(s, seat);
  const shantenBefore = safeShanten(s, seat);

  if (s.phase === 'discard' && actual.type === 'discard') {
    if (best && best.type === 'hu') {
      const k = kindOf(actual.tile);
      return { n, phase: s.phase, actual, best, grade: 'blunder', shantenBefore, ...explained(reason('review.discard.missedWin', { actual: kindInfo(k).code })), hand, highlightActual: k };
    }
    const ranked = rankDiscards(s, seat, COACH_SKILL);
    const top = ranked[0];
    const mine = ranked.find((r) => r.kind === kindOf(actual.tile));
    if (!top || !mine) return null;
    const dShanten = mine.shanten - top.shanten;
    const accRatio = top.acceptance > 0 ? mine.acceptance / top.acceptance : 1;
    // The coach folded (gave up shanten for a safer tile) and the player pushed a riskier one instead.
    const pushed = dShanten < 0 && mine.danger > top.danger;
    let grade: MoveGrade;
    if (mine.kind === top.kind || (dShanten === 0 && accRatio >= 0.95 && mine.danger <= top.danger)) grade = 'best';
    else if (pushed) grade = 'inaccuracy';
    else if (dShanten <= 0 && accRatio >= 0.7) grade = 'good';
    else if (dShanten <= 0) grade = 'inaccuracy';
    else if (dShanten === 1) grade = 'mistake';
    else grade = 'blunder';
    const params: ReasonParams = {
      actual: kindInfo(mine.kind).code,
      best: kindInfo(top.kind).code,
      actualName: kindInfo(mine.kind).nameZh,
      bestName: kindInfo(top.kind).nameZh,
      shantenActual: mine.shanten,
      shantenBest: top.shanten,
      acceptanceActual: mine.acceptance,
      acceptanceBest: top.acceptance,
    };
    let key: ReviewReasonKey;
    if (grade === 'best') key = 'review.discard.best';
    else if (pushed) key = 'review.discard.pushed';
    else if (dShanten === 0 && mine.danger > top.danger) key = 'review.discard.lessSafe';
    else if (dShanten <= 0) key = 'review.discard.lessAcceptance';
    else key = 'review.discard.worseShanten';
    return {
      n,
      phase: s.phase,
      actual,
      best: { type: 'discard', tile: top.tile },
      grade,
      shantenBefore,
      shantenActual: mine.shanten,
      shantenBest: top.shanten,
      acceptanceActual: mine.acceptance,
      acceptanceBest: top.acceptance,
      ...explained(reason(key, params)),
      hand,
      highlightActual: mine.kind,
      highlightBest: top.kind,
    };
  }

  if (s.phase === 'claim') {
    const bestIsPass = !best || best.type === 'pass';
    const actualIsPass = actual.type === 'pass';
    const tile = s.pending ? kindInfo(kindOf(s.pending.tile)).code : '';
    const move = (grade: MoveGrade, key: ReviewReasonKey, moveBest: Action | null, params: ReasonParams = {}): ReviewedMove => ({
      n,
      phase: s.phase,
      actual,
      best: moveBest,
      grade,
      shantenBefore,
      ...explained(reason(key, { tile, ...params })),
      hand,
    });
    if (legal.some((a) => a.type === 'hu') && actual.type !== 'hu') return move('blunder', 'review.call.missedWin', { type: 'hu' });
    if (actual.type === 'hu') return move('best', 'review.call.tookWin', best);
    if (actualIsPass && bestIsPass) return move('best', 'review.call.passBest', best);
    if (!actualIsPass && !bestIsPass) {
      // Both called: the same call is best; a different call is judged by where it leaves the hand.
      if (sameAction(best!, actual, s, seat)) return move('best', 'review.call.sameCall', best);
      const mineAfter = shantenAfterClaim(s, seat, actual);
      const bestAfter = shantenAfterClaim(s, seat, best!);
      if (mineAfter <= bestAfter) return move('good', 'review.call.otherCallSame', best, { shantenActual: mineAfter, shantenBest: bestAfter });
      return move('inaccuracy', 'review.call.worseShanten', best, { shantenActual: mineAfter, shantenBest: bestAfter });
    }
    const concealed = s.players[seat].melds.every((m) => m.concealed);
    if (actualIsPass) return move('inaccuracy', 'review.call.shouldCall', best);
    // The player called where the coach would pass. Did the call at least improve the hand?
    const after = shantenAfterClaim(s, seat, actual);
    if (after < shantenBefore) return move('inaccuracy', concealed ? 'review.call.closerConcealed' : 'review.call.closerExposed', best, { shantenBefore, shantenAfter: after });
    return move('mistake', concealed ? 'review.call.noGainConcealed' : 'review.call.noGain', best, { shantenBefore, shantenAfter: after });
  }

  if (actual.type === 'kong' || actual.type === 'hu') {
    return { n, phase: s.phase, actual, best, grade: 'best', shantenBefore, ...explained(reason(actual.type === 'hu' ? 'review.turn.win' : 'review.turn.kong')), hand };
  }
  return null;
}

function safeShanten(s: GameState, seat: number): number {
  try {
    return currentShanten(s, seat);
  } catch {
    return 0;
  }
}
