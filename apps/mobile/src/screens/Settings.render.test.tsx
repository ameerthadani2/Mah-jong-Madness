import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { DEFAULT_RULES } from '@mjm/engine';
import { SettingsScreen } from './SettingsScreen';
import { FakeProviders } from '../test/providers';
import { DisplayScaleProvider, displayScale } from '../display/DisplayScale';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, type Settings } from '../storage';
import type { AppState } from '../app-state';

beforeEach(async () => {
  await AsyncStorage.clear();
});
afterEach(() => {
  displayScale.set({ tileScale: 1, textScale: 1 });
});

async function renderSettings(app: Partial<AppState> = {}) {
  const setSettings = jest.fn<(s: Settings) => void>();
  const go = jest.fn();
  await render(
    <DisplayScaleProvider>
      <FakeProviders app={{ setSettings, go, screen: { name: 'settings' }, ...app }}>
        <SettingsScreen />
      </FakeProviders>
    </DisplayScaleProvider>,
  );
  const last = () => setSettings.mock.calls[setSettings.mock.calls.length - 1][0];
  return { setSettings, go, last };
}

describe('Settings switches', () => {
  it('the sound switch turns sound effects off and says so', async () => {
    const { last } = await renderSettings();
    const sound = screen.getByRole('switch', { name: 'Sound effects and calls' });
    expect(sound).toBeChecked();
    await fireEvent.press(sound);
    expect(last()).toEqual({ ...DEFAULT_SETTINGS, sound: false });
    expect(screen.getByRole('switch', { name: 'Sound effects and calls' })).not.toBeChecked();
    // With sound off there is nothing to test.
    expect(screen.getByRole('button', { name: 'Test sound' })).toBeDisabled();
  });

  it('the coach switch changes the coach setting and nothing else', async () => {
    const { last } = await renderSettings();
    const coach = screen.getByRole('switch', { name: 'Show the coach at bot tables (never online)' });
    const before = DEFAULT_SETTINGS.coach;
    await fireEvent.press(coach);
    expect(last()).toEqual({ ...DEFAULT_SETTINGS, coach: !before });
    const after = screen.getByRole('switch', { name: 'Show the coach at bot tables (never online)' });
    if (before) expect(after).not.toBeChecked();
    else expect(after).toBeChecked();
  });

  it('a house-rule switch changes that rule, and Reset puts the defaults back', async () => {
    const { last } = await renderSettings();
    const draw = screen.getByRole('switch', { name: '流局連莊 a drawn hand keeps the dealer' });
    await fireEvent.press(draw);
    expect(last().rules).toEqual({ ...DEFAULT_RULES, drawKeepsDealer: !DEFAULT_RULES.drawKeepsDealer });
    await fireEvent.press(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(last().rules).toEqual(DEFAULT_RULES);
  });
});

describe('Settings language', () => {
  it('follows the device until a language is chosen, then saves the choice', async () => {
    const { last } = await renderSettings();
    expect(screen.getByRole('button', { name: 'Follow device' })).toBeSelected();
    await fireEvent.press(screen.getByRole('button', { name: '繁體中文' }));
    expect(last().locale).toBe('zh-TW');
    expect(screen.getByRole('button', { name: '繁體中文' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Follow device' })).not.toBeSelected();
  });
});

describe('Settings tile size', () => {
  it('saves the tile size and shows it chosen, leaving the text size alone', async () => {
    await renderSettings();
    const card = screen.getByTestId('display-settings');
    const [tilesNormal, textNormal] = within(card).getAllByRole('button', { name: 'Normal' });
    expect(tilesNormal).toBeSelected();
    const [tilesLarge] = within(card).getAllByRole('button', { name: 'Large' });
    await fireEvent.press(tilesLarge);
    expect(displayScale.get().tileScale).toBe(1.25);
    expect(displayScale.get().textScale).toBe(1);
    expect(within(card).getAllByRole('button', { name: 'Large' })[0]).toBeSelected();
    expect(textNormal).toBeSelected();
  });
});

describe('Settings bots and looks', () => {
  it('a free bot tier is chosen and described; Pro sends a player without Coach Gold to the Shop', async () => {
    const { last, go } = await renderSettings();
    await fireEvent.press(screen.getByRole('button', { name: 'Beginner' }));
    expect(last().botSkill).toBe('beginner');
    expect(screen.getByText('Makes efficiency mistakes and never folds. Good for learning the flow.')).toBeOnTheScreen();
    // A locked chip works (it opens the Shop), so it is announced as locked, not as disabled.
    const pro = screen.getByRole('button', { name: 'Pro, locked: opens the Shop' });
    expect(pro).toBeEnabled();
    await fireEvent.press(pro, { nativeEvent: {} });
    expect(go).toHaveBeenCalledWith({ name: 'shop' });
    expect(last().botSkill).toBe('beginner');
  });

  it('a free table look is chosen; a locked one opens the Shop instead', async () => {
    const { last, go } = await renderSettings();
    await fireEvent.press(screen.getByRole('button', { name: 'Midnight Blue' }));
    expect(last().tableTheme).toBe('midnight');
    expect(screen.getByRole('button', { name: 'Midnight Blue' })).toBeSelected();
    await fireEvent.press(screen.getByRole('button', { name: 'Night Market' }));
    expect(go).toHaveBeenCalledWith({ name: 'shop' });
    expect(last().tableTheme).toBe('midnight');
  });
});

describe('Settings profile', () => {
  it('says when the server refused the name, and keeps the typed name', async () => {
    const setProfile = jest.fn();
    await renderSettings({ profile: { ...DEFAULT_PROFILE, name: 'Badname', refusedName: 'Badname' }, setProfile });
    expect(screen.getByText('This name is not allowed. Please choose another one.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('profile-name'), 'Mei');
    expect(setProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mei' }));
    expect(screen.queryByText('This name is not allowed. Please choose another one.')).toBeNull();
  });
});
