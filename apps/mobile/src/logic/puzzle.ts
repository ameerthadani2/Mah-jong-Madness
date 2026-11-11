/**
 * Renderer-free puzzle logic for the app: which checker answers which theme, the claim
 * buttons, seat names, explanations and difficulty. Everything returns translation keys
 * (plus parameters) or data, never English text, so components only call t().
 */
import {
  checkClaimAnswer,
  checkDefenceAnswer,
  checkDiscardAnswer,
  checkValueAnswer,
  checkWaitsAnswer,
  kindInfo,
  type AnyPuzzle,
  type ClaimChoice,
  type ClaimOption,
  type ClaimPuzzle,
  type DefencePuzzle,
  type Kind,
  type PuzzleDifficulty,
  type PuzzleMeld,
  type PuzzleType,
  type TaiItem,
  type ValuePuzzle,
} from '@mjm/engine';

/** A translation key and its parameters. */
export interface TextKey {
  key: string;
  params?: Record<string, string | number>;
}

/** What a puzzle view reports once the player has answered. */
export interface PuzzleResult {
  correct: boolean;
  /** Milliseconds from mount to answer. */
  ms: number;
  type: PuzzleType;
  /** The puzzle's own difficulty when it carries one (defence, claim and value do). */
  difficulty?: PuzzleDifficulty;
}

/**
 * Status line for a best-discard puzzle. `shanten17` is the shanten of the 17-tile
 * hand before discarding: 0 means the right discard leaves the hand ready (聽),
 * −1 means the hand is already complete.
 */
export function puzzleStatus(shanten17: number): TextKey {
  if (shanten17 < 0) return { key: 'puzzles.view.status.complete' };
  if (shanten17 === 0) return { key: 'puzzles.view.status.oneFromReady' };
  return { key: 'puzzles.view.status.leaves', params: { n: shanten17 } };
}

/** The label of each theme (Puzzle Rush shows it above every puzzle). */
export const PUZZLE_TYPE_KEYS: Record<PuzzleType, string> = {
  discard: 'puzzles.types.discard',
  waits: 'puzzles.types.waits',
  defence: 'puzzles.types.defence',
  claim: 'puzzles.types.claim',
  value: 'puzzles.types.value',
};

/** An answer in the shape its theme takes: a tile, a set of tiles (waits) or a claim option / id. */
export type PuzzleAnswer = Kind | readonly Kind[] | ClaimOption | string;

/** Checks an answer with the theme's own engine checker; an answer of the wrong shape is wrong. */
export function checkPuzzleAnswer(p: AnyPuzzle, answer: PuzzleAnswer): boolean {
  switch (p.type) {
    case 'discard':
      return typeof answer === 'number' && checkDiscardAnswer(p, answer);
    case 'waits':
      return Array.isArray(answer) && checkWaitsAnswer(p, [...answer]);
    case 'defence':
      return typeof answer === 'number' && checkDefenceAnswer(p, answer);
    case 'claim':
      return (typeof answer === 'string' || (typeof answer === 'object' && !Array.isArray(answer) && answer !== null)) && checkClaimAnswer(p, answer as ClaimOption | string);
    case 'value':
      return typeof answer === 'number' && checkValueAnswer(p, answer);
  }
}

/** The puzzle's difficulty: its own field when it has one, else `fallback` (discard and waits puzzles carry none). */
export function puzzleDifficultyOf(p: AnyPuzzle, fallback: PuzzleDifficulty): PuzzleDifficulty {
  return 'difficulty' in p ? p.difficulty : fallback;
}

/** The daily puzzle's difficulty for a (UTC) date, as `dailyPuzzle` picks it: weekends 3, even weekdays 2, odd 1. */
export function dailyDifficulty(date: Date): PuzzleDifficulty {
  const day = date.getUTCDay();
  return day === 0 || day === 6 ? 3 : day % 2 === 0 ? 2 : 1;
}

/** Where a seat sits from yours (seat 0): 1 is on your right (下家), 2 opposite (對家), 3 on your left (上家). */
export type SeatRelation = 'right' | 'opposite' | 'left';

export function seatRelation(seat: number): SeatRelation {
  const s = ((seat % 4) + 4) % 4;
  if (s === 1) return 'right';
  if (s === 2) return 'opposite';
  if (s === 3) return 'left';
  throw new Error('seatRelation: seat 0 is you');
}

export const SEAT_KEYS: Record<SeatRelation, string> = {
  left: 'puzzles.seat.left',
  opposite: 'puzzles.seat.opposite',
  right: 'puzzles.seat.right',
};

/** A tile's name in the app's language (Chinese names in zh-TW, English ones otherwise). */
export function tileName(kind: Kind, locale: string): string {
  const info = kindInfo(kind);
  return locale === 'zh-TW' ? info.nameZh : info.nameEn;
}

/** The engine writes each explanation in English and Taiwanese Mandarin; pick the app's language. */
export function explanationFor(p: { explanation: string; explanationZh: string }, locale: string): string {
  return locale === 'zh-TW' ? p.explanationZh : p.explanation;
}

/** A short headline for each engine reason key (the explanation itself comes from the engine). */
const REASON_KEYS: Record<string, string> = {
  'puzzle.defence.theirDiscard': 'puzzles.reason.defenceTheirDiscard',
  'puzzle.defence.deadHonour': 'puzzles.reason.defenceDeadHonour',
  'puzzle.defence.lastHonour': 'puzzles.reason.defenceLastHonour',
  'puzzle.defence.honour': 'puzzles.reason.defenceHonour',
  'puzzle.defence.terminal': 'puzzles.reason.defenceTerminal',
  'puzzle.defence.passed': 'puzzles.reason.defencePassed',
  'puzzle.defence.fewCopies': 'puzzles.reason.defenceFewCopies',
  'puzzle.defence.middle': 'puzzles.reason.defenceMiddle',
  'puzzle.claim.hu': 'puzzles.reason.claimHu',
  'puzzle.claim.passReady': 'puzzles.reason.claimPassReady',
  'puzzle.claim.passNoGain': 'puzzles.reason.claimPassNoGain',
  'puzzle.claim.kong': 'puzzles.reason.claimKong',
  'puzzle.claim.ready': 'puzzles.reason.claimReady',
  'puzzle.claim.closer': 'puzzles.reason.claimCloser',
  'puzzle.value.keepPattern': 'puzzles.reason.valueKeepPattern',
  'puzzle.value.tradeSpeed': 'puzzles.reason.valueTradeSpeed',
  'puzzle.value.speed': 'puzzles.reason.valueSpeed',
  'puzzle.value.both': 'puzzles.reason.valueBoth',
  'puzzle.value.moreTai': 'puzzles.reason.valueMoreTai',
};

/** The headline key for an engine reason key, or null for one the app does not know yet (then only the explanation shows). */
export function reasonTitleKey(reasonKey: string): string | null {
  return REASON_KEYS[reasonKey] ?? null;
}

// ---------------------------------------------------------------------------
// Claim puzzles
// ---------------------------------------------------------------------------

export interface ClaimButton {
  id: string;
  type: ClaimChoice;
  label: TextKey;
  /** The tiles the claim makes (the discard included), for the picture on the button; empty for pass. */
  kinds: Kind[];
  option: ClaimOption;
}

const CLAIM_ORDER: Record<ClaimChoice, number> = { pass: 0, chi: 1, pong: 2, kong: 3, hu: 4 };
const CLAIM_LABEL_KEYS: Record<ClaimChoice, string> = {
  pass: 'puzzles.claim.pass',
  chi: 'puzzles.claim.chi',
  pong: 'puzzles.claim.pong',
  kong: 'puzzles.claim.kong',
  hu: 'puzzles.claim.hu',
};

/**
 * One button per legal response, in table order: pass, each 吃 shape (lowest first), 碰,
 * 槓, 胡. Labels name the tiles in the app's language.
 */
export function claimButtons(p: ClaimPuzzle, locale: string): ClaimButton[] {
  const d = p.discard;
  return p.options
    .map((o): ClaimButton => {
      const name = tileName(d, locale);
      switch (o.type) {
        case 'pass':
          return { id: o.id, type: o.type, label: { key: CLAIM_LABEL_KEYS.pass }, kinds: [], option: o };
        case 'chi': {
          const [a, b] = o.kinds!;
          return { id: o.id, type: o.type, label: { key: CLAIM_LABEL_KEYS.chi, params: { tile: name, a: tileName(a, locale), b: tileName(b, locale) } }, kinds: [a, b, d].sort((x, y) => x - y), option: o };
        }
        case 'pong':
          return { id: o.id, type: o.type, label: { key: CLAIM_LABEL_KEYS.pong, params: { tile: name } }, kinds: [d, d, d], option: o };
        case 'kong':
          return { id: o.id, type: o.type, label: { key: CLAIM_LABEL_KEYS.kong, params: { tile: name } }, kinds: [d, d, d, d], option: o };
        case 'hu':
          return { id: o.id, type: o.type, label: { key: CLAIM_LABEL_KEYS.hu, params: { tile: name } }, kinds: [d], option: o };
      }
    })
    .sort((x, y) => CLAIM_ORDER[x.type] - CLAIM_ORDER[y.type] || (x.kinds[0] ?? 0) - (y.kinds[0] ?? 0));
}

/** Where a claim option leaves the hand, shown on each button once the puzzle is answered. */
export function claimOutcomeKey(o: ClaimOption): TextKey {
  if (o.type === 'hu') return { key: 'puzzles.claim.win' };
  if (o.shantenAfter <= 0) return { key: 'puzzles.claim.ready', params: { tiles: o.acceptance } };
  return { key: 'puzzles.claim.away', params: { n: o.shantenAfter } };
}

// ---------------------------------------------------------------------------
// Defence puzzles
// ---------------------------------------------------------------------------

export interface DefenceSeat {
  seat: number;
  relation: SeatRelation;
  threat: boolean;
  melds: PuzzleMeld[];
  discards: Kind[];
}

/** The other three seats, the threatening one first, then left, opposite and right. */
export function defenceSeats(p: DefencePuzzle): DefenceSeat[] {
  const order: Record<SeatRelation, number> = { left: 0, opposite: 1, right: 2 };
  return p.opponents
    .map((o) => ({ seat: o.seat, relation: seatRelation(o.seat), threat: o.seat === p.threatSeat, melds: o.melds, discards: o.discards }))
    .sort((a, b) => Number(b.threat) - Number(a.threat) || order[a.relation] - order[b.relation]);
}

/** The heading for the threatening seat: four exposed sets, or three and a long discard row. */
export function threatKey(p: DefencePuzzle): TextKey {
  const n = p.opponents.find((o) => o.seat === p.threatSeat)?.melds.length ?? 0;
  return { key: n >= 4 ? 'puzzles.defence.threatFour' : 'puzzles.defence.threatThree', params: { n } };
}

/** One shape-keeping discard after a defence puzzle is answered: how often it would deal in, and whether it counts. */
export interface DefenceVerdict {
  kind: Kind;
  /** Exact chance (0–1) that the threat, if ready, wins on this tile (the engine's enumeration). */
  chance: number;
  accepted: boolean;
}

/** Every discard that keeps the hand's shape, safest first, so the player sees why others are also fine or worse. */
export function defenceVerdicts(p: DefencePuzzle): DefenceVerdict[] {
  return p.options
    .filter((o) => o.shanten === p.bestShanten)
    .map((o) => ({ kind: o.kind, chance: o.exact, accepted: p.answers.includes(o.kind) }))
    .sort((a, b) => Number(b.accepted) - Number(a.accepted) || a.chance - b.chance || a.kind - b.kind);
}

/** A percentage for the verdict lines, one decimal. */
export function percent(x: number): string {
  return `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Value puzzles
// ---------------------------------------------------------------------------

export interface ValueProjection {
  kind: Kind;
  /** 'best' is the highest expected score, 'accepted' within the tolerance of it, 'worse' the rest. */
  role: 'best' | 'accepted' | 'worse';
  /** Average 台 of a win over the live winning tiles (a quarter of wins self-drawn). */
  expectedTai: number;
  /** The biggest single win, in 台 (−1 when no winning tile is live). */
  bestTai: number;
  /** Expected score as a share of the best discard's (0–100). */
  share: number;
  /** The headline pattern items of the biggest win. */
  items: TaiItem[];
  waits: Kind[];
  acceptance: number;
}

/** Every discard that keeps the hand ready, best expected score first: the cards shown after answering. */
export function valueProjections(p: ValuePuzzle): ValueProjection[] {
  const ready = p.options.filter((o) => o.ready && (o.acceptance ?? 0) > 0);
  const top = Math.max(...ready.map((o) => o.expectedScore ?? 0));
  return ready
    .map((o): ValueProjection => ({
      kind: o.kind,
      role: o.kind === p.answer ? 'best' : p.answers.includes(o.kind) ? 'accepted' : 'worse',
      expectedTai: o.expectedTai ?? 0,
      bestTai: o.bestTai ?? -1,
      share: top > 0 ? Math.round((100 * (o.expectedScore ?? 0)) / top) : 0,
      items: o.items ?? [],
      waits: o.waits ?? [],
      acceptance: o.acceptance ?? 0,
    }))
    .sort((a, b) => b.share - a.share || a.kind - b.kind);
}

/** One decimal for the average 台 on a card (whole numbers stay whole). */
export function taiFigure(x: number): string {
  return (Math.round(x * 10) / 10).toString();
}
