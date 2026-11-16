import { describe, expect, it } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { HandResult, TableView, WinRecord } from '@mjm/engine';
import type { ClientState } from '@mjm/net';
import { ResultSheet } from './ResultSheet';

const item = (key: string, nameZh: string, nameEn: string, tai: number) => ({ key, nameZh, nameEn, tai });
const SEATS = ['Mei', 'Ah Hua', 'Old Wang', 'Lin'].map((name, seat) => ({ seat, name }));

/** Mei (seat 0) self-draws all pongs with a half flush; the table's rules may cap a hand's 台. */
function win(score: { tai: number; taiUncapped: number; items: ReturnType<typeof item>[] }): WinRecord {
  return {
    seat: 0,
    winningTile: 4,
    selfDrawn: true,
    score: { ...score, decomposition: null, concealedSetTypes: [] },
    payments: [],
    hand: [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21],
    melds: [],
    flowers: [],
  } as WinRecord;
}

async function renderResult(result: HandResult) {
  const state = { seats: SEATS, auditStatus: 'ok', auditFailures: [], auditCaveats: [], matchOver: false } as unknown as ClientState;
  const view = { scores: [120, -40, -40, -40] } as unknown as TableView;
  await render(<ResultSheet result={result} view={view} state={state} mySeat={0} onNext={() => {}} onLeave={() => {}} onReview={() => {}} onFairness={() => {}} />);
}

const BIG = [item('all_pongs', '碰碰胡', 'All Pongs', 4), item('half_flush', '混一色', 'Half Flush', 4), item('self_drawn', '自摸', 'Self-drawn', 1), item('concealed', '門清', 'Concealed', 1), item('three_concealed', '三暗刻', 'Three Concealed Pongs', 2)];

describe('the result sheet after a win', () => {
  it('names the winner and lists each 台 with its count', async () => {
    await renderResult({ type: 'win', wins: [win({ tai: 12, taiUncapped: 12, items: BIG })], scoreDelta: [120, -40, -40, -40], dealerContinues: false });
    expect(screen.getByText('Mei wins (胡牌)')).toBeOnTheScreen();
    expect(screen.getByText('Self-drawn (自摸)')).toBeOnTheScreen();
    expect(screen.getByText(/碰碰胡/)).toHaveTextContent('碰碰胡 All Pongs');
    expect(screen.getByText(/三暗刻/)).toHaveTextContent('三暗刻 Three Concealed Pongs');
    expect(screen.getAllByText('4 tai')).toHaveLength(2);
    expect(screen.getByLabelText('12 tai')).toBeOnTheScreen();
    // Under the cap: no cap note.
    expect(screen.queryByText(/Capped/)).toBeNull();
  });

  it("says why the total is lower than the items when the rules' cap applied", async () => {
    await renderResult({ type: 'win', wins: [win({ tai: 8, taiUncapped: 12, items: BIG })], scoreDelta: [80, -40, -40, 0], dealerContinues: false });
    const note = "Capped (封頂): this hand counts 12 台, and this table's rules cap a hand at 8.";
    expect(screen.getByText(note)).toBeOnTheScreen();
    // A screen reader hears the cap with the total.
    expect(screen.getByLabelText(`8 tai. ${note}`)).toBeOnTheScreen();
  });

  it("keeps the dealer's 台 outside the cap, and says so", async () => {
    const items = [...BIG, item('dealer', '莊家', 'Dealer', 1), item('dealer_streak', '連莊', 'Dealer streak', 2)];
    await renderResult({ type: 'win', wins: [win({ tai: 11, taiUncapped: 15, items })], scoreDelta: [110, -40, -40, -30], dealerContinues: true });
    expect(screen.getByText(/The dealer's 3 台 are added on top: 11 台\./)).toBeOnTheScreen();
  });
});

describe('the result sheet after a draw', () => {
  it('says the wall ran out and whether the dealer keeps the deal', async () => {
    await renderResult({ type: 'draw', wins: [], scoreDelta: [0, 0, 0, 0], dealerContinues: true });
    expect(screen.getByText('流局')).toBeOnTheScreen();
    expect(screen.getByText('Draw')).toBeOnTheScreen();
    expect(screen.getByText('Wall exhausted. Dealer keeps the deal (連莊).')).toBeOnTheScreen();
    expect(screen.queryByText(/wins \(胡牌\)/)).toBeNull();
  });

  it('says when the deal passes on', async () => {
    await renderResult({ type: 'draw', wins: [], scoreDelta: [0, 0, 0, 0], dealerContinues: false });
    expect(screen.getByText('Wall exhausted. Dealer passes.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next hand' })).toBeOnTheScreen();
  });
});
