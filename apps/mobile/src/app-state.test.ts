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
    // Written in order through the slot writer: the archive first, the slot once the archive holds what it gives up
    // (game/slotWriter.test.ts).
    expect(put).toContain('void slots.put(next, changed ? kept : undefined);');
    expect(put).not.toContain('storage.saveArchive');
    expect(put).not.toContain('storage.clearActiveSession');
  });

  it('a join to a room finds the record kept of its table through the registered source', () => {
    expect(code).toContain('setArchivedTableSource((url, room) => {');
    expect(code).toContain('archivedFor(archiveRef.current, url, room, Date.now())');
  });
});

describe('the red hands kept apart from the records', () => {
  it('a hand that turns red is written down at once, apart from the record, and every record taken up gets them back', () => {
    const at = code.indexOf('const keepRed = () => {');
    expect(at).toBeGreaterThan(0);
    const keep = code.slice(at, code.indexOf('const unsubRed = session.onChange(keepRed);', at));
    expect(keep).toContain('session.client.redHands()');
    expect(keep).toContain('void storage.saveRedHands(next);');
    // Kept by match: every red hand of the game server goes back, and the client keeps those of its own match.
    expect(code).toContain('setRedHandsSource((url) => redFor(redRef.current, url));');
  });
});

describe('records found by match, and saved tables gone stale', () => {
  it('a welcome into a match the client holds no record of finds the saved table or the archive by match, with the journal and the red hands', () => {
    const at = code.indexOf('setKeptMatchSource((url, matchId, room) => {');
    expect(at).toBeGreaterThan(0);
    const src = code.slice(at, code.indexOf('});', code.indexOf('return { client', at)));
    expect(src).toContain('archivedMatch(archiveRef.current, url, matchId, Date.now())');
    expect(src).toContain('slot.client?.state?.matchId === matchId');
    expect(src).toContain('journal: journal.journalFor(url, matchId), moved: e.roomCode !== room, red');
    expect(src).toContain('if (!e) return { red };');
  });

  it('a saved table gone stale is kept in the archive before it is deleted', () => {
    const at = code.indexOf('const savedTable = storage.loadArchive().then(');
    expect(at).toBeGreaterThan(0);
    const load = code.slice(at, code.indexOf('return [as, kept] as const;', at));
    expect(load).toContain('storage.loadActiveSession(async (s) => {');
    expect(load).toContain('archiveOnSlotChange(kept, s, null, () => undefined, Date.now())');
    // Deleted only once the archive holding it is written; else it stays in the slot on the device, and the writer knows.
    expect(load).toContain('const ok = await storage.saveArchive(kept);');
    expect(load).toContain('return ok;');
    expect(code).toContain('slots.begin({ stored: as ?? staleStored, archive: kept, archiveBehind: staleStored !== null });');
  });
});

describe('the journal of moves', () => {
  it('is handed to the table clients, and drops the moves of a record once it is written', () => {
    expect(code).toContain('setMoveJournalSource(journal);');
    // The moves a record holds leave the journal once the slot holding it is written (game/slotWriter.ts, and its tests).
    expect(code).toContain('const slots = useRef(slotWriter(storage, journal)).current;');
    const put = code.slice(code.indexOf('const putActive = useRef('), code.indexOf('}).current;', code.indexOf('const putActive = useRef(')));
    expect(put).toContain('journal.keep(heldMatch(next, archiveRef.current, playing));');
  });
});
