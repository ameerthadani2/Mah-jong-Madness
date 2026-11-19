import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { Action, TableView, TileId } from '@mjm/engine';
import { ActionBar } from './ActionBar';

/**
 * A phone's portrait claim strip (`compact`) keeps to one row, so it never takes height from the felt: three or more
 * buttons are drawn small with the English gloss on Pass only, and several 吃 choices are one 吃 button that opens them.
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

  it('keeps every 吃 choice and every gloss where the strip is not a phone’s (tablets, landscape)', async () => {
    await render(<ActionBar actions={CLAIMS} act={() => {}} selected={null} hint={null} view={view(12)} />);
    expect(screen.getAllByRole('button', { name: /^Chow: \d/ })).toHaveLength(2);
    expect(within(screen.getByRole('button', { name: /^Pong: / })).getByText('Pong')).toBeOnTheScreen();
    expect(screen.queryByTestId('claim-chi-open')).toBeNull();
  });
});
