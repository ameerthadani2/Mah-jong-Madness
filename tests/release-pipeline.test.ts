/**
 * The release pipeline's configuration, checked the way the tools that read it behave:
 * - apps/mobile/eas.json's submit profiles, resolved by the rules of the EAS command line (and by
 *   its own resolver when that package happens to be installed);
 * - the steps of the build workflows that decide whether a run may start, run as shell scripts
 *   with stand-in values.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, runStep, workflowStepScript } from './workflow-steps.js';

const require = createRequire(import.meta.url);
const EAS_JSON = join(ROOT, 'apps/mobile/eas.json');

type Platform = 'ios' | 'android';
type SubmitProfile = { extends?: string; ios?: Record<string, unknown>; android?: Record<string, unknown> };
type EasJson = { build: Record<string, { env?: Record<string, string> }>; submit?: Record<string, SubmitProfile> };
const readEas = (): EasJson => JSON.parse(readFileSync(EAS_JSON, 'utf8')) as EasJson;

/** A workflow file as GitHub reads it: parsed as YAML, so a step is its fields rather than lines of text. */
type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };
const { load } = require('js-yaml') as { load(text: string): unknown };
const workflow = (file: string): Workflow => load(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as Workflow;
const { applyBuildEnv } = require(join(ROOT, '.github/scripts/eas-build-env.cjs')) as { applyBuildEnv: (eas: EasJson, env: Record<string, string | undefined>) => EasJson };

/** What ios-testflight.yml exports before `eas build --auto-submit` (stand-in values of the real shapes). */
const WORKFLOW_ENV: Record<string, string> = {
  EXPO_ASC_API_KEY_PATH: '/tmp/AuthKey.p8',
  EXPO_ASC_KEY_ID: 'ABCDE12345',
  EXPO_ASC_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
  EXPO_APPLE_TEAM_ID: 'AB32CZE81F',
};

// The rules of the EAS command line's submit-profile resolver (eas-json, build/submit): a profile is
// its `extends` chain merged; only the fields below are expanded from the environment ("$NAME" or
// "${NAME}", an unset name becoming ""); the result must then match the resolved schema, where a
// string may not be empty, unknown keys are refused and several fields have a fixed shape.
const EXPANDED: Record<Platform, string[]> = { ios: ['ascApiKeyPath', 'ascApiKeyIssuerId', 'ascApiKeyId'], android: ['serviceAccountKeyPath'] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHAPES: Record<Platform, Record<string, (v: unknown) => boolean>> = {
  ios: {
    ascApiKeyPath: (v) => typeof v === 'string',
    ascApiKeyId: (v) => typeof v === 'string' && /^[\dA-Z]+$/.test(v) && v.length <= 30,
    ascApiKeyIssuerId: (v) => typeof v === 'string' && UUID.test(v),
    appleId: (v) => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
    ascAppId: (v) => typeof v === 'string' && /^\d+$/.test(v) && v.length <= 30,
    appleTeamId: (v) => typeof v === 'string' && /^[\dA-Z]{10}$/.test(v),
    sku: (v) => typeof v === 'string',
    language: (v) => typeof v === 'string',
    companyName: (v) => typeof v === 'string',
    appName: (v) => typeof v === 'string',
    bundleIdentifier: (v) => typeof v === 'string',
    metadataPath: (v) => typeof v === 'string',
    groups: (v) => Array.isArray(v) && v.every((g) => typeof g === 'string' && g !== ''),
  },
  android: {
    serviceAccountKeyPath: (v) => typeof v === 'string',
    track: (v) => typeof v === 'string',
    releaseStatus: (v) => typeof v === 'string' && ['completed', 'draft', 'halted', 'inProgress'].includes(v),
    changesNotSentForReview: (v) => typeof v === 'boolean',
    applicationId: (v) => typeof v === 'string',
    rollout: (v) => typeof v === 'number' && v > 0 && v <= 1,
  },
};

function mergedProfile(eas: EasJson, platform: Platform, name: string, depth = 0): Record<string, unknown> {
  if (depth >= 5) throw new Error('too long a chain of "extends"');
  const profile = eas.submit?.[name];
  if (!profile) throw new Error(`missing submit profile ${name}`);
  const base = profile.extends ? mergedProfile(eas, platform, profile.extends, depth + 1) : {};
  return { ...base, ...(profile[platform] ?? {}) };
}

/** Resolves one submit profile as the build tool does; throws with the tool's kind of complaint. */
function resolveSubmitProfile(eas: EasJson, platform: Platform, name: string, env: Record<string, string | undefined>): Record<string, unknown> {
  const out = mergedProfile(eas, platform, name);
  for (const field of EXPANDED[platform]) {
    if (typeof out[field] === 'string') out[field] = (out[field] as string).replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a: string | undefined, b: string | undefined) => env[(a ?? b) as string] ?? '');
  }
  const problems: string[] = [];
  for (const [key, value] of Object.entries(out)) {
    const shape = SHAPES[platform][key];
    if (!shape) problems.push(`"${key}" is not allowed`);
    else if (value === '') problems.push(`"${key}" is not allowed to be empty`);
    else if (!shape(value)) problems.push(`"${key}" has an invalid value ${JSON.stringify(value)}`);
  }
  if (problems.length) throw new Error(`submit ${platform} ${name}: ${problems.join('; ')}`);
  return out;
}

const submitProfiles = (eas: EasJson): [string, Platform][] =>
  Object.entries(eas.submit ?? {}).flatMap(([name, p]) => (['ios', 'android'] as const).filter((platform) => p[platform] !== undefined).map((platform): [string, Platform] => [name, platform]));

/** The profiles ios-testflight.yml can build and submit with nobody at the keyboard. */
const IOS_WORKFLOW_PROFILES = ['production', 'preview'];

describe('EAS submit profiles (apps/mobile/eas.json)', () => {
  it('every submit profile resolves with the values the build workflows export', () => {
    const eas = readEas();
    const all = submitProfiles(eas);
    expect(all.map(([name, platform]) => `${name}/${platform}`)).toEqual(expect.arrayContaining(['production/ios', 'preview/ios', 'production/android', 'manual/ios']));
    for (const [name, platform] of all) {
      const resolved = resolveSubmitProfile(eas, platform, name, WORKFLOW_ENV);
      // A "$NAME" left in the resolved profile is a placeholder in a field the tool never expands.
      for (const [key, value] of Object.entries(resolved)) expect(String(value), `${name}/${platform}.${key}`).not.toContain('$');
    }
  });

  it('refuses a placeholder in a field the build tool does not expand, such as the team id', () => {
    const eas = readEas();
    eas.submit!.production.ios = { ...eas.submit!.production.ios, appleTeamId: '$EXPO_APPLE_TEAM_ID' };
    expect(() => resolveSubmitProfile(eas, 'ios', 'production', WORKFLOW_ENV)).toThrow(/"appleTeamId" has an invalid value/);
    eas.submit!.production.ios = { ...readEas().submit!.production.ios, ascAppId: '$APP_STORE_ID' };
    expect(() => resolveSubmitProfile(eas, 'ios', 'production', { ...WORKFLOW_ENV, APP_STORE_ID: '1234567890' })).toThrow(/"ascAppId" has an invalid value/);
  });

  it('gives each iOS profile the workflow submits its App Store Connect app id from APP_STORE_ID', () => {
    for (const name of IOS_WORKFLOW_PROFILES) {
      const committed = resolveSubmitProfile(readEas(), 'ios', name, WORKFLOW_ENV);
      const prepared = applyBuildEnv(readEas(), { PROFILE: name, PLATFORM: 'ios', APP_STORE_ID: ' 1234567890\n', SIGNAL_URL: 'wss://mahjong.example.com' });
      const resolved = resolveSubmitProfile(prepared, 'ios', name, WORKFLOW_ENV);
      // An unattended submission stops without ascAppId, so it must be committed or written by the workflow.
      expect(committed.ascAppId ?? resolved.ascAppId, name).toBe('1234567890');
      expect(resolved).toMatchObject({ ascApiKeyPath: '/tmp/AuthKey.p8', ascApiKeyId: 'ABCDE12345', ascApiKeyIssuerId: WORKFLOW_ENV.EXPO_ASC_ISSUER_ID });
      expect(prepared.build[name].env).toMatchObject({ SIGNAL_URL: 'wss://mahjong.example.com', APP_STORE_ID: '1234567890' });
    }
    // Android builds get the variables but no iOS submit field; a malformed id stops the run.
    const android = applyBuildEnv(readEas(), { PROFILE: 'production', PLATFORM: 'android', APP_STORE_ID: '1234567890' });
    expect(android.submit!.production.ios).toEqual(readEas().submit!.production.ios);
    expect(() => applyBuildEnv(readEas(), { PROFILE: 'production', PLATFORM: 'ios', APP_STORE_ID: 'id1234567890' })).toThrow(/not an App Store Connect app id/);
    expect(() => applyBuildEnv(readEas(), { PROFILE: 'nightly', PLATFORM: 'ios' })).toThrow(/no build profile 'nightly'/);
  });

  it('agrees with the EAS command line\'s own resolver when that package is installed', async () => {
    let easJson: { EasJsonAccessor: { fromProjectPath(p: string): unknown }; EasJsonUtils: { getSubmitProfileAsync(a: unknown, platform: string, name: string): Promise<Record<string, unknown>> } };
    try {
      easJson = createRequire(join(ROOT, 'apps/mobile/package.json'))('@expo/eas-json');
    } catch {
      return; // not a dependency of this repository; the rules above stand in for it
    }
    const dir = mkdtempSync(join(tmpdir(), 'mjm-eas-'));
    const before = { ...process.env };
    Object.assign(process.env, WORKFLOW_ENV);
    try {
      for (const name of IOS_WORKFLOW_PROFILES) {
        writeFileSync(join(dir, 'eas.json'), JSON.stringify(applyBuildEnv(readEas(), { PROFILE: name, PLATFORM: 'ios', APP_STORE_ID: '1234567890' })));
        const resolved = await easJson.EasJsonUtils.getSubmitProfileAsync(easJson.EasJsonAccessor.fromProjectPath(dir), 'ios', name);
        expect(resolved.ascAppId, name).toBe('1234567890');
      }
    } finally {
      for (const key of Object.keys(WORKFLOW_ENV)) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  });
});

describe('iOS TestFlight workflow: the check before a build', () => {
  const gate = workflowStepScript('ios-testflight.yml', 'id: gate');
  const secrets = { HAS_EXPO_TOKEN: 'true', HAS_ASC_KEY_ID: 'true', HAS_ASC_ISSUER_ID: 'true', HAS_ASC_KEY_P8: 'true', HAS_APPLE_TEAM_ID: 'true' };

  it('stops before building when a submission is asked for and the app record id is missing or malformed', () => {
    for (const id of ['', '   ', 'id1234567890', '12 34']) {
      const r = runStep(gate, { ...secrets, SUBMIT: 'true', APP_STORE_ID: id });
      expect(r.status, JSON.stringify(id)).toBe(1);
      expect(r.outputs.ready).toBe('false');
      expect(r.summary).toMatch(/iOS build stopped/);
      expect(r.summary).toMatch(/APP_STORE_ID/);
      expect(r.summary).toMatch(/New App/);
      expect(r.stdout).toMatch(/::error title=APP_STORE_ID is needed to submit::/);
    }
  });

  it('lets the run start with the id set, or with no submission asked for', () => {
    expect(runStep(gate, { ...secrets, SUBMIT: 'true', APP_STORE_ID: '1234567890' })).toMatchObject({ status: 0, outputs: { ready: 'true' }, summary: '' });
    expect(runStep(gate, { ...secrets, SUBMIT: 'true', APP_STORE_ID: ' 1234567890 ' })).toMatchObject({ status: 0, outputs: { ready: 'true' } });
    expect(runStep(gate, { ...secrets, SUBMIT: 'false', APP_STORE_ID: '' })).toMatchObject({ status: 0, outputs: { ready: 'true' }, summary: '' });
  });

  it('still skips with the set-up steps while a secret is missing', () => {
    const r = runStep(gate, { ...secrets, HAS_ASC_KEY_P8: 'false', SUBMIT: 'true', APP_STORE_ID: '' });
    expect(r).toMatchObject({ status: 0, outputs: { ready: 'false' } });
    expect(r.summary).toMatch(/iOS build skipped: missing secret ASC_KEY_P8/);
  });

  it('hands APP_STORE_ID to the gate and prepares eas.json with the shared script in both build workflows', () => {
    const ios = readFileSync(join(ROOT, '.github/workflows/ios-testflight.yml'), 'utf8');
    const android = readFileSync(join(ROOT, '.github/workflows/android-play.yml'), 'utf8');
    expect(ios).toMatch(/APP_STORE_ID: \$\{\{ vars\.APP_STORE_ID \}\}\n\s+run: \|\n\s+MISSING=""/);
    expect(ios).toMatch(/PLATFORM: ios\n\s+run: node \.\.\/\.\.\/\.github\/scripts\/eas-build-env\.cjs eas\.json/);
    expect(android).toMatch(/PLATFORM: android\n\s+run: node \.\.\/\.\.\/\.github\/scripts\/eas-build-env\.cjs eas\.json/);
  });
});

describe('SIGNAL_URL for a release build', () => {
  type AppConfig = ((a: { config: Record<string, unknown> }) => { extra: { signalUrl?: string } }) & { releaseSignalUrlProblem(value: unknown): string | null };
  const appConfig = require(join(ROOT, 'apps/mobile/app.config.js')) as AppConfig;
  const appJson = require(join(ROOT, 'apps/mobile/app.json')) as { expo: Record<string, unknown> };
  const ACCEPTED = ['wss://mahjong-signal.fly.dev', 'wss://mahjong-signal.fly.dev/', 'wss://play.example.com:8443', '  wss://mahjong-signal.fly.dev \n', 'wss://MAHJONG.example.co.uk/socket'];
  const REFUSED = [
    '', '   ', 'ws://mahjong-signal.fly.dev', 'https://mahjong-signal.fly.dev', 'WSS://mahjong-signal.fly.dev', 'mahjong-signal.fly.dev',
    'wss://', 'wss:///path', 'wss://localhost:8787', 'wss://app.localhost', 'wss://localhost.:8787', 'wss://user@localhost:8787', 'wss://user:pw@mahjong-signal.fly.dev',
    'wss://127.0.0.1:8787', 'wss://0.0.0.0', 'wss://0:8787', 'wss://10.0.0.5', 'wss://192.168.1.20:8787', 'wss://172.16.0.5:8787', 'wss://172.31.9.9', 'wss://169.254.1.1', 'wss://8.8.8.8',
    'wss://[::1]:8787', 'wss://[fe80::1]', 'wss://mybox', 'wss://mybox.lan', 'wss://mybox.local', 'wss://db.internal', 'wss://mahjong-signal.fly.dev.', 'wss://mahjong signal.fly.dev',
  ];

  it('accepts a wss:// address on a public host name', () => {
    for (const value of ACCEPTED) expect(appConfig.releaseSignalUrlProblem(value), JSON.stringify(value)).toBeNull();
  });

  it('refuses an unset value, another scheme, an IP address, a local or private name and credentials, each with a reason', () => {
    for (const value of REFUSED) {
      const problem = appConfig.releaseSignalUrlProblem(value);
      expect(problem, JSON.stringify(value)).toEqual(expect.any(String));
      expect(problem!.length).toBeGreaterThan(20);
    }
    expect(appConfig.releaseSignalUrlProblem(undefined)).toMatch(/not set/);
    expect(appConfig.releaseSignalUrlProblem('wss://192.168.1.20:8787')).toMatch(/IP address/);
    expect(appConfig.releaseSignalUrlProblem('wss://mybox.lan')).toMatch(/local or private name/);
  });

  it('stops a production or preview build on EAS that has no usable address, and leaves other builds alone', () => {
    const before = { profile: process.env.EAS_BUILD_PROFILE, url: process.env.SIGNAL_URL };
    const build = (profile: string | undefined, url: string | undefined) => {
      if (profile === undefined) delete process.env.EAS_BUILD_PROFILE; else process.env.EAS_BUILD_PROFILE = profile;
      if (url === undefined) delete process.env.SIGNAL_URL; else process.env.SIGNAL_URL = url;
      return appConfig({ config: structuredClone(appJson.expo) });
    };
    try {
      for (const profile of ['production', 'preview']) {
        expect(() => build(profile, undefined), profile).toThrow(/SIGNAL_URL cannot be used for a (production|preview) build: it is not set/);
        expect(() => build(profile, 'ws://localhost:8787'), profile).toThrow(/does not start with wss:\/\//);
        expect(build(profile, ' wss://mahjong-signal.fly.dev ').extra.signalUrl).toBe('wss://mahjong-signal.fly.dev');
      }
      // A development build, a local `expo start` and the web export keep working with any address or none.
      expect(build('development', 'ws://192.168.1.20:8787').extra.signalUrl).toBe('ws://192.168.1.20:8787');
      expect(build(undefined, undefined).extra.signalUrl).toBeUndefined();
    } finally {
      if (before.profile === undefined) delete process.env.EAS_BUILD_PROFILE; else process.env.EAS_BUILD_PROFILE = before.profile;
      if (before.url === undefined) delete process.env.SIGNAL_URL; else process.env.SIGNAL_URL = before.url;
    }
  });

  it('is checked the same way by both build workflows before anything is built', () => {
    for (const workflow of ['ios-testflight.yml', 'android-play.yml']) {
      const step = workflowStepScript(workflow, 'name: Check SIGNAL_URL');
      for (const value of ['wss://mahjong-signal.fly.dev', ' wss://play.example.com:8443 ']) {
        const r = runStep(step, { SIGNAL_URL: value }, { cwd: ROOT });
        expect(r.status, `${workflow} ${value}`).toBe(0);
        expect(r.stdout).toContain(`Building against ${value.trim()}`);
      }
      for (const value of ['', 'wss://', 'wss://[::1]:8787', 'wss://172.16.0.5:8787', 'wss://user@localhost:8787', 'wss://mybox.lan', 'ws://mahjong-signal.fly.dev']) {
        const r = runStep(step, { SIGNAL_URL: value }, { cwd: ROOT });
        expect(r.status, `${workflow} ${JSON.stringify(value)}`).toBe(1);
        expect(r.stdout).toContain('::error title=SIGNAL_URL cannot be used for a release build::');
      }
      const text = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8');
      expect(text.indexOf('name: Check SIGNAL_URL')).toBeGreaterThan(text.indexOf('- uses: actions/checkout@v5'));
      expect(text.indexOf('name: Check SIGNAL_URL')).toBeLessThan(text.indexOf('eas build'));
    }
  });
});

describe('Sign in with Apple beside Google sign-in on iOS', () => {
  type Problem = (o: { googleIosClientId?: string; appleClientId?: string; bundleId: string }) => string | null;
  type AppConfig = ((a: { config: Record<string, unknown> }) => { ios: { usesAppleSignIn: boolean; privacyManifests: { NSPrivacyCollectedDataTypes: Array<Record<string, unknown>> } }; extra: { googleClientIds?: Record<string, string> } }) & { appleSignInProblem: Problem };
  const appConfig = require(join(ROOT, 'apps/mobile/app.config.js')) as AppConfig;
  const appJson = require(join(ROOT, 'apps/mobile/app.json')) as { expo: Record<string, unknown> };
  const BUNDLE = 'com.mahjongmania.app';
  const GOOGLE = '1234-abc.apps.googleusercontent.com';
  const KEYS = ['EAS_BUILD_PROFILE', 'EAS_BUILD_PLATFORM', 'SIGNAL_URL', 'APP_BUNDLE_ID', 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID', 'APPLE_CLIENT_ID'];
  /** The app config as a build with exactly these variables would resolve it. */
  const build = (vars: Record<string, string>) => {
    const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, { SIGNAL_URL: 'wss://mahjong-signal.fly.dev', ...vars });
    try {
      return appConfig({ config: structuredClone(appJson.expo) });
    } finally {
      for (const k of KEYS) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
  };

  it('has nothing to say about a build without Google sign-in on iOS', () => {
    expect(appConfig.appleSignInProblem({ bundleId: BUNDLE })).toBeNull();
    expect(appConfig.appleSignInProblem({ googleIosClientId: '  ', appleClientId: '', bundleId: BUNDLE })).toBeNull();
  });

  it('refuses Google sign-in on iOS until APPLE_CLIENT_ID names the bundle id, and says what to set', () => {
    expect(appConfig.appleSignInProblem({ googleIosClientId: GOOGLE, bundleId: BUNDLE })).toMatch(/APPLE_CLIENT_ID is not set.*guideline 4\.8.*fly secrets set/);
    expect(appConfig.appleSignInProblem({ googleIosClientId: GOOGLE, appleClientId: ' , ', bundleId: BUNDLE })).toMatch(/APPLE_CLIENT_ID is not set/);
    expect(appConfig.appleSignInProblem({ googleIosClientId: GOOGLE, appleClientId: 'com.other.app', bundleId: BUNDLE })).toMatch(/'com\.other\.app'\) does not name the bundle id 'com\.mahjongmania\.app'/);
    expect(appConfig.appleSignInProblem({ googleIosClientId: GOOGLE, appleClientId: BUNDLE, bundleId: BUNDLE })).toBeNull();
    // The server's value may list a web Services ID beside the bundle id.
    expect(appConfig.appleSignInProblem({ googleIosClientId: GOOGLE, appleClientId: `com.mahjongmania.web, ${BUNDLE}`, bundleId: BUNDLE })).toBeNull();
  });

  it('stops an iOS production or preview build on EAS that would offer Google sign-in alone', () => {
    for (const profile of ['production', 'preview']) {
      const ios = { EAS_BUILD_PROFILE: profile, EAS_BUILD_PLATFORM: 'ios', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE };
      expect(() => build(ios), profile).toThrow(new RegExp(`This iOS ${profile} build cannot be made: it offers Google sign-in .* APPLE_CLIENT_ID is not set`));
      expect(() => build({ ...ios, APPLE_CLIENT_ID: 'com.other.app' }), profile).toThrow(/does not name the bundle id/);
      // A renamed app: the Apple value must follow the bundle id of this build.
      expect(() => build({ ...ios, APPLE_CLIENT_ID: BUNDLE, APP_BUNDLE_ID: 'com.example.renamed' }), profile).toThrow(/does not name the bundle id 'com\.example\.renamed'/);
      const ok = build({ ...ios, APPLE_CLIENT_ID: BUNDLE });
      expect(ok.extra.googleClientIds).toEqual({ ios: GOOGLE });
      expect(ok.ios.usesAppleSignIn).toBe(true);
      // No Google sign-in on iOS: nothing to prove.
      expect(build({ EAS_BUILD_PROFILE: profile, EAS_BUILD_PLATFORM: 'ios', EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: GOOGLE }).extra.googleClientIds).toEqual({ android: GOOGLE });
    }
  });

  it('leaves Android builds, development builds and local runs alone', () => {
    expect(build({ EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'android', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE }).extra.googleClientIds).toEqual({ ios: GOOGLE });
    expect(build({ EAS_BUILD_PROFILE: 'development', EAS_BUILD_PLATFORM: 'ios', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE }).extra.googleClientIds).toEqual({ ios: GOOGLE });
    expect(build({ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE }).extra.googleClientIds).toEqual({ ios: GOOGLE });
  });

  it('is checked by the iOS workflow before anything is built, and the value reaches the EAS builder', () => {
    const step = workflowStepScript('ios-testflight.yml', 'name: Check Sign in with Apple');
    const run = (env: Record<string, string>) => runStep(step, env, { cwd: ROOT });
    expect(run({}).status).toBe(0);
    expect(run({}).stdout).toContain('No Google sign-in in this build');
    const alone = run({ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE });
    expect(alone.status).toBe(1);
    expect(alone.stdout).toContain('::error title=Google sign-in on iOS needs Sign in with Apple::');
    expect(alone.stdout).toContain('APPLE_CLIENT_ID is not set');
    expect(run({ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE, APPLE_CLIENT_ID: BUNDLE, APP_BUNDLE_ID: 'com.example.renamed' }).status).toBe(1);
    const both = run({ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE, APPLE_CLIENT_ID: 'com.example.renamed', APP_BUNDLE_ID: 'com.example.renamed' });
    expect(both.status).toBe(0);
    expect(both.stdout).toContain('both configured for com.example.renamed');
    const text = readFileSync(join(ROOT, '.github/workflows/ios-testflight.yml'), 'utf8');
    expect(text).toMatch(/APPLE_CLIENT_ID: \$\{\{ vars\.APPLE_CLIENT_ID \}\}/);
    expect(text.indexOf('name: Check Sign in with Apple')).toBeGreaterThan(text.indexOf('- uses: actions/checkout@v5'));
    expect(text.indexOf('name: Check Sign in with Apple')).toBeLessThan(text.indexOf('eas build'));
    const eas = applyBuildEnv(JSON.parse(readFileSync(join(ROOT, 'apps/mobile/eas.json'), 'utf8')) as EasJson, { PROFILE: 'production', PLATFORM: 'ios', APPLE_CLIENT_ID: ` ${BUNDLE} ` });
    expect(eas.build.production.env).toMatchObject({ APPLE_CLIENT_ID: BUNDLE });
  });

  it('declares usage data and purchases as linked to the account and used for analytics, as the server sends them', () => {
    const byType = Object.fromEntries(build({}).ios.privacyManifests.NSPrivacyCollectedDataTypes.map((d) => [d.NSPrivacyCollectedDataType as string, d]));
    expect(byType.NSPrivacyCollectedDataTypeProductInteraction).toMatchObject({ NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'] });
    expect(byType.NSPrivacyCollectedDataTypePurchaseHistory).toMatchObject({ NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality', 'NSPrivacyCollectedDataTypePurposeAnalytics'] });
  });
});

describe('workflows that act for the default branch', () => {
  const read = (file: string): string => readFileSync(join(ROOT, '.github/workflows', file), 'utf8');
  /** The `on:` block of a workflow: from that line to the next top-level key. */
  const triggers = (text: string): string => {
    const lines = text.split('\n');
    const start = lines.indexOf('on:');
    const end = lines.findIndex((l, i) => i > start && /^[A-Za-z]/.test(l));
    return lines.slice(start, end).join('\n');
  };

  it('name no branch in a trigger filter: a filter cannot follow a default branch that is not called main', () => {
    for (const file of ['deploy-signal.yml', 'web-preview.yml']) {
      const named = [...triggers(read(file)).matchAll(/^\s*branches(?:-ignore)?:\s*\[(.*)\]\s*$/gm)].flatMap((m) => m[1].split(',').map((b) => b.trim().replace(/['"]/g, ''))).filter((b) => b !== '**');
      expect(named, file).toEqual([]);
      expect(triggers(read(file)), file).not.toMatch(/^\s*branches(?:-ignore)?:\s*$/m);
    }
  });

  it('deploy after CI only when the finished run was a passed push to the default branch', () => {
    const text = read('deploy-signal.yml');
    expect(triggers(text)).toContain('workflow_run:');
    const condition = /^ {2}check:\n(?: {4}#.*\n)* {4}if: (.*)$/m.exec(text)?.[1] ?? '';
    expect(condition).toContain("github.event_name == 'workflow_dispatch' || (");
    for (const part of ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'", 'github.event.workflow_run.head_branch == github.event.repository.default_branch']) expect(condition).toContain(part);
    // The step that checks the commit is still the head asks about the default branch, not a named one.
    expect(text).toContain('DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}');
    expect(workflowStepScript('deploy-signal.yml', 'id: changed')).not.toMatch(/refs\/heads\/main\b/);
  });

  it('show a deploy that did not happen as skipped: the check job gates the deploy job, says why and marks the commit skipped', () => {
    const text = read('deploy-signal.yml');
    // The deploy job starts only on the check job's ready output (a job-level if), so it is skipped otherwise.
    expect(/^ {2}deploy:\n(?: {4}#.*\n)* {4}needs: check\n {4}if: (.*)$/m.exec(text)?.[1]).toBe("needs.check.outputs.ready == 'true'");
    const gate = workflowStepScript('deploy-signal.yml', 'id: gate');
    // No token: not ready, the summary lists the set-up, a warning (not a notice) names the skip, and the reason is an output.
    const missing = runStep(gate, { HAS_TOKEN: 'false', CHANGED: 'true', WHY: '' });
    expect(missing).toMatchObject({ status: 0, outputs: { ready: 'false' } });
    expect(missing.summary).toMatch(/Signal server not deployed: the FLY_API_TOKEN secret is missing/);
    expect(missing.summary).toMatch(/fly tokens create deploy/);
    expect(missing.stdout).toMatch(/::warning title=Deploy skipped::FLY_API_TOKEN secret missing/);
    expect(missing.outputs.why).toMatch(/FLY_API_TOKEN repository secret is missing/);
    // Nothing changed: not ready, and the reason the changed step gave is passed on.
    expect(runStep(gate, { HAS_TOKEN: 'true', CHANGED: 'false', WHY: 'abc1234 is the commit the last successful deploy shipped; nothing to deploy.' })).toMatchObject({
      status: 0,
      outputs: { ready: 'false', why: 'abc1234 is the commit the last successful deploy shipped; nothing to deploy.' },
      summary: '',
    });
    expect(runStep(gate, { HAS_TOKEN: 'true', CHANGED: 'true', WHY: '' })).toMatchObject({ status: 0, outputs: { ready: 'true' }, summary: '' });
    // The commit gets a check that concludes skipped with that reason, only when nothing is deployed.
    expect(text).toMatch(/- name: Mark the commit's deploy as skipped\n(?: {8}#.*\n)* {8}if: steps\.gate\.outputs\.ready != 'true'\n/);
    const mark = workflowStepScript('deploy-signal.yml', "name: Mark the commit's deploy as skipped");
    expect(mark).toContain('conclusion=skipped');
    expect(mark).toContain('output[summary]=$WHY');
    expect(/^ {2}check:\n[\s\S]*?^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(text)?.[1]).toMatch(/checks: write/);
    // The changed step's own reasons for skipping reach the gate.
    expect(workflowStepScript('deploy-signal.yml', 'id: changed')).toContain('echo "why=$1" >> "$GITHUB_OUTPUT"');
  });

  it('never cancel a CI run of the default branch, which the deploy starts from', () => {
    expect(read('ci.yml')).toContain("cancel-in-progress: ${{ github.ref != format('refs/heads/{0}', github.event.repository.default_branch) }}");
  });

  it('build the web preview only for the default branch or a manual run', () => {
    const text = read('web-preview.yml');
    expect(triggers(text)).toMatch(/^ {2}push:$/m);
    expect(triggers(text)).toMatch(/^ {2}workflow_dispatch:/m);
    const condition = /^ {2}build:\n(?: {4}#.*\n)* {4}if: (.*)$/m.exec(text)?.[1] ?? '';
    expect(condition).toBe("github.event_name == 'workflow_dispatch' || github.ref_name == github.event.repository.default_branch");
    // The publishing job still waits for the build.
    expect(text).toMatch(/^ {4}needs: build$/m);
  });
});

describe('workflow hygiene', () => {
  const workflows = readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'));

  it('parses every workflow as YAML, each job with its steps', () => {
    for (const file of workflows) {
      const jobs = Object.entries(workflow(file).jobs ?? {});
      expect(jobs.length, file).toBeGreaterThan(0);
      for (const [name, job] of jobs) expect(job.steps?.length ?? 0, `${file}: job ${name}`).toBeGreaterThan(0);
    }
  });

  it('runs every job on a pinned runner image with the Node 24 releases of checkout and setup-node', () => {
    for (const file of workflows) {
      const text = readFileSync(join(ROOT, '.github/workflows', file), 'utf8');
      const runners = [...text.matchAll(/^ {4}runs-on: (.+)$/gm)].map((m) => m[1]);
      expect(runners.length, file).toBeGreaterThan(0);
      // ubuntu-latest moves under the workflows; the image is changed on purpose, here.
      expect(new Set(runners), `${file}: runner images`).toEqual(new Set(['ubuntu-24.04']));
      for (const action of ['actions/checkout', 'actions/setup-node']) {
        const versions = [...text.matchAll(new RegExp(`uses: ${action}@(\\S+)`, 'g'))].map((m) => m[1]);
        // The v4 releases run on Node 20, which GitHub now forces onto Node 24.
        for (const v of versions) expect(v, `${file}: ${action}`).toBe('v5');
      }
      expect(text, `${file}: checks out the repository`).toMatch(/uses: actions\/checkout@v5/);
    }
  });

  it('uses only the Node 24 releases of every other action, artifact and Pages actions included', () => {
    // The first release of each that runs on Node 24 (GitHub forces Node 20 actions onto Node 24):
    // upload-artifact v5 still ran on Node 20; upload-pages-artifact v5 wraps upload-artifact v7.
    const node24: Record<string, string> = {
      'actions/upload-artifact': 'v6',
      'actions/upload-pages-artifact': 'v5',
      'actions/deploy-pages': 'v5',
      'actions/configure-pages': 'v6',
      'expo/expo-github-action': '5273c2136bd09c2a341fe3340d3e767ce5a13015',
      'superfly/flyctl-actions/setup-flyctl': 'ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1',
      'actions/checkout': 'v5',
      'actions/setup-node': 'v5',
    };
    const seen = new Set<string>();
    for (const file of workflows) {
      const text = readFileSync(join(ROOT, '.github/workflows', file), 'utf8');
      for (const [, action, version] of text.matchAll(/uses: ([\w./-]+)@(\S+)/g)) {
        expect(Object.keys(node24), `${file}: ${action} has no known Node 24 release here`).toContain(action);
        expect(version, `${file}: ${action}`).toBe(node24[action]);
        seen.add(action);
      }
    }
    expect(seen).toContain('actions/upload-artifact');
    expect(seen).toContain('actions/upload-pages-artifact');
  });

  it('gives every job a time limit and every workflow an explicit token scope', () => {
    expect(workflows.length).toBeGreaterThanOrEqual(6);
    for (const file of workflows) {
      const text = readFileSync(join(ROOT, '.github/workflows', file), 'utf8');
      const jobs = text.match(/^ {4}runs-on: /gm)?.length ?? 0;
      expect(jobs, file).toBeGreaterThan(0);
      // Without a limit a hung build or deploy holds its concurrency group for GitHub's six hours.
      expect(text.match(/^ {4}timeout-minutes: \d+$/gm)?.length ?? 0, `${file}: jobs with a time limit`).toBe(jobs);
      expect(text, `${file}: top-level permissions`).toMatch(/^permissions:\n {2}contents: (read|write)$/m);
    }
    expect(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')).toMatch(/^permissions:\n {2}contents: read\n\n/m);
  });

  it("runs every workspace's tests and the repository's own tests in CI, as the root `npm test` does", () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(ci).toMatch(/^ {6}- run: npm run coverage$/m);
    // These tests (tests/ at the root) run in no workspace's suite, so CI runs them on their own.
    expect(ci).toMatch(/^ {6}- run: npm run test:repo$/m);
    expect(scripts.test).toMatch(/&& npm run test:repo$/);
    expect(scripts['test:repo']).toBe('vitest run --config tests/vitest.config.mts');
  });

  it('fails the avatar import step when the import script fails, and still shows its output', () => {
    const step = workflowStepScript('avatar-art.yml', 'name: Resize and register portraits');
    const run = (exitCode: number) => {
      const dir = mkdtempSync(join(tmpdir(), 'mjm-avatar-'));
      mkdirSync(join(dir, 'apps/mobile/scripts'), { recursive: true });
      writeFileSync(join(dir, 'apps/mobile/scripts/import-avatars.cjs'), `console.log('importing'); if (${exitCode}) { console.error('Error: ImageMagick is required'); process.exit(${exitCode}); }\n`);
      return runStep(step, {}, { cwd: dir });
    };
    const failed = run(1);
    expect(failed.status).toBe(1);
    expect(failed.summary).toContain('Error: ImageMagick is required');
    expect(failed.stdout).toContain('::error title=Avatar import failed::');
    const ok = run(0);
    expect(ok.status).toBe(0);
    expect(ok.summary).toContain('importing');
  });
});

describe('Web preview workflow: installing the dependencies', () => {
  const install = workflowStepScript('web-preview.yml', 'name: Install dependencies');

  /** Runs the step with a stand-in npm that fails `fails` times, as on a dropped connection, then works, and a stand-in sleep. */
  const run = (fails: number) => {
    const bin = mkdtempSync(join(tmpdir(), 'mjm-npm-'));
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\nn=$(( $(cat "${bin}/tries" 2>/dev/null || echo 0) + 1 ))\necho "$n" > "${bin}/tries"\nif [ "$n" -le ${fails} ]; then echo "npm error code ECONNRESET" >&2; exit 1; fi\necho "added 1500 packages"\n`);
    writeFileSync(join(bin, 'sleep'), `#!/bin/bash\necho "$1" >> "${bin}/pauses"\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
    const r = runStep(install, { PATH: `${bin}:${process.env.PATH ?? ''}` });
    const lines = (file: string) => {
      try {
        return readFileSync(join(bin, file), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    return { status: r.status, tries: Number(lines('tries')[0] ?? 0), pauses: lines('pauses'), stdout: r.stdout };
  };

  it('tries npm ci again after a failure such as a dropped connection, with a pause, and goes on once it works', () => {
    expect(run(0)).toMatchObject({ status: 0, tries: 1, pauses: [] });
    expect(run(1)).toMatchObject({ status: 0, tries: 2, pauses: ['15'] });
    expect(run(2)).toMatchObject({ status: 0, tries: 3, pauses: ['15', '15'] });
  });

  it('fails the run when npm ci fails every time, after three tries', () => {
    const r = run(99);
    expect(r).toMatchObject({ status: 1, tries: 3, pauses: ['15', '15'] });
    expect(r.stdout).toContain('::error title=npm ci failed::npm ci failed three times.');
  });

  it('is how the build job installs, before the web export', () => {
    const steps = workflow('web-preview.yml').jobs.build.steps ?? [];
    const at = steps.findIndex((s) => s.name === 'Install dependencies');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(steps.findIndex((s) => s.name?.startsWith('Export web build')));
    // No other step runs npm ci once, without the retries.
    expect(steps.filter((s) => /^\s*npm ci\s*$/m.test(s.run ?? ''))).toEqual([]);
  });
});

describe("CI's image check", () => {
  /** The `docker` job of ci.yml, up to the next job. */
  const dockerJob = (): string => /^ {2}docker:\n([\s\S]*?)(?=^ {2}\S)/m.exec(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'))?.[1] ?? '';

  it('boots the image on Postgres as production does and plays the smoke test expecting Postgres storage', () => {
    const job = dockerJob();
    expect(job).toMatch(/^ {4}services:\n {6}postgres:\n {8}image: postgres:16$/m);
    expect(job).toContain('--health-cmd "pg_isready -U postgres"');
    // The docker run command, with its continuation lines.
    const run = /docker run -d --name signal(?:[^\n\\]|\\\n)*/.exec(job)?.[0] ?? '';
    expect(run).toContain('-e DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres');
    expect(run).toContain('-e MIGRATE_ON_BOOT=1');
    expect(run).toMatch(/-e AUTH_PEPPER=/);
    expect(run).toContain('--network host');
    expect(run).not.toContain('ALLOW_EPHEMERAL');
    expect(run).toContain('mahjong-signal:ci');
    expect(job).toContain('npm run smoke -w @mjm/signal -- http://127.0.0.1:8787 --expect-storage pg');
    expect(job).not.toContain('--expect-storage memory');
  });

  it("keeps the container's log as an artifact when the job fails or runs out of time", () => {
    const steps = workflow('ci.yml').jobs.docker.steps ?? [];
    const write = steps.findIndex((s) => /docker logs signal > signal\.log/.test(s.run ?? ''));
    const upload = steps.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@') && s.with?.path === 'signal.log');
    // The log is written whatever happened, then kept when a step failed or the job was cancelled (a time limit cancels it).
    expect(steps[write]?.if).toBe('always()');
    expect(upload).toBeGreaterThan(write);
    expect(steps[upload].if).toBe('failure() || cancelled()');
  });
});
