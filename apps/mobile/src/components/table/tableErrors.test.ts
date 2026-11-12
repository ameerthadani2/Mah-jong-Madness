import { describe, expect, it } from 'vitest';
import { I18n } from 'i18n-js';
import { en, zhTW } from '../../i18n/locales';
import { tableError, tableErrorMessage } from './tableErrors';

const i18n = new I18n({ en, 'zh-TW': zhTW });
const tr = (locale: string) => (key: string, params?: Record<string, unknown>) => i18n.t(key, { ...params, locale });

describe('table join and lobby errors', () => {
  it('localises the refusals by code', () => {
    expect(tableErrorMessage({ code: 'already_seated', message: 'x' })?.key).toBe('online.errors.alreadySeated');
    expect(tableErrorMessage({ code: 'room_unavailable', message: 'x' })?.key).toBe('online.errors.roomUnavailable');
    expect(tableErrorMessage({ code: 'table_cap', message: 'x' })?.key).toBe('online.errors.tableCap');
    expect(tableErrorMessage({ code: 'not_controller', message: 'x' })?.key).toBe('online.errors.notController');
  });

  it('recognises the servers’ sentences when only the message survives', () => {
    expect(tableErrorMessage(new Error('This account already has a seat at this table.'))?.key).toBe('online.errors.alreadySeated');
    expect(tableErrorMessage('Room not found or full')?.key).toBe('online.errors.roomUnavailable');
    expect(tableErrorMessage(new Error('The server is full right now; please try again in a few minutes'))?.key).toBe('online.errors.serverFull');
    expect(tableErrorMessage(new Error('You already have the most tables open; finish or leave one first'))?.key).toBe('online.errors.tableCap');
  });

  it('shows Chinese copy in zh-TW, never the server’s English sentence', () => {
    const zh = tableError({ code: 'already_seated', message: 'This account already has a seat at this table.' }, tr('zh-TW'));
    expect(zh).not.toMatch(/[A-Za-z]{4,}/);
    expect(tableError({ code: 'not_controller', message: 'x' }, tr('zh-TW'))).not.toMatch(/[A-Za-z]{4,}/);
    expect(tableError({ code: 'already_seated', message: 'x' }, tr('en'))).toMatch(/one seat/i);
  });

  it('reads a code only from its own list, never from the prototype', () => {
    for (const code of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) expect(tableErrorMessage({ code, message: '' }), code).toBeNull();
  });

  it('leaves other errors to the general error copy', () => {
    expect(tableErrorMessage(new Error('Failed to fetch'))).toBeNull();
    expect(tableError(new Error('Failed to fetch'), tr('en'))).toBe(i18n.t('errors.unreachable', { locale: 'en' }));
  });

  it('tells a watcher who made way for a player to join again', () => {
    // The signalling error as the game server sends it: code `closed` and its sentence.
    const dropped = { code: 'closed', message: 'A player needed your place at this table; join again to sit down.' };
    expect(tableErrorMessage(dropped)).toEqual({ key: 'online.errors.watcherDropped' });
    expect(tableErrorMessage(dropped.message)).toEqual({ key: 'online.errors.watcherDropped' });
    expect(tableError(dropped, tr('en'))).toBe('A player needed your place at this table. Join the table again to sit down.');
    expect(tableError(dropped, tr('zh-TW'))).not.toMatch(/[A-Za-z]{4,}/);
    // Another room that closed keeps its own line.
    expect(tableErrorMessage({ code: 'closed', message: 'The club closed this table.' })).toEqual({ key: 'online.errors.tableClosedByClub' });
  });
});
