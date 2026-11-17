import '../test/mockStore';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ShopScreen } from './ShopScreen';
import { FakeProviders } from '../test/providers';

beforeEach(async () => {
  // An adult who answered the age gate (the Shop asks before it shows anything for sale).
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderShop() {
  await render(
    <FakeProviders app={{ screen: { name: 'shop' } }}>
      <ShopScreen />
    </FakeProviders>,
  );
}

describe('the Shop', () => {
  it('says first what money can and cannot buy', async () => {
    await renderShop();
    const promise = await screen.findByText('Looks, coaching and club ownership only. Nothing here changes the tiles you draw, and joining clubs is free.');
    expect(promise).toBeOnTheScreen();
    // Shown whole: a line limit would cut "joining clubs is free" off on a phone.
    expect(promise.props.numberOfLines).toBeUndefined();
    expect(screen.getByText('Diamonds and points have no monetary value and cannot be redeemed or transferred.')).toBeOnTheScreen();
  });

  it('shows each look’s description whole, never cut mid-sentence', async () => {
    await renderShop();
    fireEvent.press(await screen.findByTestId('shop-tab-looks'));
    const line = await screen.findByText(/Deep jade felt, walnut rail with gold stud/);
    // The whole sentence is there and no line limit cuts it on a narrow card.
    expect(line.props.children).toMatch(/Deep jade felt, walnut rail with gold stud[^.]*\./);
    expect(line.props.numberOfLines).toBeUndefined();
    for (const el of screen.getAllByText(/ · /)) expect(el.props.numberOfLines).toBeUndefined();
  });

  it('lists the diamond packs with the store price on each buy button', async () => {
    await renderShop();
    expect(await screen.findByText('A small top-up.')).toBeOnTheScreen();
    expect(screen.getByText('1,200 plus 100 bonus.')).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: '$0.99' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '$4.99' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '$99.99' })).toBeEnabled();
  });

  it('says what a purchase did in a line a screen reader speaks', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const said = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    await renderShop();
    await fireEvent.press(await screen.findByRole('button', { name: '$0.99' }));
    const line = await screen.findByTestId('shop-message');
    expect(line.props.accessibilityLiveRegion).toMatch(/^(polite|assertive)$/);
    const text = String(within(line).getByText(/\S/).props.children);
    expect(text).not.toBe('');
    // iOS ignores live regions: the same words are announced.
    expect(said).toHaveBeenCalledWith(text);
  });

  it('shows each plan with its price per month or year', async () => {
    await renderShop();
    await fireEvent.press(await screen.findByRole('tab', { name: 'Plans' }));
    expect(screen.getByRole('tab', { name: 'Plans' })).toBeSelected();
    expect(screen.getByText('Coach Gold')).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: '$6.99/mo' })).toBeEnabled();
  });
});
