import { describe, expect, it } from 'vitest';
import { linkFromNotificationData, parseDeepLink, planLink, presentInForeground } from './deeplink';

const SCHEMES = ['mahjongmadness', 'com.mahjongmadness.app'];

describe('deep links', () => {
  it('parses club and table links in the app’s schemes', () => {
    expect(parseDeepLink('mahjongmadness://club/abc234', SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
    expect(parseDeepLink('MahjongMadness://table/WXYZ23?club=abc234', SCHEMES)).toEqual({ kind: 'table', room: 'WXYZ23', club: 'ABC234' });
    expect(parseDeepLink('mahjongmadness:///table/WXYZ23/', SCHEMES)).toEqual({ kind: 'table', room: 'WXYZ23' });
    expect(parseDeepLink('com.mahjongmadness.app://club/ABC234', SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
  });

  it('ignores other schemes, routes and malformed codes', () => {
    expect(parseDeepLink('https://example.com/club/ABC234', SCHEMES)).toBeNull();
    expect(parseDeepLink('http://localhost:8081/', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmadness://shop', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmadness://club/', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmadness://club/<script>', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmadness://club/%E0%A4%A', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmadness://table/ABC234?club=../../x', SCHEMES)).toEqual({ kind: 'table', room: 'ABC234' });
    expect(parseDeepLink(null, SCHEMES)).toBeNull();
    // Expo's own development-client links are not ours.
    expect(parseDeepLink('exp+mahjong-madness://expo-development-client/?url=x', SCHEMES)).toBeNull();
  });

  it('reads a notification’s data as a url or as fields', () => {
    expect(linkFromNotificationData({ url: 'mahjongmadness://club/ABC234' }, SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
    expect(linkFromNotificationData({ type: 'club', club: 'abc234' }, SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
    expect(linkFromNotificationData({ type: 'table', room: 'WXYZ23', club: 'ABC234' }, SCHEMES)).toEqual({ kind: 'table', room: 'WXYZ23', club: 'ABC234' });
    expect(linkFromNotificationData({ type: 'promo' }, SCHEMES)).toBeNull();
    expect(linkFromNotificationData(undefined, SCHEMES)).toBeNull();
    expect(linkFromNotificationData('mahjongmadness://club/ABC234', SCHEMES)).toBeNull();
  });

  it('plans where a link leads from where the player is', () => {
    expect(planLink({ kind: 'club', club: 'ABC234' }, { roomCode: null })).toEqual({ kind: 'open-club', club: 'ABC234' });
    expect(planLink({ kind: 'table', room: 'WXYZ23', club: 'ABC234' }, { roomCode: 'wxyz23' })).toEqual({ kind: 'show-table' });
    expect(planLink({ kind: 'table', room: 'WXYZ23', club: 'ABC234' }, { roomCode: 'OTHER1' })).toEqual({ kind: 'join-table', room: 'WXYZ23', club: 'ABC234' });
    expect(planLink({ kind: 'table', room: 'WXYZ23' }, { roomCode: null })).toEqual({ kind: 'join-table', room: 'WXYZ23' });
  });

  it('shows foreground notifications except news of the table the player is sitting at', () => {
    expect(presentInForeground({ kind: 'club', club: 'ABC234' }, { roomCode: 'WXYZ23' })).toBe(true);
    expect(presentInForeground({ kind: 'table', room: 'WXYZ23' }, { roomCode: 'wxyz23' })).toBe(false);
    expect(presentInForeground({ kind: 'table', room: 'WXYZ23' }, { roomCode: null })).toBe(true);
    expect(presentInForeground(null, { roomCode: 'WXYZ23' })).toBe(true);
  });
});
