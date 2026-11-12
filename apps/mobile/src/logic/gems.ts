/**
 * What a diamond counter shows and says. After a refund of a pack whose diamonds were already
 * spent the purchased balance is below zero (the Shop explains it in its "owed" card), so the
 * counter can be negative, and with bonus diamonds it can even be positive while a debt blocks
 * every spend. Pure, so Home and the Shop read the same and both languages are tested.
 */
import type { Translate } from './translate';

/** A true minus sign: a hyphen before digits reads as a dash, and some screen readers skip it. */
const MINUS = '\u2212';

export interface GemCounterView {
  /** The number in the capsule, with thousands separators and a real minus sign below zero. */
  text: string;
  /** True while diamonds are owed: the capsule is tinted and the label says how many. */
  owed: boolean;
  /** The screen-reader label of the whole control. */
  label: string;
}

/** The signed balance as the counters print it. */
export function gemBalanceText(balance: number): string {
  const n = Number.isFinite(balance) ? Math.trunc(balance) : 0;
  return n < 0 ? `${MINUS}${Math.abs(n).toLocaleString()}` : n.toLocaleString();
}

/**
 * @param balance the signed balance the counter shows (`totalDiamonds`)
 * @param owed    diamonds owed after a refund (`diamondsOwed`); when omitted, what the balance is below zero
 */
export function gemCounter(t: Translate, balance: number, owed: number = Math.max(0, -balance)): GemCounterView {
  const text = gemBalanceText(balance);
  const debt = Number.isFinite(owed) ? Math.max(0, Math.trunc(owed)) : 0;
  if (debt > 0) return { text, owed: true, label: t('table.a11y.gemsOwed', { balance: text, n: debt.toLocaleString() }) };
  return { text, owed: false, label: t('table.a11y.gems', { n: text }) };
}
