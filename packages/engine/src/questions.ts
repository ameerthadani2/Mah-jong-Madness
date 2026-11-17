/**
 * Puzzles as questions: exactly what a view needs before the player answers, and nothing that
 * reveals or ranks the answer. A ranked puzzle (a Puzzle Rush run, the daily puzzle played against
 * the game server) is served as its question; the whole puzzle (the answer, the per-option
 * analysis and the explanation) is revealed only with the verdict on an answer (docs/API.md,
 * "Questions and reveals").
 *
 * Every field of every puzzle theme is classified in `PUZZLE_FIELDS`: shown in the question,
 * withheld until the answer, or (the claim options) shown trimmed to what a button needs. The
 * classification is typed against the puzzle interfaces, so a field added to a puzzle does not
 * compile until it is classified, and test/questions.test.ts checks real puzzles against it.
 */
import type { Kind } from './tiles';
import type { AnyPuzzle, ClaimChoice, ClaimOption, ClaimPuzzle, DefencePuzzle, DiscardPuzzle, PuzzleDifficulty, PuzzleMeld, PuzzleSeatView, PuzzleType, ValuePuzzle, WaitsPuzzle } from './puzzles';

/** What every question carries: its theme, an id for the view (a ranked puzzle's is opaque) and its difficulty. */
interface QuestionBase {
  /** The puzzle's seed, or an opaque id when the server serves it (it never sends a Rush run's seed). */
  seed: string;
  difficulty: PuzzleDifficulty;
}

export interface DiscardQuestion extends QuestionBase {
  type: 'discard';
  /** 17 concealed tiles (kinds), sorted. */
  hand: Kind[];
  /** Shanten of the 17-tile hand, which the view states before the answer ("the right discard leaves you N from ready"). */
  currentShanten: number;
}

export interface WaitsQuestion extends QuestionBase {
  type: 'waits';
  /** 16 concealed tiles, ready to win. */
  hand: Kind[];
  /** The tiles offered to pick from (every kind near the hand, winning or not). */
  candidates: Kind[];
}

export interface DefenceQuestion extends QuestionBase {
  type: 'defence';
  hand: Kind[];
  ownDiscards: Kind[];
  opponents: PuzzleSeatView[];
  /** The opponent with four exposed sets (the table shows it). */
  threatSeat: number;
}

/** A claim the player may make, as its button needs it: no outcome, no value, no verdict. */
export interface ClaimQuestionOption {
  id: string;
  type: ClaimChoice;
  /** For 吃: the two hand kinds used with the discard. */
  kinds?: [Kind, Kind];
}

export interface ClaimQuestion extends QuestionBase {
  type: 'claim';
  hand: Kind[];
  melds: PuzzleMeld[];
  discard: Kind;
  from: number;
  dealerSeat: number;
  prevailingWind: number;
  opponents: PuzzleSeatView[];
  ownDiscards: Kind[];
  /** The legal responses in table order (pass, each 吃 lowest first, 碰, 槓, 胡), whatever order the puzzle holds them in. */
  options: ClaimQuestionOption[];
}

export interface ValueQuestion extends QuestionBase {
  type: 'value';
  hand: Kind[];
  melds: PuzzleMeld[];
  dealerSeat: number;
  prevailingWind: number;
  seatWind: Kind;
}

export type PuzzleQuestion = DiscardQuestion | WaitsQuestion | DefenceQuestion | ClaimQuestion | ValueQuestion;

/** Shown in the question; withheld until the answer; or (claim options) shown trimmed per `CLAIM_OPTION_FIELDS`. */
export type FieldClass = 'shown' | 'withheld' | 'trimmed';

/**
 * Every field of every puzzle theme and what the question does with it. Typed against the puzzle
 * interfaces: a new field must be classified here before the engine compiles.
 */
export const PUZZLE_FIELDS: {
  discard: Record<keyof DiscardPuzzle, FieldClass>;
  waits: Record<keyof WaitsPuzzle, FieldClass>;
  defence: Record<keyof DefencePuzzle, FieldClass>;
  claim: Record<keyof ClaimPuzzle, FieldClass>;
  value: Record<keyof ValuePuzzle, FieldClass>;
} = {
  discard: { type: 'shown', seed: 'shown', hand: 'shown', currentShanten: 'shown', answers: 'withheld', best: 'withheld', bestShanten: 'withheld', bestAcceptance: 'withheld', options: 'withheld', reasonKey: 'withheld', explanation: 'withheld', explanationZh: 'withheld' },
  waits: { type: 'shown', seed: 'shown', hand: 'shown', candidates: 'shown', answers: 'withheld' },
  defence: {
    type: 'shown',
    seed: 'shown',
    difficulty: 'shown',
    hand: 'shown',
    ownDiscards: 'shown',
    opponents: 'shown',
    threatSeat: 'shown',
    threatLevel: 'withheld',
    bestShanten: 'withheld',
    options: 'withheld',
    answers: 'withheld',
    answer: 'withheld',
    efficient: 'withheld',
    reason: 'withheld',
    reasonKey: 'withheld',
    explanation: 'withheld',
    explanationZh: 'withheld',
  },
  claim: {
    type: 'shown',
    seed: 'shown',
    difficulty: 'shown',
    hand: 'shown',
    melds: 'shown',
    discard: 'shown',
    from: 'shown',
    dealerSeat: 'shown',
    prevailingWind: 'shown',
    opponents: 'shown',
    ownDiscards: 'shown',
    shantenBefore: 'withheld',
    options: 'trimmed',
    answer: 'withheld',
    answers: 'withheld',
    reasonKey: 'withheld',
    explanation: 'withheld',
    explanationZh: 'withheld',
  },
  value: {
    type: 'shown',
    seed: 'shown',
    difficulty: 'shown',
    hand: 'shown',
    melds: 'shown',
    dealerSeat: 'shown',
    prevailingWind: 'shown',
    seatWind: 'shown',
    bestShanten: 'withheld',
    options: 'withheld',
    answers: 'withheld',
    answer: 'withheld',
    rival: 'withheld',
    patternKey: 'withheld',
    patternEn: 'withheld',
    patternZh: 'withheld',
    patternTai: 'withheld',
    reasonKey: 'withheld',
    explanation: 'withheld',
    explanationZh: 'withheld',
  },
};

/** The fields of a claim option a question keeps (the button's id, claim and tiles); the rest is the option's outcome. */
export const CLAIM_OPTION_FIELDS: Record<keyof ClaimOption, Exclude<FieldClass, 'trimmed'>> = {
  id: 'shown',
  type: 'shown',
  kinds: 'shown',
  shantenAfter: 'withheld',
  value: 'withheld',
  waits: 'withheld',
  acceptance: 'withheld',
  accepted: 'withheld',
};

/** Fields a question adds that its puzzle may not carry (discard and waits puzzles have no difficulty field). */
export const QUESTION_ONLY_FIELDS: readonly string[] = ['difficulty'];

/** Every field withheld from a question of `type`, and from a claim question's options. */
export function withheldFields(type: PuzzleType): string[] {
  return Object.entries(PUZZLE_FIELDS[type] as Record<string, FieldClass>)
    .filter(([, c]) => c === 'withheld')
    .map(([k]) => k);
}
export const WITHHELD_CLAIM_OPTION_FIELDS: readonly string[] = Object.entries(CLAIM_OPTION_FIELDS)
  .filter(([, c]) => c === 'withheld')
  .map(([k]) => k);

const CLAIM_ORDER: Record<ClaimChoice, number> = { pass: 0, chi: 1, pong: 2, kong: 3, hu: 4 };
const copyMelds = (melds: readonly PuzzleMeld[]): PuzzleMeld[] => melds.map((m) => ({ type: m.type, kinds: [...m.kinds], concealed: m.concealed, ...(m.from !== undefined ? { from: m.from } : {}) }));
const copySeats = (seats: readonly PuzzleSeatView[]): PuzzleSeatView[] => seats.map((s) => ({ seat: s.seat, melds: copyMelds(s.melds), discards: [...s.discards] }));

/** A discard puzzle's question (discard puzzles carry no difficulty: pass the one it was made at). */
export function discardQuestion(p: DiscardPuzzle, difficulty: PuzzleDifficulty): DiscardQuestion {
  return { type: 'discard', seed: p.seed, difficulty, hand: [...p.hand], currentShanten: p.currentShanten };
}

/** A waits puzzle's question (waits puzzles carry no difficulty: pass the one it was made at). */
export function waitsQuestion(p: WaitsPuzzle, difficulty: PuzzleDifficulty): WaitsQuestion {
  return { type: 'waits', seed: p.seed, difficulty, hand: [...p.hand], candidates: [...p.candidates] };
}

export function defenceQuestion(p: DefencePuzzle): DefenceQuestion {
  return { type: 'defence', seed: p.seed, difficulty: p.difficulty, hand: [...p.hand], ownDiscards: [...p.ownDiscards], opponents: copySeats(p.opponents), threatSeat: p.threatSeat };
}

export function claimQuestion(p: ClaimPuzzle): ClaimQuestion {
  const options = p.options
    .map((o): ClaimQuestionOption => ({ id: o.id, type: o.type, ...(o.kinds ? { kinds: [o.kinds[0], o.kinds[1]] as [Kind, Kind] } : {}) }))
    .sort((x, y) => CLAIM_ORDER[x.type] - CLAIM_ORDER[y.type] || (x.kinds?.[0] ?? 0) - (y.kinds?.[0] ?? 0));
  return {
    type: 'claim',
    seed: p.seed,
    difficulty: p.difficulty,
    hand: [...p.hand],
    melds: copyMelds(p.melds),
    discard: p.discard,
    from: p.from,
    dealerSeat: p.dealerSeat,
    prevailingWind: p.prevailingWind,
    opponents: copySeats(p.opponents),
    ownDiscards: [...p.ownDiscards],
    options,
  };
}

export function valueQuestion(p: ValuePuzzle): ValueQuestion {
  return { type: 'value', seed: p.seed, difficulty: p.difficulty, hand: [...p.hand], melds: copyMelds(p.melds), dealerSeat: p.dealerSeat, prevailingWind: p.prevailingWind, seatWind: p.seatWind };
}

/**
 * The question of a puzzle of any theme. `difficulty` is the one it was made at, used for the
 * discard and waits themes, which carry none (the others carry their own).
 */
export function puzzleQuestion(p: AnyPuzzle, difficulty: PuzzleDifficulty): PuzzleQuestion {
  switch (p.type) {
    case 'discard':
      return discardQuestion(p, difficulty);
    case 'waits':
      return waitsQuestion(p, difficulty);
    case 'defence':
      return defenceQuestion(p);
    case 'claim':
      return claimQuestion(p);
    case 'value':
      return valueQuestion(p);
  }
}

/**
 * The withheld fields a served payload carries anywhere a question could hold them (its top level
 * and a claim question's options): empty for a question. For tests and probes of what is served.
 */
export function leakedFields(q: { type: PuzzleType } & Record<string, unknown>): string[] {
  const out = withheldFields(q.type).filter((k) => k in q);
  if (q.type === 'claim' && Array.isArray(q.options)) {
    for (const o of q.options as Array<Record<string, unknown>>) for (const k of WITHHELD_CLAIM_OPTION_FIELDS) if (k in o && !out.includes(`options.${k}`)) out.push(`options.${k}`);
  }
  return out;
}
