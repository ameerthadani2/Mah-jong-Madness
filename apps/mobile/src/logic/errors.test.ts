import { describe, expect, it } from 'vitest';
import { friendlyError, friendlyErrorMessage } from './errors';
import { translator } from './translator.fixture';

const en = translator('en');
const zh = translator('zh-TW');
const say = (e: unknown) => friendlyError(e, en);

const UNREACHABLE = 'Cannot reach the game server. Check your connection and try again.';
const GENERIC = 'Something went wrong. Please try again.';

describe('friendlyError (English copy)', () => {
  it('explains connection failures from fetch and the signalling socket', () => {
    expect(say(new TypeError('Network request failed'))).toBe(UNREACHABLE);
    expect(say(new TypeError('Failed to fetch'))).toBe(UNREACHABLE);
    expect(say(new Error('Signaling connection failed'))).toBe(UNREACHABLE);
    expect(say(new Error('Connection closed'))).toBe(UNREACHABLE);
    expect(say(new Error('Not connected'))).toBe(UNREACHABLE);
  });

  it('explains timeouts and aborted requests', () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(say(abort)).toMatch(/took too long/);
    expect(say(new Error('Room request timed out'))).toMatch(/took too long/);
    expect(say(new Error('The game server did not answer in time. Check your connection and try again.'))).toBe('The game server did not answer in time. Check your connection and try again.');
  });

  it('explains a wrong or full table code without saying which', () => {
    expect(say(new Error('Room not found'))).toMatch(/No open table with that code/);
    expect(say(new Error('Room is full'))).toMatch(/No open table with that code/);
    expect(say(new Error('Room not found or full'))).toMatch(/No open table with that code/);
  });

  it('explains rate limits, limits and server failures', () => {
    expect(say(new Error('Too many requests'))).toMatch(/Too many attempts/);
    expect(say(new Error('Too many join attempts; please wait a few seconds'))).toMatch(/Too many attempts/);
    expect(say(new Error('The server is full right now; please try again in a few minutes'))).toMatch(/busy right now/);
    expect(say(new Error('Request failed (500)'))).toMatch(/had a problem/);
    expect(say(new Error('Internal error'))).toMatch(/had a problem/);
    expect(say(new Error('Only server-hosted tables can be created'))).toBe('Only server-hosted tables can be created.');
    expect(say(new Error('Please wait a few seconds before creating another room'))).toBe('Please wait a few seconds before creating another room.');
  });

  it('keeps the clubs API’s own sentences, with limits as parameters', () => {
    expect(say(new Error('Club not found'))).toBe('Club not found.');
    expect(say(new Error('Only admins can open tables in this club'))).toBe('Only admins can open tables in this club.');
    expect(say(new Error('The owner cannot leave; transfer ownership first'))).toBe('The owner cannot leave; transfer ownership first.');
    expect(say(new Error('This club is full (200 members)'))).toBe('This club is full (200 members).');
    expect(say(new Error('You can belong to at most 10 clubs; leave one first'))).toBe('You can belong to at most 10 clubs; leave one first.');
    expect(say(new Error('This club already has 5 open tables; finish one first'))).toBe('This club already has 5 open tables; finish one first.');
  });

  it('reads the clubs client’s own failure codes', () => {
    const timeout = Object.assign(new Error('x'), { code: 'club_timeout', seconds: 15 });
    expect(say(timeout)).toBe('The club server did not respond within 15 seconds. Check your connection and try again.');
    expect(say(Object.assign(new Error('Could not reach the club server (network error).'), { code: 'club_unreachable' }))).toBe(UNREACHABLE);
    expect(say(Object.assign(new Error('x'), { code: 'club_bad_reply', status: 502 }))).toBe('The club server sent an unreadable reply (502).');
  });

  it('passes unknown readable messages through and hides technical ones', () => {
    expect(say(new Error('The dealer has gone for tea'))).toBe('The dealer has gone for tea.');
    expect(say(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe(GENERIC);
    expect(say(new TypeError("Cannot read properties of undefined (reading 'room')"))).toBe(GENERIC);
    expect(say(new Error('ceremony_failed'))).toBe(GENERIC);
    expect(say(new Error('x'.repeat(200)))).toBe(GENERIC);
  });

  it('copes with values that are not errors', () => {
    expect(say(undefined)).toBe(GENERIC);
    expect(say(null)).toBe(GENERIC);
    expect(say({})).toBe(GENERIC);
    expect(say('Failed to fetch')).toBe(UNREACHABLE);
    expect(say(new Error(''))).toBe(GENERIC);
  });
});

describe('friendlyErrorMessage', () => {
  it('returns a key and parameters, not prose', () => {
    expect(friendlyErrorMessage(new Error('Room not found or full'))).toEqual({ key: 'errors.roomUnavailable' });
    expect(friendlyErrorMessage(new Error('Too many join attempts; please wait a few seconds'))).toEqual({ key: 'errors.rateLimited' });
    expect(friendlyErrorMessage(new Error('Only server-hosted tables can be created'))).toEqual({ key: 'errors.hostedOnly' });
    expect(friendlyErrorMessage(new Error('Hosted tables are disabled'))).toEqual({ key: 'errors.hostedDisabled' });
    expect(friendlyErrorMessage(new Error('This club is full (200 members)'))).toEqual({ key: 'errors.clubFull', params: { max: '200' } });
    expect(friendlyErrorMessage(new Error('Fancy that'))).toEqual({ key: 'errors.passthrough', params: { message: 'Fancy that.' } });
  });

  it('renders every mapped key in Traditional Chinese', () => {
    const samples: unknown[] = [
      new Error('Room not found or full'),
      new Error('Too many join attempts; please wait a few seconds'),
      new Error('Only server-hosted tables can be created'),
      new Error('Hosted tables are disabled'),
      new Error('The server is full right now; please try again in a few minutes'),
      new Error('Table is full.'),
      new Error('Connection to the table was lost.'),
      new Error('This club is full (200 members)'),
      Object.assign(new Error('x'), { code: 'club_timeout', seconds: 15 }),
      new TypeError('Failed to fetch'),
      undefined,
    ];
    for (const e of samples) {
      const text = friendlyError(e, zh);
      expect(text, String(e)).toMatch(/[一-鿿]/);
      expect(text).not.toMatch(/%\{/);
    }
    expect(friendlyError(new Error('This club is full (200 members)'), zh)).toContain('200');
    expect(friendlyError(new Error('Room not found or full'), zh)).toBe('找不到這個代碼的牌桌。請確認代碼；牌桌也可能已經滿了。');
  });
});

describe('friendlyError for the account API (docs/API.md codes)', () => {
  const coded = (code: string, message = 'x', extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { code, ...extra });

  it('maps every account error code to translated copy, whatever the server message', () => {
    expect(friendlyErrorMessage(coded('invalid_credentials', 'Guest id or secret does not match'))).toEqual({ key: 'errors.invalidCredentials' });
    for (const c of ['invalid_session', 'session_expired', 'session_revoked', 'session_rotated']) expect(friendlyErrorMessage(coded(c))).toEqual({ key: 'errors.sessionExpired' });
    expect(friendlyErrorMessage(coded('invalid_token', 'apple token rejected: nonce mismatch'))).toEqual({ key: 'errors.invalidToken' });
    expect(friendlyErrorMessage(coded('provider_disabled'))).toEqual({ key: 'errors.providerDisabled' });
    expect(friendlyErrorMessage(coded('not_linked'))).toEqual({ key: 'errors.notLinked' });
    expect(friendlyErrorMessage(coded('identity_in_use'))).toEqual({ key: 'errors.identityInUse' });
    expect(friendlyErrorMessage(coded('last_identity'))).toEqual({ key: 'errors.lastIdentity' });
    expect(friendlyErrorMessage(coded('rate_limited'))).toEqual({ key: 'errors.rateLimited' });
    expect(friendlyErrorMessage(coded('unavailable'))).toEqual({ key: 'errors.unavailable' });
  });

  it('reads the account client’s own failure codes', () => {
    expect(say(coded('auth_timeout', 'x', { seconds: 15 }))).toBe('The game server did not respond within 15 seconds. Check your connection and try again.');
    expect(say(coded('auth_unreachable'))).toBe(UNREACHABLE);
    expect(say(coded('auth_bad_reply', 'x', { status: 502 }))).toBe('The game server sent an unreadable reply (502).');
  });

  it('prefers a known club sentence for limit and not_found, with a coded fallback', () => {
    expect(say(coded('limit', 'This club is full (200 members)'))).toBe('This club is full (200 members).');
    expect(friendlyErrorMessage(coded('limit', 'cap_hit'))).toEqual({ key: 'errors.limit' });
    expect(say(coded('not_found', 'Club not found'))).toBe('Club not found.');
    expect(friendlyErrorMessage(coded('not_found', ''))).toEqual({ key: 'errors.notFound' });
    expect(friendlyErrorMessage(coded('invalid', 'bad_body'))).toEqual({ key: 'errors.invalidRequest' });
  });

  it('explains a refused table socket (4401)', () => {
    expect(friendlyErrorMessage(Object.assign(new Error('x'), { code: 4401 }))).toEqual({ key: 'errors.unauthorised' });
    expect(friendlyErrorMessage(new Error('Unauthorised: the game server did not accept this session.'))).toEqual({ key: 'errors.unauthorised' });
  });

  it('renders the new keys in Traditional Chinese', () => {
    for (const c of ['invalid_credentials', 'session_expired', 'invalid_token', 'provider_disabled', 'not_linked', 'identity_in_use', 'last_identity', 'unavailable', 'auth_unreachable']) {
      const text = friendlyError(coded(c), zh);
      expect(text, c).toMatch(/[一-鿿]/);
    }
    expect(friendlyError(coded('auth_timeout', 'x', { seconds: 9 }), zh)).toContain('9');
    expect(friendlyError(Object.assign(new Error('x'), { code: 4401 }), zh)).toMatch(/[一-鿿]/);
  });
});
