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

describe('the records of online tables that leave the saved-table slot', () => {
  it('every change of the slot goes through putActive, which keeps the table leaving it in the archive', () => {
    // The load at start sets the slot as storage holds it; every other change goes through putActive.
    expect([...code.matchAll(/setActiveSessionState\(/g)]).toHaveLength(2);
    expect(code).toContain('setActiveSession: (s) => putActive(s),');
    const at = code.indexOf('const save = () => {');
    const save = code.slice(at, code.indexOf('const scheduler = saveScheduler(save);', at));
    expect(save).toContain('putActive(null);');
    expect(save).toContain('putActive(record);');
    const put = code.slice(code.indexOf('const putActive = useRef('), code.indexOf('}).current;', code.indexOf('const putActive = useRef(')));
    expect(put).toContain('archiveOnSlotChange(archiveRef.current, prev, next, live, Date.now())');
    expect(put).toContain('void storage.saveArchive(kept);');
  });

  it('a join to a room finds the record kept of its table through the registered source', () => {
    expect(code).toContain('setArchivedTableSource((url, room) => {');
    expect(code).toContain('archivedFor(archiveRef.current, url, room, Date.now())');
  });
});
