import { describe, expect, it } from 'vitest';
import { acceptedName, DEFAULT_PROFILE, isNameRefused, migrateProfile, withAcceptedName, withRefusedName, type Profile } from './profile';

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

describe('a name the game server refused', () => {
  const mei: Profile = { userId: 'u-1', name: 'Mei', avatar: 'lady' };

  it('is remembered on the profile and no longer shown or sent as the player\'s', () => {
    const refused = withRefusedName({ ...mei, name: ' Admin ' }, 'Admin');
    expect(refused).toEqual({ userId: 'u-1', name: ' Admin ', avatar: 'lady', refusedName: 'Admin' });
    expect(isNameRefused(refused)).toBe(true);
    expect(acceptedName(refused)).toBe('');
    // Saved and loaded again, it is still refused.
    expect(isNameRefused(migrateProfile(JSON.parse(JSON.stringify(refused))))).toBe(true);
  });

  it('stops applying as soon as the player types another name', () => {
    const refused = withRefusedName({ ...mei, name: 'Admin' }, 'Admin');
    const renamed = { ...refused, name: 'Mei' };
    expect(isNameRefused(renamed)).toBe(false);
    expect(acceptedName(renamed)).toBe('Mei');
    // Typing the refused name again shows the refusal again, without waiting for the server.
    expect(isNameRefused({ ...renamed, name: 'Admin' })).toBe(true);
  });

  it('a refusal that arrives after the player has already changed the name is ignored', () => {
    expect(withRefusedName(mei, 'Admin')).toBe(mei);
    expect(withRefusedName(mei, '  ')).toBe(mei);
  });

  it('is dropped when the server later accepts that same name', () => {
    const refused = withRefusedName({ ...mei, name: 'Admin' }, 'Admin');
    expect(withAcceptedName(refused, 'Admin')).toEqual({ userId: 'u-1', name: 'Admin', avatar: 'lady' });
    expect(withAcceptedName(refused, 'Mei')).toBe(refused);
    expect(withAcceptedName(mei, 'Mei')).toBe(mei);
  });

  it('a profile with no refusal reads as before', () => {
    expect(isNameRefused(mei)).toBe(false);
    expect(acceptedName(mei)).toBe('Mei');
    expect(isNameRefused({ name: '', refusedName: '' })).toBe(false);
    expect(migrateProfile({ userId: '', name: 'Mei', avatar: 'lady', refusedName: 7 })).toEqual({ userId: '', name: 'Mei', avatar: 'lady' });
  });
});
