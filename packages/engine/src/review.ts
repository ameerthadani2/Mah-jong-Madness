/**
 * Post-hand review ("Game Review"). Replays a hand's action log and grades
 * each decision the reviewed seat made against the coach's recommendation,
 * producing an accuracy score and a list of mistakes with explanations.
 */
import { chooseAction, currentShanten, rankDiscards } from './bot';
import { applyAction, dealFromSnapshot, legalActions, type Action, type GameState, type LoggedAction, type MatchSnapshot } from './game';
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
  const summary = moves.length === 0 ? 'No decisions to review.' : `${accuracy}% accuracy over ${moves.length} decisions — ${counts.blunder} blunders, ${counts.mistake} mistakes, ${counts.inaccuracy} inaccuracies.`;
  return { seat, accuracy, moves, counts, summary };
}

function gradeMove(s: GameState, seat: number, actual: Action, n: number): ReviewedMove | null {
  const legal = legalActions(s, seat);
  if (legal.length <= 1) return null; // forced
  const hand = s.players[seat].hand.slice();
  const best = chooseAction(s, seat, { skill: 'pro', seed: 'review' });
  const shantenBefore = safeShanten(s, seat);

  if (s.phase === 'discard' && actual.type === 'discard') {
    if (best && best.type === 'hu') {
      return { n, phase: s.phase, actual, best, grade: 'blunder', shantenBefore, explanation: 'You had a winning hand and discarded instead of declaring 胡.', hand, highlightActual: kindOf(actual.tile) };
    }
    const ranked = rankDiscards(s, seat, 'pro');
    const top = ranked[0];
    const mine = ranked.find((r) => r.kind === kindOf(actual.tile));
    if (!top || !mine) return null;
    const dShanten = mine.shanten - top.shanten;
    const accRatio = top.acceptance > 0 ? mine.acceptance / top.acceptance : 1;
    let grade: MoveGrade;
    if (mine.kind === top.kind || (dShanten === 0 && accRatio >= 0.95)) grade = 'best';
    else if (dShanten === 0 && accRatio >= 0.7) grade = 'good';
    else if (dShanten === 0) grade = 'inaccuracy';
    else if (dShanten === 1) grade = 'mistake';
    else grade = 'blunder';
    const bestName = kindInfo(top.kind).nameZh;
    const mineName = kindInfo(mine.kind).nameZh;
    let explanation: string;
    if (grade === 'best') explanation = `Discarding ${mineName} was the most efficient choice.`;
    else if (dShanten === 0) explanation = `${mineName} keeps the same shanten but accepts ${mine.acceptance} tiles; ${bestName} accepts ${top.acceptance}.`;
    else explanation = `${mineName} leaves you ${mine.shanten} from ready; ${bestName} would leave you ${top.shanten}.`;
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
      explanation,
      hand,
      highlightActual: mine.kind,
      highlightBest: top.kind,
    };
  }

  if (s.phase === 'claim') {
    const bestIsPass = !best || best.type === 'pass';
    const actualIsPass = actual.type === 'pass';
    if (legal.some((a) => a.type === 'hu') && actual.type !== 'hu') {
      return { n, phase: s.phase, actual, best: { type: 'hu' }, grade: 'blunder', shantenBefore, explanation: 'You could have won on this discard.', hand };
    }
    if (actualIsPass === bestIsPass || actual.type === 'hu') {
      return { n, phase: s.phase, actual, best, grade: 'best', shantenBefore, explanation: actualIsPass ? 'Passing kept your hand flexible.' : 'Calling here moved you closer to ready.', hand };
    }
    const concealed = s.players[seat].melds.every((m) => m.concealed);
    const explanation = actualIsPass
      ? 'Calling would have brought you closer to ready.'
      : `This call did not improve your shanten${concealed ? ' and gave up 門清' : ''}.`;
    return { n, phase: s.phase, actual, best, grade: actualIsPass ? 'inaccuracy' : 'mistake', shantenBefore, explanation, hand };
  }

  if (actual.type === 'kong' || actual.type === 'hu') {
    return { n, phase: s.phase, actual, best, grade: 'best', shantenBefore, explanation: actual.type === 'hu' ? 'You took the win.' : 'Kong for a replacement draw.', hand };
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
