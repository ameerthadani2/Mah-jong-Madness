import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Platform, Text } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { HandResult, TableView, WinRecord } from '@mjm/engine';
import type { ClientState } from '@mjm/net';
import { MatchOverSheet, ResultSheet } from './ResultSheet';
import { setLocalePreference } from '../../i18n';

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

describe('the result sheet in Chinese', () => {
  afterEach(() => setLocalePreference('auto'));

  it('reads each 台 by its Chinese name alone', async () => {
    setLocalePreference('zh-TW');
    await renderResult({ type: 'win', wins: [win({ tai: 12, taiUncapped: 12, items: BIG })], scoreDelta: [120, -40, -40, -40], dealerContinues: false });
    expect(screen.getByText('碰碰胡')).toHaveTextContent('碰碰胡', { exact: true });
    expect(screen.queryByText(/All Pongs/)).toBeNull();
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

describe('the online result sheet', () => {
  it('counts down to the next hand the host deals, and says so in general without a deadline', async () => {
    const result: HandResult = { type: 'draw', wins: [], scoreDelta: [0, 0, 0, 0], dealerContinues: true };
    const view = { scores: [0, 0, 0, 0] } as unknown as TableView;
    const base = { seats: SEATS, auditStatus: 'ok', auditFailures: [], auditCaveats: [], matchOver: false };
    const state = { ...base, intermissionDeadline: Date.now() + 9_500 } as unknown as ClientState;
    const { unmount } = await render(<ResultSheet result={result} view={view} state={state} mySeat={0} autoNext onNext={() => {}} onLeave={() => {}} onReview={() => {}} onFairness={() => {}} />);
    expect(screen.getByTestId('result-auto-next')).toHaveTextContent('Next hand in 10 s');
    expect(screen.getByTestId('next-hand-notice')).toHaveTextContent('The next hand starts in 10 seconds.');
    // The visible line ticks every second, so it is not a live region; the hidden notice, said once a hand, is.
    expect(screen.getByTestId('result-auto-next').props.accessibilityLiveRegion).toBeUndefined();
    expect(screen.getByTestId('next-hand-notice').props.accessibilityLiveRegion).toBe('polite');
    await unmount();
    await render(<ResultSheet result={result} view={view} state={{ ...base, intermissionDeadline: null } as unknown as ClientState} mySeat={0} autoNext onNext={() => {}} onLeave={() => {}} onReview={() => {}} onFairness={() => {}} />);
    expect(screen.getByTestId('result-auto-next')).toHaveTextContent('Online, the next hand starts by itself in a few seconds.');
  });
});

describe('the match-over card after a quick match', () => {
  const over = { seats: SEATS, auditStatus: 'ok', auditFailures: [], auditCaveats: [], matchOver: true, finalScores: [300, -100, -100, -100] } as unknown as ClientState;

  it('scrolls its standings and the way home inside a card no taller than the screen allows', async () => {
    await render(<MatchOverSheet state={over} onLeave={() => {}} />);
    const scrollOf = (el: { type: unknown; parent: unknown; props: Record<string, unknown> } | null) => {
      for (let n = el; n; n = n.parent as typeof n) if (n.type === 'RCTScrollView') return n;
      return null;
    };
    const standings = scrollOf(screen.getByText('Mei') as never);
    expect(standings).not.toBeNull();
    // The way home is in the same scroll view, so a short screen scrolls to it rather than cutting it off.
    expect(scrollOf(screen.getByRole('button', { name: 'Back to home' }) as never)).toBe(standings);
    // The card is capped at a height (matchOverLayout), so a short screen scrolls it rather than cutting it.
    const card = screen.getByTestId('match-over');
    const style = [card.props.style].flat(Infinity).reduce((a: Record<string, unknown>, s) => ({ ...a, ...(s as object) }), {});
    expect(typeof style.maxHeight).toBe('number');
  });

  it('says the rating is being updated, then shows the new rating and its change', async () => {
    const { rerender } = await render(<MatchOverSheet state={over} onLeave={() => {}} rating="pending" />);
    expect(screen.getByTestId('match-rating')).toHaveTextContent('Updating your quick-match rating…');
    await rerender(<MatchOverSheet state={over} onLeave={() => {}} rating={{ rating: 1532, change: 12 }} />);
    expect(screen.getByTestId('match-rating')).toHaveTextContent('Quick-match rating 1532 (+12)');
    await rerender(<MatchOverSheet state={over} onLeave={() => {}} rating={{ rating: 1488, change: -12 }} />);
    expect(screen.getByTestId('match-rating')).toHaveTextContent('Quick-match rating 1488 (-12)');
  });

  it('shows no rating line at any other table', async () => {
    await render(<MatchOverSheet state={over} onLeave={() => {}} />);
    expect(screen.queryByTestId('match-rating')).toBeNull();
  });

  it('shows the change in Chinese too', async () => {
    setLocalePreference('zh-TW');
    try {
      await render(<MatchOverSheet state={over} onLeave={() => {}} rating={{ rating: 1532, change: 0 }} />);
      expect(screen.getByTestId('match-rating')).toHaveTextContent('快速配對積分 1532（±0）');
    } finally {
      setLocalePreference('auto');
    }
  });
});

describe('the end-of-hand sheets are modal dialogs', () => {
  const realOS = Platform.OS;
  const setOS = (os: typeof Platform.OS) => {
    (Platform as { OS: typeof Platform.OS }).OS = os;
  };
  afterEach(() => setOS(realOS));
  /** The props of the rendered Modal (the host element react-native's Modal draws), searched from the root. */
  function modalProps(): Record<string, unknown> {
    type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
    const find = (n: Node): Node | null => {
      if (n && typeof n === 'object' && n.type === 'Modal') return n;
      for (const c of n?.children ?? []) {
        const hit = typeof c === 'object' && c ? find(c as Node) : null;
        if (hit) return hit;
      }
      return null;
    };
    const modal = find(screen.root as unknown as Node);
    if (!modal?.props) throw new Error('no Modal rendered');
    return modal.props;
  }
  const DRAW: HandResult = { type: 'draw', wins: [], scoreDelta: [0, 0, 0, 0], dealerContinues: true };

  it('the result sheet: on the web the Modal is the dialog, named by the ribbon, and Back asks to leave', async () => {
    setOS('web');
    const onLeave = jest.fn();
    const state = { seats: SEATS, auditStatus: 'ok', auditFailures: [], auditCaveats: [], matchOver: false } as unknown as ClientState;
    await render(<ResultSheet result={DRAW} view={{ scores: [0, 0, 0, 0] } as unknown as TableView} state={state} mySeat={0} onNext={() => {}} onLeave={onLeave} onReview={() => {}} onFairness={() => {}} />);
    expect(modalProps()['aria-label']).toBe('流局 Draw');
    // The scrim behind it is no control, and Android's Back key asks before leaving (as the table's own Back does).
    (modalProps().onRequestClose as () => void)();
    expect(onLeave).toHaveBeenCalled();
  });

  it('on a phone the sheet itself is the modal dialog, named the same', async () => {
    setOS('ios');
    await renderResult(DRAW);
    const sheet = screen.getByTestId('result-sheet');
    expect(sheet.props.role).toBe('dialog');
    expect(sheet.props['aria-modal']).toBe(true);
    expect(sheet.props['aria-label']).toBe('流局 Draw');
    expect(sheet.props.accessibilityViewIsModal).toBe(true);
    expect(modalProps()['aria-label']).toBeUndefined();
  });

  it('draws the table’s link banner inside its modal, in front, with its button in reach', async () => {
    const onRetry = jest.fn();
    const state = { seats: SEATS, auditStatus: 'ok', auditFailures: [], auditCaveats: [], matchOver: false } as unknown as ClientState;
    const banner = (
      <Text testID="link-banner" onPress={onRetry}>
        Reconnecting
      </Text>
    );
    await render(<ResultSheet result={DRAW} view={{ scores: [0, 0, 0, 0] } as unknown as TableView} state={state} mySeat={0} onNext={() => {}} onLeave={() => {}} onReview={() => {}} onFairness={() => {}} notice={banner} />);
    await fireEvent.press(screen.getByTestId('link-banner'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('the match-over card: on the web the Modal is the dialog, named Match over', async () => {
    setOS('web');
    const over = { seats: SEATS, auditStatus: 'ok', auditFailures: [], auditCaveats: [], matchOver: true, finalScores: [10, -5, -5, 0] } as unknown as ClientState;
    await render(<MatchOverSheet state={over} onLeave={() => {}} />);
    expect(modalProps()['aria-label']).toBe('Match over');
    expect(within(screen.getByTestId('match-over')).getByRole('button', { name: 'Back to home' })).toBeOnTheScreen();
  });
});
