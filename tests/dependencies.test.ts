/**
 * The lockfile against the advisories the project has acted on (docs/ARCHITECTURE.md, Dependency
 * advisories). picomatch, which Metro, Jest's workers, the Expo command line and Vite match file
 * paths with, has a ReDoS (GHSA-c2c7-rcm5-vvqj) and a method injection (GHSA-3v7f-55p6-f55p) in every
 * release before 2.3.2, 3.0.2 and 4.0.4. The `overrides` in the root package.json hold each major
 * line in use at or above its fixed release, and every copy the lockfile installs must be one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { overrides?: Record<string, string> };

/** The first release with both fixes, for each major line the advisories cover; later lines came after them. */
const FIXED: Record<number, string> = { 2: '2.3.2', 3: '3.0.2', 4: '4.0.4' };
const NEWEST_COVERED = 4;

const parts = (version: string) => version.split('.').map(Number);
const atLeast = (version: string, min: string) => {
  const [a, b] = [parts(version), parts(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
/** Whether a picomatch release has both fixes: at or above its line's fixed release, or on a line released after them. */
const fixed = (version: string) => {
  const major = parts(version)[0];
  return major > NEWEST_COVERED || (FIXED[major] !== undefined && atLeast(version, FIXED[major]));
};

describe('picomatch', () => {
  const copies = Object.entries(lock.packages)
    .filter(([path]) => /(^|\/)node_modules\/picomatch$/.test(path))
    .map(([path, entry]) => ({ path, version: entry.version ?? '' }));

  it('knows a fixed release when it sees one', () => {
    expect(['2.3.2', '3.0.2', '4.0.4', '4.0.7', '5.0.0'].filter(fixed)).toEqual(['2.3.2', '3.0.2', '4.0.4', '4.0.7', '5.0.0']);
    expect(['1.2.0', '2.3.1', '3.0.1', '4.0.3'].filter(fixed)).toEqual([]);
  });

  it('is installed only in releases with both fixes', () => {
    expect(copies.length).toBeGreaterThan(0);
    for (const { path, version } of copies) expect(fixed(version), `${path}: picomatch ${version}`).toBe(true);
  });

  it('has each major line in use held at its fixed release by an override in the root package.json', () => {
    const lines = [...new Set(copies.map(({ version }) => parts(version)[0]))].filter((major) => major <= NEWEST_COVERED);
    expect(lines.length).toBeGreaterThan(0);
    for (const major of lines) {
      const floor = /^\^(\d+\.\d+\.\d+)$/.exec(pkg.overrides?.[`picomatch@^${major}`] ?? '')?.[1];
      expect(floor, `overrides["picomatch@^${major}"]`).toBeDefined();
      expect(floor && atLeast(floor, FIXED[major]) && parts(floor)[0] === major, `overrides["picomatch@^${major}"] = ^${floor}`).toBe(true);
    }
  });
});
