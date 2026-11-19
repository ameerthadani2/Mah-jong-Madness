import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { Action, TableView, TileId } from '@mjm/engine';
import { ActionBar } from './ActionBar';

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
    expect(screen.queryByTestId('claim-pass')).toBeNull();
    await fireEvent.press(screen.getByTestId('claim-chi-back'));
    expect(screen.getByTestId('claim-pass')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('claim-chi-open'));
    await fireEvent.press(within(screen.getByTestId('chi-choices')).getAllByRole('button', { name: /^Chow: / })[1]);
    expect(act).toHaveBeenCalledWith(chi(8, 16));
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
    // 256 px in a 240 px dock (568x320, English, the largest text): small already, then Pass gives up its gloss.
    await fireEvent(screen.getByTestId('claim-row'), 'layout', layout(256));
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
