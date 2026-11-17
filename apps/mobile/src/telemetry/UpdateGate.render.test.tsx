import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Linking, Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MaintenanceBanner, UpdateRequired } from './UpdateGate';
import { STORE_URLS } from '../config';
import { setLocalePreference } from '../i18n';

const realOS = Platform.OS;
function onPlatform(os: 'ios' | 'android' | 'web') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
}

afterEach(() => {
  onPlatform(realOS as 'ios');
  setLocalePreference('auto');
  jest.restoreAllMocks();
});

describe('the update gate', () => {
  it('blocks a build the server no longer serves and opens the App Store on an iPhone', async () => {
    onPlatform('ios');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await render(<UpdateRequired />);
    expect(screen.getByText('Update required')).toBeOnTheScreen();
    expect(screen.getByText(/^This version of the app no longer works with the game server\./)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Open the App Store' }));
    expect(open).toHaveBeenCalledWith(STORE_URLS.ios);
    expect(screen.queryByRole('button', { name: 'Open Google Play' })).toBeNull();
  });

  it('opens Google Play on Android, and stays put when the store cannot be opened', async () => {
    onPlatform('android');
    const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no store app'));
    await render(<UpdateRequired />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open Google Play' }));
    expect(open).toHaveBeenCalledWith(STORE_URLS.android);
    expect(screen.getByTestId('update-required')).toBeOnTheScreen();
  });

  it('offers no store button where there is no store (the web build)', async () => {
    onPlatform('web');
    await render(<UpdateRequired />);
    expect(screen.getByText('Update required')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the maintenance message as an alert', async () => {
    await render(<MaintenanceBanner message="Back at 18:00 Taipei time." />);
    const banner = screen.getByTestId('maintenance-banner');
    expect(banner).toHaveProp('accessibilityRole', 'alert');
    expect(banner).toHaveTextContent('Server notice: Back at 18:00 Taipei time.');
  });

  it('speaks Traditional Chinese', async () => {
    setLocalePreference('zh-TW');
    onPlatform('ios');
    await render(<UpdateRequired />);
    expect(screen.getByText('需要更新')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '前往 App Store' })).toBeOnTheScreen();
    await render(<MaintenanceBanner message="18:00 恢復。" />);
    expect(screen.getByTestId('maintenance-banner')).toHaveTextContent('伺服器公告： 18:00 恢復。');
  });
});
