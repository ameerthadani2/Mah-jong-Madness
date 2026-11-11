import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backoffSeconds, CONNECTED, forgetsTable, isWatcherMadeWay, linkCopy, linkEnded, linkNotice, MAX_RECONNECT_ATTEMPTS, nextDelayMs, reconnectStep, type LinkNotice, type ReconnectEvent, type ReconnectState } from './reconnect';
import { translator } from './translator.fixture';

const run = (events: ReconnectEvent[], from: ReconnectState = CONNECTED) => events.reduce((s, e) => reconnectStep(s, e), from);

describe('backoffSeconds', () => {
  it('doubles from one second and caps at a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(backoffSeconds)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
    expect(backoffSeconds(100)).toBe(60);
  });

  it('treats nonsense attempts as the first', () => {
    expect(backoffSeconds(0)).toBe(1);
    expect(backoffSeconds(-3)).toBe(1);
  });
});

describe('reconnectStep', () => {
  it('starts reconnecting at attempt 1 when the socket closes', () => {
    const s = run([{ type: 'closed' }]);
    expect(s).toEqual({ status: 'reconnecting', attempt: 1, reason: null });
    expect(nextDelayMs(s)).toBe(1000);
  });

  it('counts failed attempts with a growing delay', () => {
    const s = run([{ type: 'closed' }, { type: 'failed' }, { type: 'failed' }, { type: 'failed' }]);
    expect(s).toEqual({ status: 'reconnecting', attempt: 4, reason: null });
    expect(nextDelayMs(s)).toBe(8000);
  });

  it('is connected again after a successful attempt, with the count reset', () => {
    const s = run([{ type: 'closed' }, { type: 'failed' }, { type: 'succeeded' }]);
    expect(s).toEqual(CONNECTED);
    expect(nextDelayMs(s)).toBeNull();
    expect(run([{ type: 'closed' }], s).attempt).toBe(1);
  });

  it('gives up after ten failed attempts', () => {
    const fails = Array.from({ length: MAX_RECONNECT_ATTEMPTS - 1 }, (): ReconnectEvent => ({ type: 'failed' }));
    const almost = run([{ type: 'closed' }, ...fails]);
    expect(almost).toEqual({ status: 'reconnecting', attempt: 10, reason: null });
    const lost = reconnectStep(almost, { type: 'failed' });
    expect(lost).toEqual({ status: 'lost', attempt: 10, reason: 'exhausted' });
    expect(nextDelayMs(lost)).toBeNull();
  });

  it('gives up at once when the server refuses the session (4401)', () => {
    expect(run([{ type: 'closed' }, { type: 'failed', unauthorised: true }])).toEqual({ status: 'lost', attempt: 1, reason: 'unauthorised' });
    expect(run([{ type: 'unauthorised' }])).toMatchObject({ status: 'lost', reason: 'unauthorised' });
  });

  it('gives up at once when the server says the room is gone, instead of backing off ten times', () => {
    const lost = run([{ type: 'closed' }, { type: 'failed', gone: true }]);
    expect(lost).toEqual({ status: 'lost', attempt: 1, reason: 'gone' });
    expect(nextDelayMs(lost)).toBeNull();
    expect(run([{ type: 'closed' }, { type: 'failed' }, { type: 'failed', gone: true }])).toMatchObject({ status: 'lost', attempt: 2, reason: 'gone' });
  });

  it('ignores events that do not apply', () => {
    expect(reconnectStep(CONNECTED, { type: 'failed' })).toBe(CONNECTED);
    expect(reconnectStep(CONNECTED, { type: 'succeeded' })).toBe(CONNECTED);
    const r = run([{ type: 'closed' }, { type: 'failed' }]);
    expect(reconnectStep(r, { type: 'closed' })).toBe(r);
    const lost = run([{ type: 'unauthorised' }]);
    expect(reconnectStep(lost, { type: 'closed' })).toBe(lost);
    expect(reconnectStep(lost, { type: 'succeeded' })).toBe(lost);
    expect(reconnectStep(lost, { type: 'ended' })).toBe(lost);
  });

  it('stops when the match ends or the player leaves', () => {
    expect(run([{ type: 'closed' }, { type: 'ended' }])).toMatchObject({ status: 'lost', reason: 'ended' });
  });
});

describe('a watcher who made way for a player', () => {
  it('is lost at once, from a live link or a reconnect, and is never retried', () => {
    const lost = reconnectStep(CONNECTED, { type: 'madeWay' });
    expect(lost).toEqual({ status: 'lost', attempt: 0, reason: 'madeWay' });
    expect(nextDelayMs(lost)).toBeNull();
    expect(run([{ type: 'closed' }, { type: 'failed' }, { type: 'madeWay' }])).toEqual({ status: 'lost', attempt: 2, reason: 'madeWay' });
    // Nothing that happens to the dead socket afterwards starts a reconnect.
    for (const e of [{ type: 'closed' }, { type: 'failed' }, { type: 'succeeded' }] as ReconnectEvent[]) expect(reconnectStep(lost, e)).toBe(lost);
  });

  it('does not replace an ending that came first', () => {
    const ended = run([{ type: 'ended' }]);
    expect(reconnectStep(ended, { type: 'madeWay' })).toBe(ended);
    const gone = run([{ type: 'closed' }, { type: 'failed', gone: true }]);
    expect(reconnectStep(gone, { type: 'madeWay' })).toBe(gone);
  });

  it('is recognised by the sentence the game server sends', () => {
    // The sentence as the server has it today: if it is reworded there, this fails here.
    const rooms = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'signal', 'src', 'rooms.ts'), 'utf8');
    const sentence = /export const WATCHER_DROPPED = '([^']+)';/.exec(rooms)?.[1];
    expect(sentence).toBeTruthy();
    expect(isWatcherMadeWay(sentence)).toBe(true);
    expect(isWatcherMadeWay('A player needed your place at this table; join again to sit down.')).toBe(true);
    for (const other of ['The club closed this table.', 'The host left, so the room has closed', 'The club removed you from this table.', '', undefined, null, 7]) expect(isWatcherMadeWay(other), String(other)).toBe(false);
  });
});

describe('what the lobby and the table say about the link', () => {
  const live = { kicked: false, disconnected: false };
  const down = { kicked: false, disconnected: true };
  const replaced = { kicked: true, disconnected: false };

  it('is silent while connected', () => {
    expect(linkNotice(CONNECTED, live)).toBeNull();
    expect(linkNotice(CONNECTED, null)).toBeNull();
    expect(linkEnded(null)).toBe(false);
  });

  it('says "reconnecting" while the session is rejoining by itself', () => {
    const s = run([{ type: 'closed' }]);
    expect(linkNotice(s, down)).toBe('reconnecting');
    expect(linkEnded('reconnecting')).toBe(false);
  });

  it('says the seat was opened on another device, whatever else is true of the link', () => {
    expect(linkNotice(run([{ type: 'ended' }]), replaced)).toBe('seatTaken');
    // Before the session has caught up, and after the socket has dropped as well.
    expect(linkNotice(CONNECTED, replaced)).toBe('seatTaken');
    expect(linkNotice(run([{ type: 'ended' }]), { kicked: true, disconnected: true })).toBe('seatTaken');
    expect(linkNotice(run([{ type: 'closed' }]), replaced)).toBe('seatTaken');
  });

  it('tells a watcher who made way from a table that is gone and from a lost link', () => {
    expect(linkNotice(run([{ type: 'madeWay' }]), down)).toBe('madeWay');
    expect(linkNotice(run([{ type: 'closed' }, { type: 'failed', gone: true }]), down)).toBe('gone');
    expect(linkNotice(run([{ type: 'unauthorised' }]), down)).toBe('lost');
    expect(linkNotice(CONNECTED, down)).toBe('lost');
  });

  it('forgets the saved table only when the server no longer has it', () => {
    const all: LinkNotice[] = ['seatTaken', 'madeWay', 'reconnecting', 'gone', 'lost', null];
    expect(all.filter(forgetsTable)).toEqual(['gone']);
    expect(all.filter(linkEnded)).toEqual(['seatTaken', 'madeWay', 'gone', 'lost']);
  });

  it('has a title, a sentence and a way out for every ending, in both languages and on both screens', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const t = translator(locale);
      for (const where of ['table', 'lobby'] as const) {
        for (const notice of ['seatTaken', 'madeWay', 'gone', 'lost'] as const) {
          const copy = linkCopy(notice, where);
          for (const key of [copy.title, copy.text, copy.leave]) expect(t(key), `${locale} ${where} ${notice} ${key}`).toBeTruthy();
          if (locale === 'zh-TW') expect(`${t(copy.title)}${t(copy.text)}${t(copy.leave)}`, `${where} ${notice}`).not.toMatch(/[A-Za-z]{3,}/);
        }
      }
    }
  });

  it('says exactly that the seat was opened on another device, and that this one will not reconnect by itself', () => {
    const en = translator('en');
    const zh = translator('zh-TW');
    for (const where of ['table', 'lobby'] as const) {
      const copy = linkCopy('seatTaken', where);
      expect(en(copy.text)).toMatch(/^This seat was opened on another device/);
      expect(en(copy.text)).toMatch(/will not reconnect by itself/);
      expect(zh(copy.text)).toMatch(/^這個座位已在另一台裝置上開啟/);
      expect(zh(copy.text)).toMatch(/不會自動重連/);
      // The way out leads to Home; "Reconnect" is offered only for a plain lost link.
      expect(en(copy.leave)).toBe('Back to Home');
      expect(zh(copy.leave)).toBe('回到首頁');
    }
    expect(en(linkCopy('lost', 'table').leave)).toBe('Reconnect');
    expect(en(linkCopy('lost', 'lobby').leave)).toBe('Reconnect');
  });

  it('tells a watcher who made way to join again, not that the table closed', () => {
    const en = translator('en');
    const zh = translator('zh-TW');
    for (const where of ['table', 'lobby'] as const) {
      const copy = linkCopy('madeWay', where);
      expect(copy.text).toBe('online.errors.watcherDropped');
      expect(en(copy.text)).toBe('A player needed your place at this table. Join the table again to sit down.');
      expect(zh(copy.text)).toMatch(/重新加入牌桌/);
      expect(en(copy.text)).not.toMatch(/closed|over|no longer/i);
      expect(en(copy.leave)).toBe('Back to Home');
    }
  });
});
