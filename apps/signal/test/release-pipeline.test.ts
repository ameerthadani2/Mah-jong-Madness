/**
 * The release pipeline's configuration, checked the way the tools that read it behave:
 * - apps/mobile/eas.json's submit profiles, resolved by the rules of the EAS command line (and by
 *   its own resolver when that package happens to be installed);
 * - the steps of the build workflows that decide whether a run may start, run as shell scripts
 *   with stand-in values.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      expect(text.indexOf('name: Check SIGNAL_URL')).toBeGreaterThan(text.indexOf('- uses: actions/checkout@v4'));
      expect(text.indexOf('name: Check SIGNAL_URL')).toBeLessThan(text.indexOf('eas build'));
    }
  });
});

describe('workflow hygiene', () => {
  const workflows = readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'));

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
