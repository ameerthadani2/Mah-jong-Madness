/**
 * The server's environment variables and the two places an owner looks them up: every name the
 * server or its smoke test reads must be in apps/signal/.env.example and in the server README's
 * table, so copying the example file never leaves a feature silently off.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './workflow-steps.js';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') ? [path] : [];
  });
}

/** Every `env.NAME` and `env['NAME']` in the server's source and scripts. */
function namesRead(): string[] {
  const names = new Set<string>();
  for (const file of [...sources(join(ROOT, 'apps/signal/src')), ...sources(join(ROOT, 'apps/signal/scripts'))]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) names.add(m[1] ?? m[2]);
  }
  return [...names].sort();
}

const mentions = (text: string, name: string) => new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`).test(text);

describe('the server environment is documented where an owner looks', () => {
  const read = namesRead();

  it('finds the variables the server reads', () => {
    expect(read).toEqual(expect.arrayContaining(['DATABASE_URL', 'AUTH_PEPPER', 'AUTH_PEPPER_PREVIOUS', 'ADMIN_TOKEN', 'REVENUECAT_WEBHOOK_SECRET', 'SMOKE_URL']));
    expect(read.length).toBeGreaterThan(25);
  });

  it('names every one of them in apps/signal/.env.example', () => {
    const example = readFileSync(join(ROOT, 'apps/signal/.env.example'), 'utf8');
    expect(read.filter((name) => !mentions(example, name))).toEqual([]);
  });

  it('names every one of them in apps/signal/README.md', () => {
    const readme = readFileSync(join(ROOT, 'apps/signal/README.md'), 'utf8');
    expect(read.filter((name) => !mentions(readme, name))).toEqual([]);
  });

  it('gives a settable line (NAME=) in the example to everything an owner sets', () => {
    const example = readFileSync(join(ROOT, 'apps/signal/.env.example'), 'utf8');
    // Set by the platform or kept only for a warning: described in a comment, not offered as a line.
    const described = ['NODE_ENV', 'FLY_IMAGE_REF', 'DATA_DIR'];
    const lines = new Set(example.split('\n').map((l) => /^([A-Z][A-Z0-9_]+)=/.exec(l)?.[1]).filter(Boolean));
    expect(read.filter((name) => !described.includes(name) && !lines.has(name))).toEqual([]);
  });
});
