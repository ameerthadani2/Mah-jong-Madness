import { describe, expect, it } from 'vitest';
import { linkFromNotificationData, parseDeepLink, planLink, presentInForeground, tableLink } from './deeplink';

const SCHEMES = ['mahjongmania', 'com.mahjongmania.app'];

describe('deep links', () => {
  it('parses club and table links in the app’s schemes', () => {
    expect(parseDeepLink('mahjongmania://club/abc234', SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
    expect(parseDeepLink('MahjongMania://table/WXYZ23?club=abc234', SCHEMES)).toEqual({ kind: 'table', room: 'WXYZ23', club: 'ABC234' });
    expect(parseDeepLink('mahjongmania:///table/WXYZ23/', SCHEMES)).toEqual({ kind: 'table', room: 'WXYZ23' });
    expect(parseDeepLink('com.mahjongmania.app://club/ABC234', SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
  });

  it('ignores other schemes, routes and malformed codes', () => {
    expect(parseDeepLink('https://example.com/club/ABC234', SCHEMES)).toBeNull();
    expect(parseDeepLink('http://localhost:8081/', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmania://shop', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmania://club/', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmania://club/<script>', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmania://club/%E0%A4%A', SCHEMES)).toBeNull();
    expect(parseDeepLink('mahjongmania://table/ABC234?club=../../x', SCHEMES)).toEqual({ kind: 'table', room: 'ABC234' });
    expect(parseDeepLink(null, SCHEMES)).toBeNull();
    // Expo's own development-client links are not ours.
    expect(parseDeepLink('exp+mahjongmania://expo-development-client/?url=x', SCHEMES)).toBeNull();
  });

  it('reads a notification’s data as a url or as fields', () => {
    expect(linkFromNotificationData({ url: 'mahjongmania://club/ABC234' }, SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
    expect(linkFromNotificationData({ type: 'club', club: 'abc234' }, SCHEMES)).toEqual({ kind: 'club', club: 'ABC234' });
    expect(linkFromNotificationData({ type: 'table', room: 'WXYZ23', club: 'ABC234' }, SCHEMES)).toEqual({ kind: 'table', room: 'WXYZ23', club: 'ABC234' });
    expect(linkFromNotificationData({ type: 'promo' }, SCHEMES)).toBeNull();
    expect(linkFromNotificationData(undefined, SCHEMES)).toBeNull();
    expect(linkFromNotificationData('mahjongmania://club/ABC234', SCHEMES)).toBeNull();
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

  it('opens shared web links on the link domain only, and builds the link to share', () => {
    const domains = ['play.example.com'];
    expect(parseDeepLink('https://play.example.com/t/wxyz23', SCHEMES, domains)).toEqual({ kind: 'table', room: 'WXYZ23' });
    expect(parseDeepLink('https://PLAY.example.com/c/ABC234/', SCHEMES, domains)).toEqual({ kind: 'club', club: 'ABC234' });
    expect(parseDeepLink('https://play.example.com/t/WXYZ23?club=abc234', SCHEMES, domains)).toEqual({ kind: 'table', room: 'WXYZ23', club: 'ABC234' });
    expect(parseDeepLink('https://evil.example.com/t/WXYZ23', SCHEMES, domains)).toBeNull();
    expect(parseDeepLink('https://play.example.com/x/WXYZ23', SCHEMES, domains)).toBeNull();
    expect(parseDeepLink('https://play.example.com/t/<b>', SCHEMES, domains)).toBeNull();
    expect(parseDeepLink('https://play.example.com/t/WXYZ23', SCHEMES)).toBeNull();
    expect(tableLink('wxyz23', { scheme: 'mahjongmania', domain: 'play.example.com' })).toBe('https://play.example.com/t/WXYZ23');
    expect(tableLink('WXYZ23', { scheme: 'mahjongmania' })).toBe('mahjongmania://table/WXYZ23');
    expect(parseDeepLink(tableLink('WXYZ23', { scheme: 'mahjongmania' }), SCHEMES)).toEqual({ kind: 'table', room: 'WXYZ23' });
    expect(linkFromNotificationData({ url: 'https://play.example.com/t/WXYZ23' }, SCHEMES, domains)).toEqual({ kind: 'table', room: 'WXYZ23' });
  });
});
