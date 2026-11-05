import { describe, expect, it } from 'vitest';
import { MockStoreProvider } from './providers';
import { devBuildProof, selectStoreMode } from './store-mode';

describe('store mode', () => {
  it('a release build never selects the mock store, even when asked to', () => {
    expect(selectStoreMode({ mode: 'mock', iosKey: 'appl_x' }, 'ios', false)).toEqual({ kind: 'unavailable', reason: 'mock_in_release' });
  });

  it('a development build asked for the mock gets it, with the proof that it is a development build', () => {
    const m = selectStoreMode({ mode: ' MOCK ' }, 'web', true);
    expect(m.kind).toBe('mock');
  });

  it('with no keys the store is unavailable (and the web build has no store)', () => {
    expect(selectStoreMode({}, 'ios', false)).toEqual({ kind: 'unavailable', reason: 'no_key' });
    expect(selectStoreMode({ iosKey: '   ' }, 'ios', true)).toEqual({ kind: 'unavailable', reason: 'no_key' });
    expect(selectStoreMode({ androidKey: 'goog_x' }, 'ios', false)).toEqual({ kind: 'unavailable', reason: 'no_key' });
    expect(selectStoreMode({ iosKey: 'appl_x', androidKey: 'goog_x' }, 'web', false)).toEqual({ kind: 'unavailable', reason: 'platform' });
  });

  it('picks the platform’s RevenueCat key', () => {
    expect(selectStoreMode({ iosKey: ' appl_x ', androidKey: 'goog_x' }, 'ios', false)).toEqual({ kind: 'revenuecat', apiKey: 'appl_x' });
    expect(selectStoreMode({ iosKey: 'appl_x', androidKey: 'goog_x' }, 'android', false)).toEqual({ kind: 'revenuecat', apiKey: 'goog_x' });
  });

  it('only a development build can produce the proof the mock store needs', () => {
    expect(devBuildProof(false)).toBeNull();
    const proof = devBuildProof(true);
    expect(proof).not.toBeNull();
    expect(new MockStoreProvider(proof!).kind).toBe('mock');
  });

  it('the mock cannot be constructed without the proof (checked by `npm run typecheck`)', () => {
    const make = () => {
      // @ts-expect-error a MockStoreProvider needs a DevBuildProof
      new MockStoreProvider();
      // @ts-expect-error a plain object is not a DevBuildProof
      new MockStoreProvider({});
      // @ts-expect-error the release-build result (null) must be checked first
      new MockStoreProvider(devBuildProof(false));
    };
    expect(make).toBeTypeOf('function');
  });
});
