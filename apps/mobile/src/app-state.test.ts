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

describe('the resumable table record', () => {
  it('is kept whatever the client holds for a token, under the room the session joined', () => {
    const at = code.indexOf('const save = () => {');
    expect(at).toBeGreaterThan(0);
    const save = code.slice(at, code.indexOf('const scheduler = saveScheduler(save);', at));
    // A welcome that leaves the token out must not stop the record being kept: a resume would find an older one.
    expect(save).not.toMatch(/if \(!st\.token\) return;/);
    expect(save).toContain("const token = st.token ?? '';");
    expect(save).toContain('roomCode: session.roomCode,');
    expect(save).not.toMatch(/roomCode: st\.roomCode/);
  });
});
