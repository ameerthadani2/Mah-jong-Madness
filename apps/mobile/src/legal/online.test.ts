import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { gatingScreen, onlineEntry, type OnlineEntryInputs } from './online';

const ok: OnlineEntryInputs = { ageLoaded: true, ageStatus: 'allowed', gateKind: 'open', authStatus: 'guest' };

describe('online entry guard', () => {
  it('lets a player in only with an age answer that allows it, an up-to-date build and a usable account', () => {
    expect(onlineEntry(ok)).toBe('ok');
    expect(onlineEntry({ ...ok, authStatus: 'offline' })).toBe('ok');
    expect(onlineEntry({ ...ok, authStatus: 'account' })).toBe('ok');
  });

  it('never connects before the stored age answer has loaded, and asks when there is none', () => {
    expect(onlineEntry({ ...ok, ageLoaded: false, ageStatus: 'unknown' })).toBe('wait');
    expect(onlineEntry({ ...ok, ageStatus: 'unknown' })).toBe('ask');
  });

  it('keeps a blocked player out of every online path, whatever else is true', () => {
    expect(onlineEntry({ ...ok, ageStatus: 'blocked' })).toBe('blocked');
    expect(onlineEntry({ ...ok, ageStatus: 'blocked', authStatus: 'signed_out' })).toBe('blocked');
  });

  it('puts the update block first: a build below minBuild does nothing online, not even for a tapped notification', () => {
    expect(onlineEntry({ ...ok, gateKind: 'update' })).toBe('update');
    expect(onlineEntry({ ...ok, gateKind: 'update', ageLoaded: false })).toBe('update');
    expect(gatingScreen('update', 'table')).toBeNull();
  });

  it('asks a signed-out account to sign in rather than minting a guest', () => {
    expect(onlineEntry({ ...ok, authStatus: 'signed_out' })).toBe('sign_in');
    expect(gatingScreen('sign_in', 'table')).toBe('online');
    expect(gatingScreen('sign_in', 'club')).toBe('clubs');
    expect(gatingScreen('ask', 'club')).toBe('clubs');
    expect(gatingScreen('blocked', 'table')).toBe('online');
    expect(gatingScreen('ok', 'table')).toBeNull();
  });
});

/**
 * Every way onto the game server goes through the guard: a screen that calls createOnlineSession (or
 * loads a club) must read it, and the push bridge must consult it outside a render. A static check, so a
 * new entry point cannot forget the gate without failing here.
 */
describe('online entry points', () => {
  const src = join(__dirname, '..');
  const read = (p: string) => readFileSync(join(src, p), 'utf8');

  it('Home (resume), Online, Clubs, a club screen and the push bridge all consult the guard', () => {
    for (const screen of ['screens/HomeScreen.tsx', 'screens/OnlineScreen.tsx', 'screens/ClubsScreen.tsx']) {
      const code = read(screen);
      expect(code, screen).toContain('createOnlineSession');
      expect(code, screen).toContain('useOnlineGuard()');
    }
    // ClubScreen is in ClubsScreen.tsx: both components read the guard (two calls).
    expect(read('screens/ClubsScreen.tsx').match(/useOnlineGuard\(\)/g)).toHaveLength(2);
    const bridge = read('push/PushBridge.tsx');
    expect(bridge).toContain('createOnlineSession');
    expect(bridge).toContain('onlineEntry(');
    expect(bridge).toContain('ageGateLoaded()');
  });

  it('no other screen opens an online session', () => {
    const guarded = new Set(['HomeScreen.tsx', 'OnlineScreen.tsx', 'ClubsScreen.tsx']);
    for (const f of ['LobbyScreen.tsx', 'TableScreen.tsx', 'SettingsScreen.tsx', 'ShopScreen.tsx', 'ReviewScreen.tsx']) {
      if (guarded.has(f)) continue;
      expect(read(join('screens', f)), f).not.toContain('createOnlineSession(');
    }
  });
});
