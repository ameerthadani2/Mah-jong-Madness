/**
 * Release build configuration: the Android package and version from app.config.js, and the EAS
 * profiles in eas.json that build for the Play internal testing track and TestFlight.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const appJson = require('../../app.json') as { expo: Record<string, unknown> & { version: string } };
const eas = require('../../eas.json') as {
  cli: { appVersionSource: string };
  build: Record<string, { autoIncrement?: boolean; distribution?: string; channel?: string; environment?: string; android?: { buildType?: string }; ios?: Record<string, unknown> }>;
  submit: Record<string, { ios?: Record<string, string>; android?: { serviceAccountKeyPath: string; track: string; releaseStatus: string } }>;
};
type Built = { version: string; ios: { bundleIdentifier: string }; android: { package: string }; extra: { storeUrls: { android: string } } };
const build = require('../../app.config.js') as (a: { config: Record<string, unknown> }) => Built;
const config = () => build({ config: structuredClone(appJson.expo) });

afterEach(() => {
  delete process.env.APP_BUNDLE_ID;
  delete process.env.APP_VERSION;
});

describe('Android release identity (app.config.js)', () => {
  it('uses APP_BUNDLE_ID as the Android package and the Play link, with com.mahjongmania.app by default', () => {
    expect(config().android.package).toBe('com.mahjongmania.app');
    process.env.APP_BUNDLE_ID = 'tw.example.mahjong_mania';
    const c = config();
    expect([c.ios.bundleIdentifier, c.android.package]).toEqual(['tw.example.mahjong_mania', 'tw.example.mahjong_mania']);
    expect(c.extra.storeUrls.android).toBe('https://play.google.com/store/apps/details?id=tw.example.mahjong_mania');
  });

  it('stops the build with a clear message for an id Android cannot use as a package', () => {
    for (const bad of ['com.mahjong-mania.app', 'mahjongmania', 'com.1mahjong.app', 'com..app']) {
      process.env.APP_BUNDLE_ID = bad;
      expect(() => config(), bad).toThrow(/cannot be the Android package/);
    }
  });

  it('takes the version players see from APP_VERSION, defaulting to app.json, and refuses a malformed one', () => {
    expect(config().version).toBe(appJson.expo.version);
    process.env.APP_VERSION = '1.2.0';
    expect(config().version).toBe('1.2.0');
    process.env.APP_VERSION = 'v1.2-beta';
    expect(() => config()).toThrow(/APP_VERSION 'v1.2-beta'/);
  });
});

describe('EAS profiles (eas.json)', () => {
  it('keeps build numbers on the EAS servers and raises them on every production build', () => {
    expect(eas.cli.appVersionSource).toBe('remote');
    expect(eas.build.production.autoIncrement).toBe(true);
  });

  it('builds a Play app bundle in production and an installable APK in preview', () => {
    expect(eas.build.production.android?.buildType).toBe('app-bundle');
    expect(eas.build.preview.android?.buildType).toBe('apk');
    expect(eas.build.preview.distribution).toBe('internal');
  });

  it('submits production builds to the Play internal testing track as a draft release, with the key the workflow writes', () => {
    expect(eas.submit.production.android).toEqual({ serviceAccountKeyPath: './google-play-service-account.json', track: 'internal', releaseStatus: 'draft' });
  });

  it('leaves the iOS build and TestFlight submission as they were', () => {
    expect(eas.build.production.ios).toBeUndefined();
    expect(eas.build.simulator.ios).toEqual({ simulator: true });
    for (const profile of ['production', 'preview']) {
      expect(eas.submit[profile].ios).toEqual({ ascApiKeyPath: '$EXPO_ASC_API_KEY_PATH', ascApiKeyId: '$EXPO_ASC_KEY_ID', ascApiKeyIssuerId: '$EXPO_ASC_ISSUER_ID', appleTeamId: '$EXPO_APPLE_TEAM_ID' });
    }
    expect(eas.build.production.channel).toBe('production');
  });
});

describe('over-the-air updates (app.json)', () => {
  const runtime = () => (config() as unknown as { runtimeVersion?: unknown; updates?: { enabled?: boolean } });

  it('tie an update to the native build it was made for: the runtime version is a fingerprint of the native inputs', () => {
    // 'sdkVersion' would hand a JavaScript update to any binary on the same Expo SDK, whatever native modules,
    // permissions or entitlements that binary was built with.
    expect(appJson.expo.runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect((appJson.expo.updates as { enabled?: boolean }).enabled).toBe(true);
  });

  it('app.config.js passes the policy through unchanged, whatever the build environment', () => {
    expect(runtime().runtimeVersion).toEqual({ policy: 'fingerprint' });
    process.env.APP_VERSION = '2.0.0';
    process.env.APP_BUNDLE_ID = 'tw.example.mahjong_mania';
    expect(runtime().runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect(runtime().updates?.enabled).toBe(true);
  });

  it('needs no extra package: the fingerprint tooling ships with expo', () => {
    expect(() => require.resolve('expo/fingerprint')).not.toThrow();
    expect(() => require.resolve('expo-updates/package.json')).not.toThrow();
  });
});
