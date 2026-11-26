import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { Action, TableView, TileId } from '@mjm/engine';
import { ActionBar } from './ActionBar';
import { setLocalePreference } from '../../i18n';
import { contrast } from '../../theme';

/**
 * A phone's portrait claim strip and short landscape dock (`compact`) keep to one row, so they never take height from the
 * felt: three or more buttons (two in a narrow dock) are drawn small with the English gloss on Pass only, and several 吃
 * choices are one 吃 button that opens them.
 */
const view = (pendingTile: number) => ({ phase: 'claim', pending: { from: 3, tile: pendingTile, kind: 'discard' } }) as unknown as TableView;
const chi = (a: number, b: number): Action => ({ type: 'chi', tiles: [a as TileId, b as TileId] }) as Action;
const CLAIMS: Action[] = [{ type: 'pass' }, chi(4, 8), chi(8, 16), { type: 'pong' } as Action];

describe('the portrait claim strip on a phone', () => {
  it('shows several 吃 choices as one 吃 button, and draws three or more buttons small, glossing Pass only', async () => {
    await render(<ActionBar actions={CLAIMS} act={() => {}} selected={null} hint={null} view={view(12)} compact />);
    expect(screen.queryAllByRole('button', { name: /^Chow: \d/ })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Chow: choose which tiles (2 ways)' })).toBeOnTheScreen();
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    expect(within(screen.getByRole('button', { name: /^Pong: / })).queryByText('Pong')).toBeNull();
  });

  it('opens the 吃 choices in the strip, takes the one tapped, and goes back to the other claims', async () => {
    const act = jest.fn();
    await render(<ActionBar actions={CLAIMS} act={act} selected={null} hint={null} view={view(12)} compact />);
    await fireEvent.press(screen.getByTestId('claim-chi-open'));
    const choices = screen.getByTestId('chi-choices');
    expect(within(choices).getAllByRole('button', { name: /^Chow: / })).toHaveLength(2);
    // Pass is there too, so when the coach says Pass the button it names is on screen.
    expect(within(choices).getByTestId('claim-pass')).toBeOnTheScreen();
    expect(within(within(choices).getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('claim-chi-back'));
    expect(screen.queryByTestId('chi-choices')).toBeNull();
    expect(screen.getByTestId('claim-pass')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('claim-chi-open'));
    await fireEvent.press(within(screen.getByTestId('chi-choices')).getAllByRole('button', { name: /^Chow: / })[1]);
    expect(act).toHaveBeenCalledWith(chi(8, 16));
  });

  it('passes from the 吃 choices in one tap, and drops Pass’s gloss there too when the dock is narrow', async () => {
    const act = jest.fn();
    await render(<ActionBar actions={CLAIMS} act={act} selected={null} hint={null} view={view(12)} compact wrap={false} smallFrom={2} maxWidth={240} />);
    await fireEvent.press(screen.getByTestId('claim-chi-open'));
    await fireEvent(screen.getByTestId('chi-choices'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 262, height: 50 } } });
    expect(within(screen.getByTestId('claim-pass')).queryByText('Pass')).toBeNull();
    await fireEvent.press(screen.getByTestId('claim-pass'));
    expect(act).toHaveBeenCalledWith({ type: 'pass' });
  });

  it('starts closed at the next claim prompt', async () => {
    const { rerender } = await render(<ActionBar actions={CLAIMS} act={() => {}} selected={null} hint={null} view={view(12)} compact />);
    await fireEvent.press(screen.getByTestId('claim-chi-open'));
    expect(screen.getByTestId('chi-choices')).toBeOnTheScreen();
    await rerender(<ActionBar actions={CLAIMS} act={() => {}} selected={null} hint={null} view={view(20)} compact />);
    expect(screen.queryByTestId('chi-choices')).toBeNull();
    expect(screen.getByTestId('claim-chi-open')).toBeOnTheScreen();
  });

  it('in a narrow short-landscape dock (`smallFrom` 2), draws Pass and one 吃 small too, so they fit 252 px', async () => {
    const two: Action[] = [{ type: 'pass' }, chi(4, 8)];
    const { rerender } = await render(<ActionBar actions={two} act={() => {}} selected={null} hint={null} view={view(12)} compact smallFrom={2} />);
    expect(within(screen.getByRole('button', { name: /^Chow: / })).queryByText('Chow')).toBeNull();
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    // A wider dock keeps two buttons at full size, with their glosses.
    await rerender(<ActionBar actions={two} act={() => {}} selected={null} hint={null} view={view(12)} compact />);
    expect(within(screen.getByRole('button', { name: /^Chow: / })).getByText('Chow')).toBeOnTheScreen();
  });

  it('keeps every 吃 choice and every gloss where the strip is not a phone’s (tablets, landscape)', async () => {
    await render(<ActionBar actions={CLAIMS} act={() => {}} selected={null} hint={null} view={view(12)} />);
    expect(screen.getAllByRole('button', { name: /^Chow: \d/ })).toHaveLength(2);
    expect(within(screen.getByRole('button', { name: /^Pong: / })).getByText('Pong')).toBeOnTheScreen();
    expect(screen.queryByTestId('claim-chi-open')).toBeNull();
  });
});

describe('the short landscape dock, which never scrolls a button out of view', () => {
  const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 50 } } });
  const WIN_CHOW: Action[] = [{ type: 'pass' }, chi(4, 8), { type: 'hu' } as Action];
  const dock = (actions: Action[], tile = 12, maxWidth = 240) => <ActionBar actions={actions} act={() => {}} selected={null} hint={null} view={view(tile)} compact wrap={false} smallFrom={2} maxWidth={maxWidth} />;
  const tilesOn = (el: ReturnType<typeof screen.getByTestId>) => within(el).queryAllByTestId(/^tile-/).length;

  it('draws a row wider than the dock a step tighter until it fits: Pass without its gloss, then the claims without tiles, then Win without its gloss', async () => {
    const { rerender } = await render(dock(WIN_CHOW));
    const chow = () => screen.getByRole('button', { name: /^Chow: / });
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    expect(tilesOn(chow())).toBe(2);
    // 256 px in a 240 px dock (568x320, English, the largest text). The buttons are small already, so the first step is
    // Pass giving up its gloss.
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(256));
    expect(within(screen.getByTestId('claim-pass')).queryByText('Pass')).toBeNull();
    expect(within(screen.getByTestId('claim-win')).getByText('Win')).toBeOnTheScreen();
    expect(tilesOn(chow())).toBe(2);
    // Still wider: the Chow's tiles go (its spoken name keeps them), then Win's gloss.
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(248));
    expect(tilesOn(chow())).toBe(0);
    expect(chow().props.accessibilityLabel).toMatch(/^Chow: .+, .+$/);
    expect(within(screen.getByTestId('claim-win')).getByText('Win')).toBeOnTheScreen();
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(244));
    expect(within(screen.getByTestId('claim-win')).queryByText('Win')).toBeNull();
    // It fits now: no further step. The next prompt starts again from the row as drawn at first.
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(230));
    expect(within(screen.getByTestId('claim-win')).queryByText('Win')).toBeNull();
    await rerender(dock(WIN_CHOW, 20));
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    expect(within(screen.getByTestId('claim-win')).getByText('Win')).toBeOnTheScreen();
  });

  it('steps when the dock’s width comes after the row was laid out (the row’s own size does not change then)', async () => {
    const { rerender } = await render(<ActionBar actions={WIN_CHOW} act={() => {}} selected={null} hint={null} view={view(12)} compact wrap={false} smallFrom={2} />);
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(256));
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    await rerender(dock(WIN_CHOW));
    expect(within(screen.getByTestId('claim-pass')).queryByText('Pass')).toBeNull();
  });

  it('in Chinese, where the glosses are empty, goes straight to the claims without tiles', async () => {
    setLocalePreference('zh-TW');
    try {
      const four: Action[] = [{ type: 'pass' }, chi(4, 8), { type: 'pong' } as Action, { type: 'kong', tile: 13 } as Action];
      await render(dock(four));
      const claims = () => screen.getAllByRole('button').filter((b) => /^(吃|碰|槓)：/.test(b.props.accessibilityLabel));
      expect(claims().map(tilesOn)).toEqual([2, 1, 1]);
      await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(263));
      expect(claims().map(tilesOn)).toEqual([0, 0, 0]);
    } finally {
      setLocalePreference('auto');
    }
  });

  it('keeps a row that fits as it is, and a strip that may wrap never measures itself', async () => {
    await render(dock(WIN_CHOW, 12, 300));
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(256));
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
    await render(<ActionBar actions={WIN_CHOW} act={() => {}} selected={null} hint={null} view={view(12)} compact />);
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(400));
    expect(within(screen.getByTestId('claim-pass')).getByText('Pass')).toBeOnTheScreen();
  });

  it('draws a self-drawn Win 50 px tall, the dock’s height, never the 60 px it has where the row can grow', async () => {
    const selfDraw = { phase: 'discard', pending: null } as unknown as TableView;
    const shell = () => StyleSheet.flatten((screen.getByTestId('claim-win').children[0] as unknown as { props: { style: unknown } }).props.style as never) as { height: number };
    await render(<ActionBar actions={[{ type: 'hu' } as Action]} act={() => {}} selected={null} hint={null} view={selfDraw} compact wrap={false} smallFrom={2} maxWidth={240} />);
    expect(shell().height).toBe(50);
    await render(<ActionBar actions={[{ type: 'hu' } as Action]} act={() => {}} selected={null} hint={null} view={selfDraw} compact />);
    expect(shell().height).toBe(60);
  });
});

describe('the English glosses', () => {
  type Host = { type: unknown; props: { style?: unknown; children?: unknown }; children: Array<Host | string> };
  const colorsIn = (node: Host | string, out: { bgs: string[]; texts: Array<[string, string]> } = { bgs: [], texts: [] }) => {
    if (typeof node === 'string') return out;
    const st = (StyleSheet.flatten(node.props.style as never) ?? {}) as { backgroundColor?: string; color?: string };
    if (node.type === 'View' && st.backgroundColor) out.bgs.push(st.backgroundColor);
    const text = node.children.filter((c): c is string => typeof c === 'string').join('');
    if (node.type === 'Text' && st.color && text) out.texts.push([text, st.color]);
    node.children.forEach((c) => colorsIn(c, out));
    return out;
  };

  // The showcase review of 20 November: "Self-draw" pale yellow on yellow, "Kong" lavender on purple (white, then).
  it('keep 4.5:1 on their button: its fill and its top tone, which the gloss sits across', async () => {
    const all: Action[] = [{ type: 'pass' }, chi(4, 8), { type: 'pong' } as Action, { type: 'kong', tile: 12 } as Action, { type: 'hu' } as Action];
    const glosses = ['Pass', 'Chow', 'Pong', 'Kong', 'Win'];
    await render(<ActionBar actions={all} act={() => {}} selected={null} hint={null} view={view(12)} />);
    const selfDraw = { phase: 'discard', pending: null } as unknown as TableView;
    const seen: string[] = [];
    const low: string[] = [];
    const check = () => {
      for (const button of screen.getAllByRole('button')) {
        // The button's shelf, its fill, then its top tone (ActionBar's ClaimButton); the gloss is the small Text.
        const { bgs, texts } = colorsIn(button as unknown as Host);
        const [, fill, light] = bgs;
        for (const [text, color] of texts.filter(([x]) => glosses.includes(x) || x === 'Self-draw')) {
          seen.push(text);
          for (const bg of [fill, light]) if (contrast(color, bg) < 4.5) low.push(`${text} ${color} on ${bg}: ${contrast(color, bg).toFixed(2)}`);
        }
      }
    };
    check();
    await render(<ActionBar actions={[{ type: 'hu' } as Action, { type: 'kong', tile: 12 } as Action]} act={() => {}} selected={null} hint={null} view={selfDraw} />);
    check();
    expect(new Set(seen)).toEqual(new Set([...glosses, 'Self-draw']));
    expect(low).toEqual([]);
  });
});
