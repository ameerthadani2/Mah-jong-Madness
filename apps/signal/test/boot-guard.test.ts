/**
 * A production server refuses to start without its database or its session pepper, instead of
 * quietly running from memory and losing every account at the next deploy (probe prod-noenv:
 * NODE_ENV=production with no secrets booted and answered /health 200).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, missingProductionEnv, missingProductionEnvMessage, storeConfigWarning, weakPepperMessage, weakPepperProblems } from '../src/config';
import { hostLockTarget } from '../src/db';

const ROOT = join(__dirname, '..');

/** Run the real entry point with exactly `env` (plus PATH) until it exits or prints `until`. */
function boot(env: Record<string, string>, until?: RegExp): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const onData = (d: Buffer) => {
      output += String(d);
      if (until && until.test(output)) child.kill('SIGTERM');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('fail-closed boot', () => {
  it('names what production is missing, and nothing outside production or with ALLOW_EPHEMERAL=1', () => {
    expect(missingProductionEnv({ NODE_ENV: 'production' })).toEqual(['DATABASE_URL', 'AUTH_PEPPER']);
    expect(missingProductionEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db/x', AUTH_PEPPER: '  ' })).toEqual(['AUTH_PEPPER']);
    expect(missingProductionEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db/x', AUTH_PEPPER: 'p' })).toEqual([]);
    expect(missingProductionEnv({ NODE_ENV: 'production', ALLOW_EPHEMERAL: '1' })).toEqual([]);
    expect(missingProductionEnv({ NODE_ENV: 'production', ALLOW_EPHEMERAL: '0' })).toEqual(['DATABASE_URL', 'AUTH_PEPPER']);
    expect(missingProductionEnv({})).toEqual([]);
    expect(missingProductionEnv({ NODE_ENV: 'development' })).toEqual([]);
    expect(missingProductionEnvMessage(['AUTH_PEPPER'])).toMatch(/AUTH_PEPPER is not set.*ALLOW_EPHEMERAL=1/);
  });

  it('exits 1 with a clear message when NODE_ENV=production has no DATABASE_URL or AUTH_PEPPER', async () => {
    const { code, output } = await boot({ NODE_ENV: 'production', PORT: '18977' });
    expect(code).toBe(1);
    expect(output).toContain('refusing to start: NODE_ENV=production but DATABASE_URL and AUTH_PEPPER are not set');
    expect(output).not.toContain('listening');
  }, 30_000);

  it('starts in memory when ALLOW_EPHEMERAL=1 says so', async () => {
    const { output } = await boot({ NODE_ENV: 'production', ALLOW_EPHEMERAL: '1', PORT: '18978' }, /listening on/);
    expect(output).toContain('listening on :18978 (storage memory');
  }, 30_000);

  it('production refuses a host lock on a pooled address and names DATABASE_URL_DIRECT; development only warns', () => {
    const pooled = 'postgres://app@ep-cool-pooler.example.net/db';
    const direct = 'postgres://app@ep-cool.example.net/db';
    const prod = (env: Record<string, string>) => hostLockTarget({ NODE_ENV: 'production', ...env });
    expect(prod({ DATABASE_URL: pooled, DATABASE_URL_DIRECT: direct })).toEqual({ url: direct });
    expect(prod({ DATABASE_URL: pooled })?.refusal).toMatch(/refusing to start: DATABASE_URL looks like a pooled.*Set DATABASE_URL_DIRECT/);
    expect(prod({ DATABASE_URL: direct, DATABASE_URL_DIRECT: 'postgres://app@db.example.net:6432/db' })?.refusal).toMatch(/refusing to start: DATABASE_URL_DIRECT looks like a pooled/);
    // An address that does not look pooled still boots, with the old warning when DIRECT is unset.
    expect(prod({ DATABASE_URL: direct })).toMatchObject({ url: direct, warning: expect.stringMatching(/DATABASE_URL_DIRECT is not set/) });
    for (const env of [{ DATABASE_URL: pooled }, { DATABASE_URL: direct, DATABASE_URL_DIRECT: pooled }]) {
      const dev = hostLockTarget(env);
      expect(dev?.refusal).toBeUndefined();
      expect(dev?.warning).toMatch(/pooled.*DATABASE_URL_DIRECT/);
    }
    expect(hostLockTarget({ NODE_ENV: 'production' })).toBeNull();
  });

  it('exits 1 at once in production when the host lock would use a pooled address', async () => {
    const t0 = Date.now();
    const { code, output } = await boot({
      NODE_ENV: 'production',
      PORT: '18979',
      DATABASE_URL: 'postgres://app@127.0.0.1:18911/db',
      DATABASE_URL_DIRECT: 'postgres://app@127.0.0.1:6432/db',
      AUTH_PEPPER: 'k7Qw2Lp9Xv4Rt8Zm1Nb6Hc3Fd5Gs0JyUe',
    });
    expect(code).toBe(1);
    expect(output).toMatch(/refusing to start: DATABASE_URL_DIRECT looks like a pooled/);
    expect(output).not.toContain('listening');
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it('production refuses a short or example pepper, in AUTH_PEPPER and in each AUTH_PEPPER_PREVIOUS entry', () => {
    const good = 'k7Qw2Lp9Xv4Rt8Zm1Nb6Hc3Fd5Gs0JyUe';
    const older = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    const prod = (env: Record<string, string>) => weakPepperProblems({ NODE_ENV: 'production', ...env });
    expect(prod({ AUTH_PEPPER: good })).toEqual([]);
    expect(prod({ AUTH_PEPPER: good, AUTH_PEPPER_PREVIOUS: `${older}, ${good.slice(1)}x` })).toEqual([]);
    expect(prod({ AUTH_PEPPER: 'short-pepper' })).toEqual(['AUTH_PEPPER is shorter than 32 characters']);
    expect(prod({ AUTH_PEPPER: good.slice(0, 31) })).toEqual(['AUTH_PEPPER is shorter than 32 characters']);
    expect(prod({ AUTH_PEPPER: 'p'.repeat(40) })).toEqual(['AUTH_PEPPER is one character repeated']);
    expect(prod({ AUTH_PEPPER: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` })).toEqual(['AUTH_PEPPER is an example value from the docs']);
    expect(prod({ AUTH_PEPPER: '<the one before>' })).toEqual(['AUTH_PEPPER is an example value from the docs']);
    expect(prod({ AUTH_PEPPER: good, AUTH_PEPPER_PREVIOUS: `${older},<previous>,abc` })).toEqual([
      'AUTH_PEPPER_PREVIOUS entry 2 is an example value from the docs',
      'AUTH_PEPPER_PREVIOUS entry 3 is shorter than 32 characters',
    ]);
    // Unset is missingProductionEnv's business; outside production nothing is checked.
    expect(prod({})).toEqual([]);
    expect(weakPepperProblems({ AUTH_PEPPER: 'p' })).toEqual([]);
    const message = weakPepperMessage(prod({ AUTH_PEPPER: 'hunter2' }));
    expect(message).toMatch(/refusing to start: AUTH_PEPPER is shorter than 32 characters/);
    expect(message).not.toContain('hunter2');
  });

  it('exits 1 in production with a weak pepper, without printing it', async () => {
    const { code, output } = await boot({ NODE_ENV: 'production', PORT: '18980', DATABASE_URL: 'postgres://app@127.0.0.1:18911/db', AUTH_PEPPER: 'hunter2-but-longer' });
    expect(code).toBe(1);
    expect(output).toContain('refusing to start: AUTH_PEPPER is shorter than 32 characters');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('listening');
  }, 30_000);

  it('production turns the store on only with both RevenueCat secrets, and names the missing one', () => {
    const both = { REVENUECAT_WEBHOOK_SECRET: 'whsec', REVENUECAT_SECRET_KEY: 'sk_live' };
    const prod = (env: Record<string, string>) => ({ NODE_ENV: 'production', ...env });
    expect(loadConfig(prod(both)).revenueCatWebhookSecret).toBe('whsec');
    expect(storeConfigWarning(prod(both))).toBeNull();
    expect(loadConfig(prod({ REVENUECAT_WEBHOOK_SECRET: 'whsec' })).revenueCatWebhookSecret).toBeNull();
    expect(storeConfigWarning(prod({ REVENUECAT_WEBHOOK_SECRET: 'whsec' }))).toMatch(/REVENUECAT_SECRET_KEY is not: the store stays off/);
    expect(loadConfig(prod({ REVENUECAT_SECRET_KEY: 'sk_live' })).revenueCatWebhookSecret).toBeNull();
    expect(storeConfigWarning(prod({ REVENUECAT_SECRET_KEY: 'sk_live' }))).toMatch(/REVENUECAT_WEBHOOK_SECRET is not: the store stays off/);
    expect(storeConfigWarning(prod({}))).toBeNull();
    // Development keeps the webhook secret alone (the webhook tests and local runs use it).
    expect(loadConfig({ REVENUECAT_WEBHOOK_SECRET: 'whsec' }).revenueCatWebhookSecret).toBe('whsec');
    expect(storeConfigWarning({ REVENUECAT_WEBHOOK_SECRET: 'whsec' })).toBeNull();
  });

  it('boots in production with the store off and a warning when only the webhook secret is set', async () => {
    const { output } = await boot({ NODE_ENV: 'production', ALLOW_EPHEMERAL: '1', PORT: '18981', REVENUECAT_WEBHOOK_SECRET: 'whsec-only' }, /listening on/);
    expect(output).toMatch(/REVENUECAT_WEBHOOK_SECRET is set but REVENUECAT_SECRET_KEY is not: the store stays off/);
    expect(output).toMatch(/listening on :18981 .*store off/);
  }, 30_000);
});
