import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const appJson = require('../../app.json') as { expo: Record<string, unknown> };
const build = require('../../app.config.js') as (a: { config: Record<string, unknown> }) => {
  plugins: Array<string | [string, Record<string, unknown>]>;
  ios: { privacyManifests: { NSPrivacyTracking: boolean; NSPrivacyAccessedAPITypes: Array<{ NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }>; NSPrivacyCollectedDataTypes: Array<{ NSPrivacyCollectedDataType: string; NSPrivacyCollectedDataTypeTracking: boolean; NSPrivacyCollectedDataTypeLinked: boolean; NSPrivacyCollectedDataTypePurposes: string[] }> } };
  android: { googleServicesFile?: string };
  extra: { storeUrls: { ios?: string; android: string } };
};

const KEYS = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'APP_STORE_ID', 'GOOGLE_SERVICES_JSON', 'APP_BUNDLE_ID', 'EXPO_PUBLIC_LINK_DOMAIN'];
const config = () => build({ config: structuredClone(appJson.expo) });
const pluginNames = (c: ReturnType<typeof build>) => c.plugins.map((p) => (Array.isArray(p) ? p[0] : p));

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('app.config.js (telemetry and push)', () => {
  it('always adds the notifications plugin and the privacy manifest', () => {
    const c = config();
    expect(pluginNames(c)).toContain('expo-notifications');
    const pm = c.ios.privacyManifests;
    expect(pm.NSPrivacyTracking).toBe(false);
    expect(pm.NSPrivacyAccessedAPITypes.map((a) => a.NSPrivacyAccessedAPIType)).toEqual(['NSPrivacyAccessedAPICategoryUserDefaults', 'NSPrivacyAccessedAPICategoryFileTimestamp']);
    expect(pm.NSPrivacyAccessedAPITypes.every((a) => a.NSPrivacyAccessedAPITypeReasons.length > 0)).toBe(true);
    expect(pm.NSPrivacyCollectedDataTypes.map((d) => d.NSPrivacyCollectedDataType)).toEqual(expect.arrayContaining(['NSPrivacyCollectedDataTypeProductInteraction', 'NSPrivacyCollectedDataTypeCrashData', 'NSPrivacyCollectedDataTypeUserID']));
    expect(pm.NSPrivacyCollectedDataTypes.every((d) => d.NSPrivacyCollectedDataTypeTracking === false)).toBe(true);
  });

  it('declares the stored user content: the display name and the free text of a player report, linked to the account', () => {
    const types = config().ios.privacyManifests.NSPrivacyCollectedDataTypes;
    const byType = Object.fromEntries(types.map((d) => [d.NSPrivacyCollectedDataType, d]));
    for (const type of ['NSPrivacyCollectedDataTypeOtherUserContent', 'NSPrivacyCollectedDataTypeName']) {
      expect(byType[type], type).toBeDefined();
      expect(byType[type].NSPrivacyCollectedDataTypeLinked, type).toBe(true);
      expect(byType[type].NSPrivacyCollectedDataTypePurposes, type).toEqual(['NSPrivacyCollectedDataTypePurposeAppFunctionality']);
    }
  });

  it('adds the Sentry plugin only with a full upload configuration, and never writes the token', () => {
    expect(pluginNames(config())).not.toContain('@sentry/react-native/expo');
    process.env.SENTRY_AUTH_TOKEN = 'sntrys_secret';
    process.env.SENTRY_ORG = 'acme';
    expect(pluginNames(config())).not.toContain('@sentry/react-native/expo');
    process.env.SENTRY_PROJECT = 'mahjong';
    const c = config();
    expect(c.plugins).toContainEqual(['@sentry/react-native/expo', { organization: 'acme', project: 'mahjong', url: 'https://sentry.io/' }]);
    expect(JSON.stringify(c)).not.toContain('sntrys_secret');
  });

  it('builds the store links and the FCM file from env', () => {
    expect(config().extra.storeUrls).toEqual({ android: 'https://play.google.com/store/apps/details?id=com.mahjongmania.app' });
    process.env.APP_STORE_ID = '6400000000';
    process.env.GOOGLE_SERVICES_JSON = '/tmp/google-services.json';
    const c = config();
    expect(c.extra.storeUrls.ios).toBe('https://apps.apple.com/app/id6400000000');
    expect(c.android.googleServicesFile).toBe('/tmp/google-services.json');
  });

  it('names the app Mahjong Mania with the mahjongmania scheme and slug by default', () => {
    const c = build({ config: structuredClone(appJson.expo) }) as unknown as { name: string; slug: string; scheme: string; ios: { bundleIdentifier: string } };
    expect([c.name, c.slug, c.scheme, c.ios.bundleIdentifier]).toEqual(['Mahjong Mania', 'mahjongmania', 'mahjongmania', 'com.mahjongmania.app']);
    expect(appJson.expo).toMatchObject({ name: 'Mahjong Mania', slug: 'mahjongmania', scheme: 'mahjongmania' });
  });

  it('declares the birth year and the gameplay content the account keeps', () => {
    const byType = Object.fromEntries(config().ios.privacyManifests.NSPrivacyCollectedDataTypes.map((d) => [d.NSPrivacyCollectedDataType, d]));
    for (const type of ['NSPrivacyCollectedDataTypeOtherDataTypes', 'NSPrivacyCollectedDataTypeGameplayContent']) {
      expect(byType[type], type).toMatchObject({ NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] });
    }
  });

  it('opens shared table links on the link domain as universal links and app links', () => {
    const plain = build({ config: structuredClone(appJson.expo) }) as unknown as { ios: Record<string, unknown>; android: Record<string, unknown> };
    expect(plain.ios.associatedDomains).toBeUndefined();
    process.env.EXPO_PUBLIC_LINK_DOMAIN = 'https://play.example.com/';
    const c = build({ config: structuredClone(appJson.expo) }) as unknown as { ios: { associatedDomains: string[] }; android: { intentFilters: Array<{ data: Array<{ host: string; pathPrefix: string }> }> } };
    expect(c.ios.associatedDomains).toEqual(['applinks:play.example.com']);
    expect(c.android.intentFilters[0].data).toEqual([
      { scheme: 'https', host: 'play.example.com', pathPrefix: '/t/' },
      { scheme: 'https', host: 'play.example.com', pathPrefix: '/c/' },
    ]);
  });
});
