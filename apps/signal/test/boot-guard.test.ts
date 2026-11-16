/**
 * A production server refuses to start without its database or its session pepper, instead of
 * quietly running from memory and losing every account at the next deploy (probe prod-noenv:
 * NODE_ENV=production with no secrets booted and answered /health 200).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingProductionEnv, missingProductionEnvMessage } from '../src/config';
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
});
