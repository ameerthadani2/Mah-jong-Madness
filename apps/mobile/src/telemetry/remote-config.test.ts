import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../api/http';
import { fetchRemoteConfig, gateState, isBuildBlocked, parseBuildNumber, readRemoteConfig, storeUrlFor } from './remote-config';

const reply = (status: number, body: string): FetchLike => async () => ({ ok: status < 400, status, text: async () => body });

describe('update gate', () => {
  it('reads build numbers from iOS and Android', () => {
    expect(parseBuildNumber('12')).toBe(12);
    expect(parseBuildNumber(' 7 ')).toBe(7);
    expect(parseBuildNumber('1.0.12')).toBe(12);
    expect(parseBuildNumber(31)).toBe(31);
    expect(parseBuildNumber(null)).toBeNull();
    expect(parseBuildNumber(undefined)).toBeNull();
    expect(parseBuildNumber('dev')).toBeNull();
    expect(parseBuildNumber('')).toBeNull();
  });

  it('blocks only a known build below a positive minBuild', () => {
    expect(isBuildBlocked(4, 5)).toBe(true);
    expect(isBuildBlocked(5, 5)).toBe(false);
    expect(isBuildBlocked(6, 5)).toBe(false);
    expect(isBuildBlocked(4, 0)).toBe(false);
    expect(isBuildBlocked(null, 99)).toBe(false);
  });

  it('shows nothing without a server, maintenance when set, and the update screen for an old build', () => {
    expect(gateState(null, 1)).toEqual({ kind: 'open', maintenance: null });
    expect(gateState({ minBuild: 0, maintenance: 'Back at 3pm', pushEnabled: false }, 1)).toEqual({ kind: 'open', maintenance: 'Back at 3pm' });
    expect(gateState({ minBuild: 10, maintenance: 'Back at 3pm', pushEnabled: false }, 9)).toEqual({ kind: 'update', minBuild: 10 });
    expect(gateState({ minBuild: 10, maintenance: null, pushEnabled: false }, null)).toEqual({ kind: 'open', maintenance: null });
  });

  it('sanitises the server’s reply', () => {
    expect(readRemoteConfig({ minBuild: '9', maintenance: '   ', pushEnabled: 'yes' })).toEqual({ minBuild: 0, maintenance: null, pushEnabled: false });
    expect(readRemoteConfig({ minBuild: 3.7, maintenance: ' Upgrading ', pushEnabled: true })).toEqual({ minBuild: 3, maintenance: 'Upgrading', pushEnabled: true });
    expect(readRemoteConfig(null)).toBeNull();
    expect(readRemoteConfig('x')).toBeNull();
  });

  it('fetches /api/config and fails quietly', async () => {
    let asked = '';
    const ok: FetchLike = async (url, init) => {
      asked = `${init.method} ${url}`;
      return { ok: true, status: 200, text: async () => JSON.stringify({ authProviders: [], storeEnabled: false, pushEnabled: true, minBuild: 4, maintenance: null, serverNow: '' }) };
    };
    expect(await fetchRemoteConfig(ok, 'https://game.example')).toEqual({ minBuild: 4, maintenance: null, pushEnabled: true, storeEnabled: false });
    expect(asked).toBe('GET https://game.example/api/config');
    expect(await fetchRemoteConfig(async () => Promise.reject(new TypeError('Failed to fetch')), 'http://localhost:8787')).toBeNull();
    expect(await fetchRemoteConfig(reply(500, '{"error":"unavailable"}'), 'x')).toBeNull();
    expect(await fetchRemoteConfig(reply(200, '<html>'), 'x')).toBeNull();
    expect(await fetchRemoteConfig(() => new Promise(() => undefined), 'x', 20)).toBeNull();
  });

  it('links to the right store and none on the web', () => {
    const urls = { ios: 'https://apps.apple.com/app/id1', android: 'https://play.google.com/store/apps/details?id=a' };
    expect(storeUrlFor('ios', urls)).toBe(urls.ios);
    expect(storeUrlFor('android', urls)).toBe(urls.android);
    expect(storeUrlFor('web', urls)).toBeNull();
  });
});
