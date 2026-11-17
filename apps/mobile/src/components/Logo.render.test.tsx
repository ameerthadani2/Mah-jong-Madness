import { afterEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { setLocalePreference } from '../i18n';
import zhCommon from '../i18n/locales/zh-TW/common.json';
import { APP_NAME } from '../config';
import { Logo, localWordmark } from './Logo';

describe('the wordmark', () => {
  afterEach(() => setLocalePreference('auto'));

  it('reads the configured name in English, in two lines', async () => {
    setLocalePreference('en');
    await render(<Logo />);
    expect(screen.queryAllByText('MAHJONG').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('MANIA').length).toBeGreaterThan(0);
    expect(screen.queryAllByText(zhCommon.appName)).toHaveLength(0);
  });

  it('reads the Chinese app name on a Traditional Chinese device, with the English name small beneath', async () => {
    setLocalePreference('zh-TW');
    await render(<Logo />);
    // From the locale's common.appName, not a literal in the component.
    expect(zhCommon.appName).toBe('麻將狂熱');
    expect(screen.queryAllByText(zhCommon.appName).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(APP_NAME.toUpperCase()).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('MAHJONG')).toHaveLength(0);
  });

  it('falls back to the configured name where the locale has none of its own', () => {
    expect(localWordmark('Mahjong Mania', 'Mahjong Mania')).toEqual({ lines: ['MAHJONG', 'MANIA'], local: false });
    expect(localWordmark('Mahjong Mania', '')).toEqual({ lines: ['MAHJONG', 'MANIA'], local: false });
    expect(localWordmark('Mahjong Mania', '麻將狂熱')).toEqual({ lines: ['麻將狂熱', 'MAHJONG MANIA'], local: true });
  });
});
