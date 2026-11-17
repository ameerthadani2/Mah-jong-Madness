/**
 * The render tests measure the .tsx screens and components (assessment 4: the app's coverage left them out):
 * `npm run coverage:render` runs jest with coverage over src/**\/*.tsx and fails under its floors, and the root
 * `npm run coverage` runs it and prints its figure on a line of its own.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const app = join(__dirname, '..');

describe('coverage of the .tsx screens', () => {
  it('is collected by the render tests over every .tsx file but the tests, with floors', () => {
    const config = require(join(app, 'jest.config.js')) as { collectCoverageFrom?: string[]; coverageThreshold?: { global?: Record<string, number> }; coverageReporters?: string[] };
    expect(config.collectCoverageFrom).toEqual(['src/**/*.tsx', '!src/**/*.render.test.tsx']);
    expect(config.coverageReporters).toContain('json-summary');
    const floors = config.coverageThreshold?.global ?? {};
    for (const k of ['lines', 'branches', 'functions']) expect(floors[k]).toBeGreaterThan(0);
    const scripts = (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['coverage:render']).toMatch(/jest --config jest\.config\.js --coverage/);
  });

  it("is run and printed as its own line by the root's npm run coverage", () => {
    const script = readFileSync(join(app, '..', '..', 'scripts', 'coverage.mjs'), 'utf8');
    expect(script).toContain("'coverage:render'");
    expect(script).toContain('coverage-render');
  });
});
