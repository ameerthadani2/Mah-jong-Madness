import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { lobbyControls } from './lobby';

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
