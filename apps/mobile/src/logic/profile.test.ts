import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, migrateProfile } from './profile';

describe('migrateProfile', () => {
  it('drops the trust-on-first-use id and device secret from older builds, keeping name and avatar', () => {
    expect(migrateProfile({ userId: 'user-0a1b2c3d4e5f60718293a4b5', userSecret: 'f'.repeat(48), name: 'Mei', avatar: 'boss' })).toEqual({ userId: '', name: 'Mei', avatar: 'boss' });
  });

  it('keeps a server account id', () => {
    const id = '6f1c2d3e-1111-4222-8333-944455556666';
    expect(migrateProfile({ userId: id, name: 'Mei', avatar: 'chef' })).toEqual({ userId: id, name: 'Mei', avatar: 'chef' });
  });

  it('fills gaps from the defaults', () => {
    expect(migrateProfile(null)).toEqual(DEFAULT_PROFILE);
    expect(migrateProfile({ name: 7, avatar: '' })).toEqual(DEFAULT_PROFILE);
  });
});
