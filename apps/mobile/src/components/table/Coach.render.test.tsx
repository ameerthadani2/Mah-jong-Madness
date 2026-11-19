import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { Hint } from '@mjm/engine';
import { CoachBar, CoachPanel, CoachSheet } from './CoachPanel';
import { setLocalePreference } from '../../i18n';

/** A coach hint as the engine gives it (packages/engine/src/hints.ts): reason keys and their parameters. */
function hint(over: Partial<Hint> = {}): Hint {
  return { seat: 0, phase: 'discard', shanten: 2, status: '', statusKey: 'hint.status.twoAway', statusParams: {}, waits: [], discards: [], claims: [], valueTiles: [], ...over };
}
const NORTH = { tile: 'N', tileName: '北 (North)', tileZh: '北' };
const DISCARD = hint({ discardReasonKey: 'hint.discard.isolated', discardReasonParams: NORTH });
const ADVICE = 'Discard 北 (North); it does not fit any set you are building.';
const STATUS = 'Two tiles from ready.';

const realOS = Platform.OS;
function setOS(os: typeof Platform.OS) {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}
afterEach(() => {
  setLocalePreference('auto');
  setOS(realOS);
});

describe('the coach bar takes a 44 pt press', () => {
  // A one-line bar is drawn 27 px tall.
  it('on a phone by hitSlop, 9 px above and below', async () => {
    setOS('ios');
    await render(<CoachBar hint={DISCARD} lines={{ status: 0, advice: 1 }} onOpen={() => undefined} />);
    const bar = screen.getByTestId('coach');
    expect(bar.props.hitSlop).toMatchObject({ top: 9, bottom: 9 });
  });

  it('on the web, which ignores hitSlop, by padding as much with an equal negative margin (the bar stays where it is)', async () => {
    setOS('web');
    await render(<CoachBar hint={DISCARD} lines={{ status: 0, advice: 1 }} onOpen={() => undefined} />);
    const style = StyleSheet.flatten(screen.getByTestId('coach').props.style);
    expect(style).toMatchObject({ paddingTop: 9, paddingBottom: 9, marginTop: -9, marginBottom: -9 });
    expect(27 + style.paddingTop + style.paddingBottom).toBeGreaterThanOrEqual(44);
    // The bar as drawn is inside the press.
    expect(within(screen.getByTestId('coach')).getByTestId('coach-face')).toBeOnTheScreen();
  });
});

describe('the coach bar (phones)', () => {
  it('shows the tile to discard on the line it has, ellipsised past it, and opens the sheet with everything', async () => {
    const onOpen = jest.fn();
    await render(<CoachBar hint={DISCARD} lines={{ status: 0, advice: 1 }} onOpen={onOpen} />);
    const advice = screen.getByTestId('coach-advice');
    expect(advice).toHaveTextContent(ADVICE);
    // One line on screen, ending in an ellipsis when the sentence is longer: never cut without a sign.
    expect(advice.props.numberOfLines).toBe(1);
    expect(screen.queryByTestId('coach-status')).toBeNull();
    expect(screen.getByText('More')).toBeOnTheScreen();
    // The whole bar is one button: a screen reader hears every word, whatever the ellipsis leaves on screen.
    const bar = screen.getByRole('button', { name: `${STATUS} ${ADVICE}` });
    expect(bar.props.accessibilityHint).toBe("Shows all of the coach's advice");
    await fireEvent.press(bar);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the status over two lines of advice where it has the room (portrait)', async () => {
    await render(<CoachBar hint={DISCARD} lines={{ status: 1, advice: 2 }} onOpen={() => undefined} />);
    expect(screen.getByTestId('coach-status')).toHaveTextContent(STATUS);
    expect(screen.getByTestId('coach-status').props.numberOfLines).toBe(1);
    expect(screen.getByTestId('coach-advice').props.numberOfLines).toBe(2);
  });

  it('with nothing to do now, gives the status the advice’s lines, so the bar is never empty', async () => {
    await render(<CoachBar hint={hint({ statusKey: 'hint.status.manyAway', statusParams: { shanten: 4 } })} lines={{ status: 0, advice: 1 }} onOpen={() => undefined} />);
    expect(screen.queryByTestId('coach-advice')).toBeNull();
    const status = screen.getByTestId('coach-status');
    expect(status).toHaveTextContent('4 tiles from ready — build sets, keep pairs.');
    expect(status.props.numberOfLines).toBe(1);
    // The hand is over: the coach says so rather than leaving the screen while its button shows it on.
    await render(<CoachBar hint={hint({ phase: 'ended', statusKey: 'hint.status.handOver' })} lines={{ status: 1, advice: 2 }} onOpen={() => undefined} />);
    expect(screen.getByTestId('coach-status')).toHaveTextContent('Hand over');
    expect(screen.getByTestId('coach-status').props.numberOfLines).toBe(3);
  });

  it('names the claim it recommends, and leads with a win and what it scores', async () => {
    const pong = { action: { type: 'pong' as const }, label: '', labelKey: 'hint.label.pong', labelParams: NORTH, recommended: true, reason: '', reasonKey: 'hint.claim.recommendedCloser', reasonParams: {} };
    await render(<CoachBar hint={hint({ phase: 'claim', claims: [pong] })} lines={{ status: 0, advice: 1 }} onOpen={() => undefined} />);
    expect(screen.getByTestId('coach-advice')).toHaveTextContent('Pong (碰) 北 (North): This claim brings you closer to ready.');
    const winPreview = { items: [{ nameZh: '自摸', tai: 1 }, { nameZh: '門清', tai: 1 }], tai: 2 } as unknown as Hint['winPreview'];
    await render(<CoachBar hint={hint({ statusKey: 'hint.status.canWinSelfDraw', statusParams: { how: '自摸', tai: 2 }, winPreview })} lines={{ status: 0, advice: 1 }} onOpen={() => undefined} />);
    expect(screen.getByTestId('coach-advice')).toHaveTextContent('自摸 1 · 門清 1 = 2 台');
  });

  it('speaks Traditional Chinese on a zh-TW phone', async () => {
    setLocalePreference('zh-TW');
    await render(<CoachBar hint={DISCARD} lines={{ status: 1, advice: 2 }} onOpen={() => undefined} />);
    expect(screen.getByTestId('coach-advice')).toHaveTextContent('打 北：它跟你正在湊的面子都搭不上。');
    expect(screen.getByText('更多')).toBeOnTheScreen();
  });
});

describe("the coach's sheet", () => {
  it('holds everything the coach says, and closes from its own button (the scrim is no control)', async () => {
    const onClose = jest.fn();
    const ready = hint({ statusKey: 'hint.status.readyAfterDiscard', discardReasonKey: 'hint.discard.ready', discardReasonParams: { ...NORTH, waits: '三萬×2, 六萬×3' }, waits: [{ kind: 2, remaining: 2 }, { kind: 5, remaining: 3 }] });
    await render(<CoachSheet hint={ready} visible onClose={onClose} />);
    const sheet = screen.getByTestId('coach-sheet');
    expect(sheet.props.role).toBe('dialog');
    expect(sheet.props['aria-label']).toBe("The coach's advice");
    expect(within(sheet).getByText('Ready (聽牌) after this discard.')).toBeOnTheScreen();
    expect(within(sheet).getByTestId('coach-advice')).toHaveTextContent('Discard 北 (North) to be ready, waiting on 三萬×2, 六萬×3.');
    // The waits, each with what is left of it.
    expect(within(sheet).getByText('×2')).toBeOnTheScreen();
    expect(within(sheet).getByText('×3')).toBeOnTheScreen();
    const scrim = screen.getByTestId('coach-sheet-scrim', { includeHiddenElements: true });
    expect(scrim.props['aria-hidden']).toBe(true);
    expect(scrim.props.accessibilityRole).toBeUndefined();
    await fireEvent.press(within(sheet).getByRole('button', { name: 'Close the advice' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows nothing without a hint (the coach turned off, or the table gone)', async () => {
    await render(<CoachSheet hint={null} visible onClose={() => undefined} />);
    expect(screen.queryByTestId('coach-sheet')).toBeNull();
  });
});

describe('the coach panel (tablets)', () => {
  it('shows everything, and once it is taller than its room it scrolls and offers More', async () => {
    const onOpen = jest.fn();
    await render(<CoachPanel hint={DISCARD} maxHeight={120} onOpen={onOpen} />);
    expect(screen.getByText('Coach')).toBeOnTheScreen();
    expect(screen.getByTestId('coach-advice')).toHaveTextContent(ADVICE);
    expect(screen.queryByTestId('coach-more')).toBeNull();
    const box = screen.getByTestId('coach-text');
    // The text as laid out: 80 px of room for 150 px of advice.
    await fireEvent(box, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 80 } } });
    await fireEvent(box, 'contentSizeChange', 200, 150);
    await fireEvent.press(screen.getByRole('button', { name: "Shows all of the coach's advice" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('the coach at a claim chance it would let go by', () => {
  const claim = (labelKey: string) => ({ action: { type: 'pass' as const }, label: '', labelKey, labelParams: { tileName: '五筒 (5 Dots)', tileZh: '五筒' }, recommended: false, reason: '', reasonKey: 'hint.claim.noGain', reasonParams: {} });
  const PASSING = hint({ phase: 'claim', claims: [claim('hint.label.pong')] });

  it('says Pass on the bar, with why the claim on offer does not help', async () => {
    await render(<CoachBar hint={PASSING} lines={{ status: 0, advice: 2 }} onOpen={() => undefined} />);
    expect(screen.getByTestId('coach-advice')).toHaveTextContent('Pass (過): This does not bring you closer to ready.');
  });

  it('says it in the sheet too, ticked, above the claim it lets go by', async () => {
    await render(<CoachSheet visible hint={PASSING} onClose={() => undefined} />);
    const sheet = screen.getByTestId('coach-sheet');
    expect(within(sheet).getByTestId('coach-advice')).toHaveTextContent('Pass (過): This does not bring you closer to ready.');
    expect(within(sheet).getByText(/^Pong \(碰\) 五筒 \(5 Dots\): /)).toBeOnTheScreen();
  });

  it('in Traditional Chinese', async () => {
    setLocalePreference('zh-TW');
    await render(<CoachBar hint={PASSING} lines={{ status: 0, advice: 2 }} onOpen={() => undefined} />);
    expect(screen.getByTestId('coach-advice')).toHaveTextContent('過：吃碰這張不會讓你離聽牌更近。');
  });
});
