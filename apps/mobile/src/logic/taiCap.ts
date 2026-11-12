/**
 * Why a win's total is lower than its items add up to: the table's rules cap a hand's 台 (封頂, `maxTai`).
 * The engine's score carries both totals (`tai` with the cap, `taiUncapped` without) and the cap leaves the
 * dealer's items (莊家, 連莊) outside, so the cap itself is the capped total less those items.
 */
import { DEALER_KEYS, type ScoreResult } from '@mjm/engine';
import type { Message } from './translate';

export function taiCapNote(score: Pick<ScoreResult, 'tai' | 'taiUncapped' | 'items'>): Message | null {
  if (score.taiUncapped <= score.tai) return null;
  const dealer = score.items.filter((i) => DEALER_KEYS.has(i.key)).reduce((n, i) => n + i.tai, 0);
  const cap = score.tai - dealer;
  const counted = score.taiUncapped - dealer;
  if (dealer > 0) return { key: 'table.win.cappedDealer', params: { cap, counted, dealer, tai: score.tai } };
  return { key: 'table.win.capped', params: { cap, counted } };
}
