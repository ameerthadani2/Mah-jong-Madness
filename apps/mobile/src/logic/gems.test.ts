import { describe, expect, it } from 'vitest';
import { gemBalanceText, gemCounter } from './gems';
import { translator } from './translator.fixture';
import { canAfford, diamondsOwed, EMPTY_WALLET, totalDiamonds } from '../monetisation/wallet';

const MINUS = '\u2212';
const en = translator('en');
const zh = translator('zh-TW');

describe('the diamond counter', () => {
  it('prints a balance at or above zero as a plain number', () => {
    expect(gemBalanceText(0)).toBe('0');
    expect(gemBalanceText(75)).toBe('75');
    expect(gemBalanceText(12345)).toBe((12345).toLocaleString());
    const view = gemCounter(en, 320);
    expect(view).toEqual({ text: '320', owed: false, label: '320 diamonds, open the shop' });
    expect(gemCounter(zh, 320).label).toBe('320 顆鑽石，開啟商店');
  });

  it('prints a balance below zero with a real minus sign, never a hyphen', () => {
    expect(gemBalanceText(-150)).toBe(`${MINUS}150`);
    expect(gemBalanceText(-2500)).toBe(`${MINUS}${(2500).toLocaleString()}`);
    expect(gemBalanceText(-150)).not.toContain('-');
    // Junk never reaches the screen as "NaN".
    expect(gemBalanceText(Number.NaN)).toBe('0');
  });

  it('says how many diamonds are owed, in words a screen reader can read, in both languages', () => {
    const view = gemCounter(en, -150);
    expect(view.owed).toBe(true);
    expect(view.text).toBe(`${MINUS}150`);
    expect(view.label).toBe(`Diamond balance ${MINUS}150: 150 owed after a refund. Open the shop.`);
    const tw = gemCounter(zh, -150);
    expect(tw.label).toBe(`鑽石餘額 ${MINUS}150，退款後尚欠 150 顆。開啟商店。`);
    expect(tw.label).not.toMatch(/[A-Za-z]{3,}/);
    // The label never reads as a bare negative number of diamonds.
    for (const label of [view.label, tw.label]) {
      expect(label).not.toContain('-');
      expect(label).toMatch(/owed after a refund|退款後尚欠/);
    }
  });

  it('still says a debt is owed when bonus diamonds keep the balance above zero', () => {
    // 50 owed, 120 bonus: the counter shows 70, yet nothing can be spent until the 50 are paid back.
    const wallet = { ...EMPTY_WALLET, diamonds: -50, bonusDiamonds: 120 };
    expect(canAfford(wallet, 10).ok).toBe(false);
    const view = gemCounter(en, totalDiamonds(wallet), diamondsOwed(wallet));
    expect(view).toEqual({ text: '70', owed: true, label: 'Diamond balance 70: 50 owed after a refund. Open the shop.' });
    // And with more owed than the bonus holds, the two numbers differ: both are said.
    const deeper = { ...EMPTY_WALLET, diamonds: -200, bonusDiamonds: 50 };
    expect(gemCounter(en, totalDiamonds(deeper), diamondsOwed(deeper)).label).toBe(`Diamond balance ${MINUS}150: 200 owed after a refund. Open the shop.`);
  });

  it('is an ordinary counter when nothing is owed, whatever is passed as the debt', () => {
    for (const owed of [0, -5, Number.NaN]) expect(gemCounter(en, 40, owed)).toEqual({ text: '40', owed: false, label: '40 diamonds, open the shop' });
    const wallet = { ...EMPTY_WALLET, diamonds: 30, bonusDiamonds: 10 };
    expect(gemCounter(en, totalDiamonds(wallet), diamondsOwed(wallet)).owed).toBe(false);
  });

  it('Home names the same debt as the Shop does, and points there, in both languages', () => {
    const n = (440).toLocaleString();
    expect(en('home.shop.owed', { n })).toBe('440 diamonds owed after a refund. See why in the Shop.');
    expect(en('home.shop.owed', { n }).startsWith(en('shop.owed.title', { n }))).toBe(true);
    expect(zh('home.shop.owed', { n })).toBe('退款後尚欠 440 顆鑽石，到商店看說明。');
    expect(zh('home.shop.owed', { n }).startsWith(zh('shop.owed.title', { n }))).toBe(true);
  });
});
