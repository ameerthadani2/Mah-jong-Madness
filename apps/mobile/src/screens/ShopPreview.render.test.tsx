import '../test/mockStore';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { ShopScreen } from './ShopScreen';
import { FakeProviders } from '../test/providers';
import type { AuthClient } from '../auth/client';
import type { Settings } from '../storage';
import { setLocalePreference } from '../i18n';

// The system "reduce motion" setting, switched per test.
let mockReduced = false;
jest.mock('../display/reducedMotion', () => ({ useReducedMotion: () => mockReduced, reducedMotionNow: () => mockReduced }));

/**
 * A guest with a server session whose wallet the fake server keeps: GET /api/me reads it, and POST /api/wallet/spend
 * (globalThis.fetch) debits it and grants the look, as the real server does.
 */
function fakeServer(start: { diamonds: number; cosmetics: string[] }) {
  const state = { ...start, cosmetics: [...start.cosmetics] };
  const spends: string[] = [];
  const me = async () => ({ user: { id: 'u-1' }, wallet: { diamonds: state.diamonds, bonusDiamonds: 0 }, entitlements: [], cosmetics: [...state.cosmetics], serverNow: new Date().toISOString() });
  const snap = { status: 'guest', userId: 'u-1', displayName: null, kind: 'guest', hasSession: true, banned: false };
  const client = { snapshot: () => snap, subscribe: () => () => undefined, token: async () => 'test-token', onUnauthorised: async () => undefined, ensureSession: async () => 'u-1', getMe: me } as unknown as AuthClient;
  const fetchMock = jest.fn(async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { productId: string };
    spends.push(`${String(url).replace(/^https?:\/\/[^/]+/, '')} ${body.productId}`);
    const unlock = body.productId.startsWith('theme.') ? body.productId.slice('theme.'.length) : body.productId;
    state.cosmetics.push(unlock);
    state.diamonds -= 100;
    return new Response(JSON.stringify({ spent: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { client, fetchMock, spends };
}

const realFetch = globalThis.fetch;
beforeEach(async () => {
  mockReduced = false;
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setLocalePreference('auto');
});

async function openLooks(server = fakeServer({ diamonds: 2000, cosmetics: [] }), setSettings?: (s: Settings) => void) {
  globalThis.fetch = server.fetchMock as unknown as typeof fetch;
  await render(
    <FakeProviders app={{ screen: { name: 'shop' }, setSettings }} auth={{ status: 'guest', client: server.client, user: { id: 'u-1' } as never }}>
      <ShopScreen />
    </FakeProviders>,
  );
  await fireEvent.press(await screen.findByTestId('shop-tab-looks'));
  await screen.findByTestId('product-theme.jade');
  return server;
}

/** The open preview: a modal dialog named for the look (role and name as the web and screen readers get them). */
async function dialogFor(name: string) {
  const dialog = await screen.findByTestId('look-preview');
  expect(dialog.props.role).toBe('dialog');
  expect(dialog.props['aria-modal']).toBe(true);
  expect(dialog.props['aria-label']).toBe(name);
  expect(dialog.props.accessibilityViewIsModal).toBe(true);
  return dialog;
}

const shelf = async (name: string) => fireEvent.press(screen.getByRole('button', { name }));

describe('the Shop try-on preview', () => {
  it('shows a table look on a small table with tiles and ponds, with its price and a Buy button', async () => {
    await openLooks();
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Jade Parlour table' }));
    const dialog = await dialogFor('Preview: Jade Parlour table');
    expect(within(dialog).getByRole('header', { name: 'Jade Parlour table' })).toBeOnTheScreen();
    // The look's own felt, with a hand of tiles, ponds of discards and the other seats' backs.
    expect(within(dialog).getByTestId('preview-felt-jade')).toBeOnTheScreen();
    expect(within(dialog).getAllByTestId('preview-pond')).toHaveLength(2);
    expect(within(dialog).getAllByTestId(/^tile-/).length).toBeGreaterThanOrEqual(12);
    expect(within(dialog).getByRole('button', { name: 'Buy for 400 diamonds' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Close preview' })).toBeOnTheScreen();
    // The scrim behind the sheet closes it on a tap but is no second button for a screen reader, and no focus stop:
    // React Native Web's focus trap moves focus to anything that will take it, a tabindex of -1 included.
    expect(screen.getAllByRole('button', { name: 'Close preview' })).toHaveLength(1);
    const scrim = screen.getByTestId('preview-scrim', { includeHiddenElements: true });
    expect(scrim.props['aria-hidden']).toBe(true);
    expect(scrim.props.tabIndex).toBeUndefined();
    expect(scrim.props.focusable).toBeUndefined();
    expect(scrim.props.accessibilityRole).toBeUndefined();
  });

  it('buys from the preview through the same purchase as the card, then offers to put the look on', async () => {
    const settings: Settings[] = [];
    const server = await openLooks(undefined, (s) => settings.push(s));
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Jade Parlour table' }));
    const dialog = await dialogFor('Preview: Jade Parlour table');
    await act(async () => fireEvent.press(within(dialog).getByRole('button', { name: 'Buy for 400 diamonds' })));
    // One spend on the server, the card's own request; the look goes straight on, as from the card.
    await waitFor(() => expect(server.spends).toEqual(['/api/wallet/spend theme.jade']));
    await waitFor(() => expect(within(dialog).getByText('Owned')).toBeOnTheScreen());
    expect(settings.at(-1)?.tableTheme).toBe('jade');
    expect(within(dialog).getByText('Unlocked Jade Parlour table')).toBeOnTheScreen();
    expect(within(dialog).queryByRole('button', { name: /^Buy for/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'In use' })).toBeDisabled();
  });

  it('shows an owned look with Equip instead of a price, and Equip puts it on', async () => {
    const settings: Settings[] = [];
    await openLooks(fakeServer({ diamonds: 0, cosmetics: ['back.lotus'] }), (s) => settings.push(s));
    await shelf('Tile backs');
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Lotus Pond tile back' }));
    const dialog = await dialogFor('Preview: Lotus Pond tile back');
    // A row of backs on the felt, as at the table: every one in the Lotus design.
    const backs = within(dialog).getAllByTestId('preview-back-back.lotus');
    expect(backs.length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(within(dialog).getByText('Owned')).toBeOnTheScreen());
    expect(within(dialog).queryByRole('button', { name: /^Buy for/ })).toBeNull();
    await fireEvent.press(within(dialog).getByRole('button', { name: 'Equip' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'In use' })).toBeDisabled());
  });

  it('puts an avatar frame on the player’s own avatar', async () => {
    await openLooks();
    await shelf('Frames');
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Jade Bangle frame' }));
    const dialog = await dialogFor('Preview: Jade Bangle frame');
    const plate = within(dialog).getByTestId('preview-avatar');
    expect(plate.props.accessibilityLabel).toBe('Your avatar in the Jade Bangle frame');
    expect(within(dialog).getByTestId('preview-frame-frame.jade')).toBeOnTheScreen();
  });

  it('plays each emote of a pack when it is tapped', async () => {
    await openLooks();
    await shelf('Emotes');
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Tea House emotes' }));
    const dialog = await dialogFor('Preview: Tea House emotes');
    const buttons = within(dialog).getAllByRole('button', { name: /^Play / });
    expect(buttons).toHaveLength(6);
    expect(within(dialog).queryByTestId('preview-emote-bubble')).toBeNull();
    await fireEvent.press(within(dialog).getByRole('button', { name: 'Play Dumpling' }));
    expect(within(dialog).getByTestId('preview-emote-bubble').props.accessibilityLabel).toBe('Dumpling');
    await fireEvent.press(within(dialog).getByRole('button', { name: 'Play Mooncake' }));
    expect(within(dialog).getByTestId('preview-emote-bubble').props.accessibilityLabel).toBe('Mooncake');
  });

  it('plays a win celebration once, with a button to play it again', async () => {
    await openLooks();
    await shelf('Wins');
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Sky Lanterns win' }));
    const dialog = await dialogFor('Preview: Sky Lanterns win');
    expect(within(dialog).getByTestId('preview-celebration-1')).toBeOnTheScreen();
    expect(within(dialog).getByTestId('win-celebration', { includeHiddenElements: true })).toBeOnTheScreen();
    await fireEvent.press(within(dialog).getByRole('button', { name: 'Play again' }));
    // Played afresh: a new run of the overlay, not the old one left at its end.
    expect(within(dialog).getByTestId('preview-celebration-2')).toBeOnTheScreen();
    expect(within(dialog).queryByTestId('preview-celebration-still')).toBeNull();
  });

  it('describes a win celebration instead of playing it when motion is reduced', async () => {
    mockReduced = true;
    await openLooks();
    await shelf('Wins');
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Sky Lanterns win' }));
    const dialog = await dialogFor('Preview: Sky Lanterns win');
    expect(within(dialog).getByTestId('preview-celebration-still')).toHaveTextContent(/Four sky lanterns rise from the table/);
    expect(within(dialog).queryByRole('button', { name: 'Play again' })).toBeNull();
  });

  it('shows what a set holds, on its own table with its own backs', async () => {
    await openLooks();
    await shelf('Sets');
    await fireEvent.press(await screen.findByRole('button', { name: 'Try on Dragon set' }));
    const dialog = await dialogFor('Preview: Dragon set');
    expect(within(dialog).getByTestId('preview-felt-dragonscale')).toBeOnTheScreen();
    expect(within(dialog).getAllByTestId('preview-back-back.dragon').length).toBeGreaterThanOrEqual(8);
    for (const item of ['Dragon Scale table', 'Dragon Scale tile back', 'Jade Dragon frame', 'Zodiac emotes', 'Dragon Dance win']) expect(within(dialog).getByText(item)).toBeOnTheScreen();
    expect(within(dialog).getByRole('button', { name: /^Buy for [\d,]+ diamonds$/ })).toBeEnabled();
  });

  it('closes on its Close button and gives focus back to the card that opened it', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => undefined);
    await openLooks();
    const opener = await screen.findByRole('button', { name: 'Try on Jade Parlour table' });
    await fireEvent.press(opener);
    const dialog = await dialogFor('Preview: Jade Parlour table');
    await fireEvent.press(within(dialog).getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(screen.queryByTestId('look-preview')).toBeNull());
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    // To the picture of the card that opened it, which the screen reader then reads.
    const [target, event] = focus.mock.calls[0] as [{ props?: { testID?: string } }, string];
    expect(event).toBe('focus');
    expect(target.props?.testID).toBe('preview-theme.jade');
    focus.mockRestore();
  });

  it('speaks Traditional Chinese', async () => {
    setLocalePreference('zh-TW');
    await openLooks();
    await fireEvent.press(await screen.findByRole('button', { name: '試用 翡翠廳桌布' }));
    const dialog = await dialogFor('預覽：翡翠廳桌布');
    expect(within(dialog).getByRole('button', { name: '以 400 鑽石購買' })).toBeOnTheScreen();
    expect(within(dialog).getByRole('button', { name: '關閉預覽' })).toBeOnTheScreen();
  });
});
