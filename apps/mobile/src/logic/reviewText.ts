/**
 * The words of a hand review in the app's language. The engine's review reasons carry tile names in Chinese
 * (`actualName`, `bestName`) for both languages; a player reading English gets the English names the puzzles
 * use, rebuilt here from the tile codes that travel in the same params.
 */
import { kindFromCode, kindOf, type Kind, type ReasonParams, type ReviewedMove } from '@mjm/engine';
import { tileName } from './puzzle';
import type { Message } from './translate';

function kindOfCode(code: unknown): Kind | null {
  if (typeof code !== 'string') return null;
  try {
    return kindFromCode(code);
  } catch {
    return null;
  }
}

const ACTION_KEYS: Record<string, string> = { hu: 'review.action.hu', pong: 'review.action.pong', pass: 'review.action.pass' };

/** Several tiles in a row, as a list in the app's language. */
export function tileNames(kinds: readonly Kind[], locale: string): string {
  return kinds.map((k) => tileName(k, locale)).join(locale === 'zh-TW' ? '、' : ', ');
}

/** "Discard 2 Bamboo", "Chi 4 Dots, 6 Dots", "Win": what the player did, or what the coach would have done. */
export function reviewAction(a: ReviewedMove['actual'] | null, locale: string): Message {
  if (!a) return { key: 'review.action.none' };
  switch (a.type) {
    case 'discard':
      return { key: 'review.action.discard', params: { tile: tileName(kindOf(a.tile), locale) } };
    case 'chi':
      return { key: 'review.action.chi', params: { tiles: tileNames(a.tiles.map(kindOf), locale) } };
    case 'kong':
      return { key: 'review.action.kong', params: { tile: tileName(kindOf(a.tile), locale) } };
    case 'hu':
      return { key: 'review.action.hu' };
    case 'pong':
      return { key: 'review.action.pong' };
    default:
      // The only action left is a pass.
      return { key: 'review.action.pass' };
  }
}

/**
 * The engine's params for a review reason with every tile named in the app's language. `t` is needed for the
 * one reason whose `best` is a whole action ("the coach would not kong here (… instead)").
 */
export function reviewReasonParams(key: string, params: ReasonParams, locale: string, t: (key: string, params?: Record<string, unknown>) => string): ReasonParams {
  const out: ReasonParams = { ...params };
  const actual = kindOfCode(params.actual);
  const best = kindOfCode(params.best);
  if (actual !== null && 'actualName' in params) out.actualName = tileName(actual, locale);
  if (best !== null && 'bestName' in params) out.bestName = tileName(best, locale);
  if (key === 'review.turn.kongNotBest' && typeof params.best === 'string') {
    if (best !== null) out.best = t('review.action.discard', { tile: tileName(best, locale) });
    else if (ACTION_KEYS[params.best]) out.best = t(ACTION_KEYS[params.best]);
  }
  return out;
}
