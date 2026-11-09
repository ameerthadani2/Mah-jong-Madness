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

  it('leaves other errors to the general error copy', () => {
    expect(tableErrorMessage(new Error('Failed to fetch'))).toBeNull();
    expect(tableError(new Error('Failed to fetch'), tr('en'))).toBe(i18n.t('errors.unreachable', { locale: 'en' }));
  });
});
