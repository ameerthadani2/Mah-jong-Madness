import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hudShowsCode, lobbyControls, lobbySeated } from './lobby';

describe('what the lobby offers', () => {
  it('a quick-match table has no code to share, no invite link and nothing to start: nobody else can enter it', () => {
    expect(lobbyControls({ quickMatch: true })).toEqual({ share: false, addBot: false, start: false });
  });

  it('a private or club table keeps its share code, Add bot and Start', () => {
    expect(lobbyControls({ quickMatch: false })).toEqual({ share: true, addBot: true, start: true });
    expect(lobbyControls({})).toEqual({ share: true, addBot: true, start: true });
  });

  it('what the quick-match lobby says instead carries no table code and no invite link', () => {
    for (const locale of [en, zhTW]) {
      const lobby = (locale as { lobby: Record<string, string> }).lobby;
      for (const key of ['quickTable', 'quickClosed']) {
        expect(lobby[key], key).toBeTruthy();
        expect(lobby[key]).not.toContain('%{code}');
        expect(lobby[key]).not.toContain('%{link}');
      }
    }
  });
});

describe('a lobby without a seat', () => {
  it('is not a lobby: a table that refused the join (full, or already playing) seats nobody', () => {
    expect(lobbySeated({ seat: null })).toBe(false);
    expect(lobbySeated({ seat: 0 })).toBe(true);
    expect(lobbySeated({ seat: 3 })).toBe(true);
  });

  it('shows the reason and Back only, before any share code, Add bot or Start is drawn', () => {
    const src = readFileSync(join(__dirname, '../screens/LobbyScreen.tsx'), 'utf8');
    const guard = src.indexOf('if (!lobbySeated(state))');
    expect(guard).toBeGreaterThan(0);
    for (const control of ['lobbyControls(session)', "t('lobby.share')", "t('lobby.addBot')", 'onPress={start}']) expect(src.indexOf(control), control).toBeGreaterThan(guard);
    const block = src.slice(guard, src.indexOf('lobbyControls(session)'));
    expect(block).toContain('testID="lobby-no-seat"');
    expect(block).toContain('onPress={leave}');
  });

  it('is never opened by a join the table refused: Online, Home and a followed link wait for the seat first', () => {
    for (const file of ['../screens/OnlineScreen.tsx', '../screens/HomeScreen.tsx', '../push/PushBridge.tsx']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      const made = src.indexOf('await createOnlineSession(');
      const waited = src.indexOf('await seatOrRefusal(session);', made);
      const shown = src.indexOf("go({ name: 'lobby' })", made);
      expect(made, file).toBeGreaterThan(0);
      expect(waited, file).toBeGreaterThan(made);
      expect(shown, file).toBeGreaterThan(waited);
    }
  });

  it('a table link that cannot be followed lands with the reason, not on a bare screen', () => {
    const src = readFileSync(join(__dirname, '../push/PushBridge.tsx'), 'utf8');
    expect(src).toContain('fallback(tableError(e, t));');
    expect(src).toMatch(/\{ name: 'online', notice \}/);
    expect(src).toMatch(/\{ name: 'club', code: plan\.club, notice \}/);
    expect(readFileSync(join(__dirname, '../screens/OnlineScreen.tsx'), 'utf8')).toContain('app.screen.notice ?? null');
  });
});

describe('the table code in the table header', () => {
  it('is shown at a private or club table in landscape', () => {
    expect(hudShowsCode({ roomCode: 'ABC123' }, false)).toBe(true);
    expect(hudShowsCode({ roomCode: 'ABC123', quickMatch: false }, false)).toBe(true);
  });

  it('is never shown at a quick-match table: nobody can use that code', () => {
    expect(hudShowsCode({ roomCode: '6TYR8N', quickMatch: true }, false)).toBe(false);
    expect(hudShowsCode({ roomCode: '6TYR8N', quickMatch: true }, true)).toBe(false);
  });

  it('is not shown at the local table or in portrait', () => {
    expect(hudShowsCode({ roomCode: 'LOCAL' }, false)).toBe(false);
    expect(hudShowsCode({ roomCode: 'ABC123' }, true)).toBe(false);
  });

  it('is what the header asks, with the table kind passed down from the table screen', () => {
    expect(readFileSync(join(__dirname, '../components/table/TableHud.tsx'), 'utf8')).toContain('{hudShowsCode({ roomCode, quickMatch }, portrait) && (');
    expect(readFileSync(join(__dirname, '../screens/TableScreen.tsx'), 'utf8')).toContain('quickMatch={session.quickMatch === true}');
  });
});
