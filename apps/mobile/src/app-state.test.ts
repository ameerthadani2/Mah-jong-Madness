/**
 * Static checks over the app provider (it renders React Native, so it is not imported here).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const code = readFileSync(join(__dirname, 'app-state.tsx'), 'utf8');

describe('hardware back', () => {
  it('listens for the Android back key only: the web has none and logs an error for the listener', () => {
    const at = code.indexOf('BackHandler.addEventListener(');
    expect(at).toBeGreaterThan(0);
    // The guard sits in the same effect, just before the listener is added.
    const effect = code.slice(code.lastIndexOf('useEffect(', at), at);
    expect(effect).toContain("if (Platform.OS !== 'android') return;");
  });
});
