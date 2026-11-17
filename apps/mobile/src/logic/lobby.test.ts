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

  // A refused seat shows the reason and Back only, with no share code, Add bot or Start: rendered in
  // src/screens/Lobby.render.test.tsx ("shows only the reason and Back when the table refused the seat").

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
    // Online showing the reason it was handed is rendered in src/screens/Online.render.test.tsx.
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
    // The header showing the code at a private table and hiding it at a quick-match one is rendered in
    // src/components/table/TableHud.render.test.tsx; the table screen passing the table kind down stays checked here.
    expect(readFileSync(join(__dirname, '../screens/TableScreen.tsx'), 'utf8')).toContain('quickMatch={session.quickMatch === true}');
  });
});
