import { describe, expect, it } from 'vitest';
import { readRemoteConfig } from '../telemetry/remote-config';
import { shopStoreState } from './store-mode';

describe('the server store switch reaches the Shop', () => {
  it('reads storeEnabled from /api/config, only when the server says', () => {
    expect(readRemoteConfig({ minBuild: 0, maintenance: null, pushEnabled: false, storeEnabled: false })?.storeEnabled).toBe(false);
    expect(readRemoteConfig({ storeEnabled: true })?.storeEnabled).toBe(true);
    expect(readRemoteConfig({ storeEnabled: 'no' })).not.toHaveProperty('storeEnabled');
    expect(readRemoteConfig({})).not.toHaveProperty('storeEnabled');
  });

  it('a build with store keys shows Store unavailable when the server says the store is off', () => {
    expect(shopStoreState('revenuecat', false)).toBe('server_off');
    expect(shopStoreState('revenuecat', true)).toBe('open');
    expect(shopStoreState('revenuecat', undefined)).toBe('open');
  });

  it('the build-time gate still comes first, and the development mock store never needs the server', () => {
    expect(shopStoreState('unavailable', true)).toBe('build_off');
    expect(shopStoreState('unavailable', false)).toBe('build_off');
    expect(shopStoreState('mock', false)).toBe('open');
  });
});
