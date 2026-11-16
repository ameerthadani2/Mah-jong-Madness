import '../test/mockStore';
import { beforeEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ShopScreen } from './ShopScreen';
import { FakeProviders } from '../test/providers';

beforeEach(async () => {
  // An adult who answered the age gate (the Shop asks before it shows anything for sale).
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
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

  it('lists the diamond packs with the store price on each buy button', async () => {
    await renderShop();
    expect(await screen.findByText('A small top-up.')).toBeOnTheScreen();
    expect(screen.getByText('1,200 plus 100 bonus.')).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: '$0.99' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '$4.99' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '$99.99' })).toBeEnabled();
  });

  it('shows each plan with its price per month or year', async () => {
    await renderShop();
    await fireEvent.press(await screen.findByRole('tab', { name: 'Plans' }));
    expect(screen.getByRole('tab', { name: 'Plans' })).toBeSelected();
    expect(screen.getByText('Coach Gold')).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: '$6.99/mo' })).toBeEnabled();
  });
});
