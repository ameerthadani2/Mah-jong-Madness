/**
 * What a screen reader is told about the compass and the wall. The compass and the HUD's wall chip are read
 * as one labelled item each ("East round, you are South, the dealer is on your left", "17 tiles left in the
 * wall"); the hidden live region beside the compass speaks only when something changes that a player acts on:
 * the round or the seats turn (a new dealer), or the wall drops to 10, to 5, or to its last tile. A draw that
 * takes the wall from 40 to 39, or a dealer who keeps the deal, says nothing.
 */

/** Wall counts that are said aloud as the wall drops past them. */
export const WALL_CALLS = [10, 5, 1] as const;

/** The seat as seen from the player: 0 = me, 1 = on my right, 2 = across, 3 = on my left. */
export type Relation = 0 | 1 | 2 | 3;

export interface HudFacts {
  /** The prevailing wind, 0 = East. */
  round: number;
  /** My seat wind, 0 = East. */
  myWind: number;
  /** Where the dealer sits, from my seat. */
  dealerRel: Relation;
  drawsLeft: number;
}

/** The wall count to say after a change from `prev` to `next`, or null when the drop crosses no call. */
export function wallCall(prev: number | null, next: number): number | null {
  if (prev === null || !Number.isFinite(prev) || !Number.isFinite(next) || next >= prev) return null;
  return WALL_CALLS.some((c) => prev > c && next <= c) ? next : null;
}

/** What to say between two readings of the table: nothing on the first, the compass when the round or seats turn, the wall at its calls. */
export function hudNotice(prev: HudFacts | null, next: HudFacts): Array<'compass' | 'wall'> {
  if (!prev) return [];
  const out: Array<'compass' | 'wall'> = [];
  if (prev.round !== next.round || prev.myWind !== next.myWind || prev.dealerRel !== next.dealerRel) out.push('compass');
  if (wallCall(prev.drawsLeft, next.drawsLeft) !== null) out.push('wall');
  return out;
}

const WIND_KEYS = ['east', 'south', 'west', 'north'] as const;
const REL_KEYS = ['me', 'right', 'across', 'left'] as const;
type T = (key: string, params?: Record<string, unknown>) => string;

/** "East round, you are South, the dealer is on your left" (or "... you are East and the dealer"). */
export function compassSentence(t: T, f: Pick<HudFacts, 'round' | 'myWind' | 'dealerRel'>): string {
  const round = t(`table.a11y.wind.${WIND_KEYS[f.round & 3]}`);
  const seat = t(`table.a11y.wind.${WIND_KEYS[f.myWind & 3]}`);
  if (f.dealerRel === 0) return t('table.a11y.compassDealer', { round, seat });
  return t('table.a11y.compass', { round, seat, dealer: t(`table.a11y.dealerAt.${REL_KEYS[f.dealerRel]}`) });
}

/** "East round, hand 3, the dealer has kept the deal 2 times" for the HUD's round chip. */
export function roundSentence(t: T, round: number, hand: number, streak: number): string {
  const text = t('table.a11y.roundChip', { round: t(`table.a11y.wind.${WIND_KEYS[round & 3]}`), hand });
  return streak ? text + t('table.a11y.dealerStreak', { n: streak }) : text;
}

/** "17 tiles left in the wall", with its own words for the last tile. */
export function wallSentence(t: T, n: number): string {
  return n === 1 ? t('table.a11y.drawsLeftOne') : t('table.a11y.drawsLeft', { n });
}
