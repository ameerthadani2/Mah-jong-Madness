import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cappedTai, DEFAULT_RULES, type TaiItem } from '@mjm/engine';
import { taiCapNote } from './taiCap';
import { translator } from './translator.fixture';

const item = (key: string, tai: number): TaiItem => ({ key, nameZh: key, nameEn: key, tai });
/** A score as the engine totals it: the cap on the items that are not the dealer's, the dealer's on top. */
function score(items: TaiItem[], maxTai: number) {
  const dealer = items.filter((i) => i.key === 'dealer' || i.key === 'dealer_streak').reduce((n, i) => n + i.tai, 0);
  const base = items.reduce((n, i) => n + i.tai, 0) - dealer;
  return { items, tai: cappedTai({ ...DEFAULT_RULES, maxTai }, base) + dealer, taiUncapped: base + dealer };
}

describe('a win limited by the 台 cap', () => {
  const big = [item('all_pongs', 4), item('half_flush', 4), item('self_drawn', 1), item('concealed', 1), item('three_concealed', 2)];

  it('says nothing when the rules have no cap or the hand is under it', () => {
    expect(taiCapNote(score(big, 0))).toBeNull();
    expect(taiCapNote(score(big, 12))).toBeNull();
    expect(taiCapNote(score(big, 20))).toBeNull();
  });

  it('says how much the hand counted and what the rules cap it at', () => {
    const note = taiCapNote(score(big, 8));
    expect(note).toEqual({ key: 'table.win.capped', params: { cap: 8, counted: 12 } });
    expect(translator('en')(note!.key, note!.params)).toBe("Capped (封頂): this hand counts 12 台, and this table's rules cap a hand at 8.");
    expect(translator('zh-TW')(note!.key, note!.params)).toBe('封頂：這手牌算出 12 台，但這桌的規則一手最多算 8 台。');
  });

  it('keeps the dealer\'s 台 outside the cap, and says so', () => {
    const s = score([...big, item('dealer', 1), item('dealer_streak', 2)], 8);
    expect(s.tai).toBe(11);
    const note = taiCapNote(s);
    expect(note).toEqual({ key: 'table.win.cappedDealer', params: { cap: 8, counted: 12, dealer: 3, tai: 11 } });
    expect(translator('en')(note!.key, note!.params)).toMatch(/cap a hand at 8\. The dealer's 3 台 are added on top: 11 台\./);
    expect(translator('zh-TW')(note!.key, note!.params)).toMatch(/一手最多算 8 台；莊家的 3 台另計，合計 11 台。/);
  });

  it('is shown on the result sheet beside the total', () => {
    const sheet = readFileSync(join(__dirname, '..', 'components', 'table', 'ResultSheet.tsx'), 'utf8');
    expect(sheet).toMatch(/const capNote = taiCapNote\(w\.score\);/);
    expect(sheet).toMatch(/\{capNote && \(\s*<Text testID="tai-capped"/);
  });
});
