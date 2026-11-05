import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { googleClientIdFor, readGoogleClientIds, visibleProviders } from './auth-config';

const require = createRequire(import.meta.url);
const appConfig = require('../../app.config.js') as (ctx: { config: Record<string, unknown> }) => { extra: Record<string, unknown>; scheme: unknown; ios: Record<string, unknown> };

const ENV_KEYS = ['EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('Google client ids', () => {
  it('app.config.js exposes the EXPO_PUBLIC_GOOGLE_* ids under extra and the reader picks the platform’s', () => {
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = ' 123-ios.apps.googleusercontent.com ';
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = '123-web.apps.googleusercontent.com';
    const cfg = appConfig({ config: {} });
    const ids = readGoogleClientIds(cfg.extra);
    expect(ids).toEqual({ ios: '123-ios.apps.googleusercontent.com', web: '123-web.apps.googleusercontent.com' });
    expect(googleClientIdFor(ids, 'ios')).toBe('123-ios.apps.googleusercontent.com');
    expect(googleClientIdFor(ids, 'android')).toBeUndefined();
    expect(googleClientIdFor(ids, 'web')).toBe('123-web.apps.googleusercontent.com');
  });

  it('with no env the build carries no ids and Sign in with Apple is still declared for iOS', () => {
    const cfg = appConfig({ config: {} });
    expect(cfg.extra.googleClientIds).toBeUndefined();
    expect(readGoogleClientIds(cfg.extra)).toEqual({});
    expect(cfg.ios.usesAppleSignIn).toBe(true);
  });

  it('ignores malformed extras', () => {
    expect(readGoogleClientIds(undefined)).toEqual({});
    expect(readGoogleClientIds({ googleClientIds: 'x' })).toEqual({});
    expect(readGoogleClientIds({ googleClientIds: { ios: 4, web: '' } })).toEqual({});
  });
});

describe('visibleProviders', () => {
  it('shows a provider only when the server enables it and this device can use it', () => {
    expect(visibleProviders({ serverProviders: ['apple', 'google'], appleAvailable: true, googleClientId: 'id' })).toEqual(['apple', 'google']);
    expect(visibleProviders({ serverProviders: ['apple', 'google'], appleAvailable: false, googleClientId: 'id' })).toEqual(['google']);
    expect(visibleProviders({ serverProviders: ['apple', 'google'], appleAvailable: true, googleClientId: undefined })).toEqual(['apple']);
    expect(visibleProviders({ serverProviders: ['google', 'facebook'], appleAvailable: true, googleClientId: 'id' })).toEqual(['google']);
  });

  it('shows nothing without a server answer', () => {
    expect(visibleProviders({ serverProviders: null, appleAvailable: true, googleClientId: 'id' })).toEqual([]);
  });
});
