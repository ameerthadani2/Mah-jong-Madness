import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { DEFAULT_RULES } from '@mjm/engine';
import { TableScreen } from './TableScreen';
import { createLocalSession, type Session } from '../game/session';
import { validActiveSession } from '../logic/activeSession';
import { setLocalePreference } from '../i18n';
import type { ActiveSession } from '../storage';
import { FakeProviders } from '../test/providers';

/**
 * A saved offline table read back with its rules damaged (logic/activeSession.ts): when both copies are damaged the
 * table resumes on the default rules and says so, in either language; when one copy is intact it resumes on that
 * copy without a word. The deal comes from a fixed random sequence (as in TablePlay.render.test.tsx).
 */
jest.setTimeout(60_000);

const sessions: Session[] = [];
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 17, 9) });
  let state = 20261117;
  jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      buf[i] = (state >>> 0) & 0xff;
    }
    return buf;
  }) as never);
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
  setLocalePreference('auto');
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const RULES = { ...DEFAULT_RULES, basePoints: 300 };

/** A table in play, saved and read back as Home's Resume does, with its two copies of the rules replaced. */
async function resumed(tableCopy: unknown, handCopy: unknown) {
  const live = createLocalSession('Mei', 'panda', RULES);
  sessions.push(live);
  live.host!.start();
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  const host = JSON.parse(JSON.stringify(live.host!.serialize())) as Record<string, unknown>;
  const raw = { kind: 'local', host: { ...host, rules: tableCopy, game: { ...(host.game as object), rules: handCopy } }, token: live.client.state.token ?? 'tok', name: 'Mei', avatar: 'panda', savedAt: Date.now() };
  live.close();
  const rec = validActiveSession(raw, Date.now()) as Extract<ActiveSession, { kind: 'local' }>;
  const session = createLocalSession(rec.name, rec.avatar, rec.host.rules, { restore: { host: rec.host, token: rec.token, rulesReset: rec.rulesReset } });
  sessions.push(session);
  await render(
    <FakeProviders app={{ session, setSession: jest.fn(), setActiveSession: jest.fn(), screen: { name: 'table' } }}>
      <TableScreen />
    </FakeProviders>,
  );
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
  return session;
}

describe('a resumed table whose saved rules were damaged', () => {
  it('says it carries on with the default rules when both copies were damaged, then lets the notice go', async () => {
    const session = await resumed({}, { deadWallSize: 'lots' });
    expect(session.rulesReset).toBe(true);
    expect(screen.getByTestId('rules-reset-notice')).toHaveTextContent("This table's saved rules were damaged, so it carries on with the default rules.");
    await act(async () => {
      jest.advanceTimersByTime(9000);
    });
    expect(screen.queryByTestId('rules-reset-notice')).toBeNull();
  });

  it('says so in Chinese too', async () => {
    setLocalePreference('zh-TW');
    await resumed({}, {});
    expect(screen.getByTestId('rules-reset-notice')).toHaveTextContent('這桌儲存的規則已損壞，所以改用預設規則繼續。');
  });

  it('resumes on the intact copy without a word when only one copy was damaged', async () => {
    const session = await resumed({}, RULES);
    expect(session.rulesReset).toBeUndefined();
    expect(session.host!.serialize().rules).toEqual(RULES);
    expect(screen.queryByTestId('rules-reset-notice')).toBeNull();
  });
});
