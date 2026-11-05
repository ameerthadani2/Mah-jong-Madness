import { describe, expect, it } from 'vitest';
import { friendlyError } from './errors';

const UNREACHABLE = 'Cannot reach the game server. Check your connection and try again.';
const GENERIC = 'Something went wrong. Please try again.';

describe('friendlyError', () => {
  it('explains connection failures from fetch and the signalling socket', () => {
    expect(friendlyError(new TypeError('Network request failed'))).toBe(UNREACHABLE);
    expect(friendlyError(new TypeError('Failed to fetch'))).toBe(UNREACHABLE);
    expect(friendlyError(new Error('Signaling connection failed'))).toBe(UNREACHABLE);
    expect(friendlyError(new Error('Connection closed'))).toBe(UNREACHABLE);
    expect(friendlyError(new Error('Not connected'))).toBe(UNREACHABLE);
  });

  it('explains timeouts and aborted requests', () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(friendlyError(abort)).toMatch(/took too long/);
    expect(friendlyError(new Error('Room request timed out'))).toMatch(/took too long/);
  });

  it('explains a wrong or full table code without saying which', () => {
    expect(friendlyError(new Error('Room not found'))).toMatch(/No open table with that code/);
    expect(friendlyError(new Error('Room is full'))).toMatch(/No open table with that code/);
    expect(friendlyError(new Error('Room not found or full'))).toMatch(/No open table with that code/);
  });

  it('explains rate limits and server failures', () => {
    expect(friendlyError(new Error('Too many requests'))).toMatch(/Too many attempts/);
    expect(friendlyError(new Error('Request failed (500)'))).toMatch(/had a problem/);
  });

  it('keeps the clubs API’s own readable messages', () => {
    expect(friendlyError(new Error('Club not found'))).toBe('Club not found.');
    expect(friendlyError(new Error('Only admins can open tables in this club'))).toBe('Only admins can open tables in this club.');
    expect(friendlyError(new Error('The owner cannot leave; transfer ownership first'))).toBe('The owner cannot leave; transfer ownership first.');
  });

  it('hides technical messages', () => {
    expect(friendlyError(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe(GENERIC);
    expect(friendlyError(new TypeError("Cannot read properties of undefined (reading 'room')"))).toBe(GENERIC);
    expect(friendlyError(new Error('ceremony_failed'))).toBe(GENERIC);
    expect(friendlyError(new Error('x'.repeat(200)))).toBe(GENERIC);
  });

  it('copes with values that are not errors', () => {
    expect(friendlyError(undefined)).toBe(GENERIC);
    expect(friendlyError(null)).toBe(GENERIC);
    expect(friendlyError({})).toBe(GENERIC);
    expect(friendlyError('Failed to fetch')).toBe(UNREACHABLE);
    expect(friendlyError(new Error(''))).toBe(GENERIC);
  });
});
