/** The audio manifest, the files on disk and the generated require table must agree. */
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CALL_KINDS, VOICE_PREFERENCES } from './cues';

const ROOT = join(__dirname, '..', '..');
const AUDIO = join(ROOT, 'assets', 'audio');
const manifest = JSON.parse(readFileSync(join(AUDIO, 'manifest.json'), 'utf8')) as {
  maxBytes: number;
  cues: Array<{ id: string; file: string; volume: number; placeholder: boolean; describe: string }>;
};
const sources = readFileSync(join(ROOT, 'src', 'audio', 'sources.ts'), 'utf8');
const ids = manifest.cues.map((c) => c.id);

describe('audio manifest', () => {
  it('lists every cue the table plays', () => {
    for (const cue of ['draw', 'discard', 'drawGame', 'fanfare', 'tick', 'tap']) expect(ids).toContain(`sfx.${cue}`);
    for (const voice of VOICE_PREFERENCES.filter((v) => v !== 'off')) for (const call of CALL_KINDS) expect(ids).toContain(`voice.${voice}.${call}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has every placeholder on disk, each under the size limit, with a sane volume and a description', () => {
    for (const c of manifest.cues) {
      const file = join(AUDIO, c.file);
      if (c.placeholder) expect(existsSync(file), c.file).toBe(true);
      if (existsSync(file)) {
        expect(statSync(file).size, c.file).toBeLessThanOrEqual(manifest.maxBytes);
        expect(readFileSync(file).subarray(0, 4).toString('ascii'), c.file).toBe('RIFF');
      }
      expect(c.volume).toBeGreaterThan(0);
      expect(c.volume).toBeLessThanOrEqual(1);
      expect(c.describe.length).toBeGreaterThan(10);
    }
  });

  it('requires exactly the cues whose file exists (run scripts/gen-audio.cjs after adding a file)', () => {
    for (const c of manifest.cues) {
      const line = `'${c.id}': require('../../assets/audio/${c.file}')`;
      expect(sources.includes(line), c.id).toBe(existsSync(join(AUDIO, c.file)));
    }
  });
});
