import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { HomeScreen } from './HomeScreen';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, type ActiveSession } from '../storage';
import { FakeProviders, sessionClient } from '../test/providers';
import { consent, telemetryAvailable } from '../telemetry';
import { resetAgeGateForTests } from '../legal/useAgeGate';
import { storeServer } from '../monetisation/server';
import type { Session } from '../game/session';
import type { AppState } from '../app-state';

/**
 * Home's own buttons (each card's, the links under them, the top bar), starting a match over a saved table, the first
 * run's name card, and the one-time privacy question that comes after the age gate in a build with telemetry keys.
 */
const SAVED: ActiveSession = { kind: 'local', host: { snapshot: { handNumber: 2 } } as never, token: 't', name: 'Mei', avatar: 'panda', savedAt: 0 };

jest.setTimeout(30_000);

let opened: Session[] = [];
beforeEach(async () => {
  // A returning adult player: the age gate is answered (src/legal/useAgeGate.ts reads it from storage).
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
  resetAgeGateForTests();
  opened = [];
});
afterEach(() => {
  for (const s of opened) s.close();
});

async function renderHome(app: Partial<AppState> = {}, signedIn = false) {
  const calls = {
    go: jest.fn(),
    setSettings: jest.fn(),
    setProfile: jest.fn(),
    setActiveSession: jest.fn(),
    setSession: jest.fn((s: Session | null) => {
      if (s) opened.push(s);
    }),
  };
  await render(
    <FakeProviders app={{ profile: { ...DEFAULT_PROFILE, name: 'Mei' }, ...calls, ...app }} auth={signedIn ? { status: 'guest', client: sessionClient('u-1'), user: { id: 'u-1' } as never } : {}}>
      <HomeScreen />
    </FakeProviders>,
  );
  await screen.findByTestId('open-learn');
  return calls;
}

describe("Home's buttons", () => {
  // A match started here runs its bots on timers: fake ones, cleared after each test, leave none running.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('each card and link opens its screen', async () => {
    const calls = await renderHome();
    const opens: Array<[string, string]> = [
      ['open-clubs', 'clubs'],
      ['open-quickmatch', 'quickmatch'],
      ['open-learn', 'learn'],
      ['open-shop-card', 'shop'],
      ['open-shop', 'shop'],
      ['open-settings', 'settings'],
    ];
    for (const [id, name] of opens) {
      calls.go.mockClear();
      await fireEvent.press(screen.getByTestId(id));
      expect(calls.go).toHaveBeenCalledWith({ name });
    }
    for (const [label, name] of [
      ['Quick table', 'online'],
      ['Daily puzzle', 'daily'],
      ['Mei. Settings', 'settings'],
    ]) {
      calls.go.mockClear();
      await fireEvent.press(screen.getByLabelText(label));
      expect(calls.go).toHaveBeenCalledWith({ name });
    }
  });

  it('Play now starts an offline match against the bots and opens the table', async () => {
    const calls = await renderHome({ settings: { ...DEFAULT_SETTINGS, botSkill: 'beginner' } });
    await fireEvent.press(screen.getByTestId('start-match'));
    expect(calls.setSession).toHaveBeenCalledTimes(1);
    const session = opened[0];
    expect(session.mode).toBe('local');
    expect(calls.go).toHaveBeenCalledWith({ name: 'table' });
  });

  it('the Pro bots chip, locked without Coach Gold, opens the Shop; another level is chosen in place', async () => {
    const calls = await renderHome();
    // Announced as a working button that says it is locked and opens the Shop, not as disabled.
    const pro = screen.getByRole('button', { name: /^Pro.*, locked: opens the Shop$/ });
    expect(pro).toBeEnabled();
    expect(pro.props.accessibilityState?.disabled).toBeFalsy();
    await fireEvent.press(pro);
    expect(calls.go).toHaveBeenCalledWith({ name: 'shop' });
    expect(calls.setSettings).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: /^Beginner/ }));
    expect(calls.setSettings).toHaveBeenCalledWith(expect.objectContaining({ botSkill: 'beginner' }));
  });

  it('with a table saved, Play now asks before a new match takes its place', async () => {
    const calls = await renderHome({ activeSession: SAVED });
    await fireEvent.press(screen.getByTestId('start-match'));
    expect(screen.getByText('Start a new match?')).toBeOnTheScreen();
    expect(calls.setSession).not.toHaveBeenCalled();
    await fireEvent.press(within(screen.getByTestId('replace-table')).getByRole('button', { name: 'Keep my table' }));
    expect(screen.queryByText('Start a new match?')).toBeNull();
    expect(calls.setSession).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('start-match'));
    await fireEvent.press(within(screen.getByTestId('replace-table')).getByRole('button', { name: 'Start new match' }));
    expect(calls.setSession).toHaveBeenCalledTimes(1);
    expect(calls.go).toHaveBeenCalledWith({ name: 'table' });
  });

  it('on a first run, the welcome card saves the name typed and starts the match', async () => {
    const calls = await renderHome({ profile: { ...DEFAULT_PROFILE, name: '' } });
    expect(screen.getByText('Welcome!')).toBeOnTheScreen();
    expect(screen.getByTestId('save-name')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('name-input'), '  Lin  ');
    await fireEvent.press(screen.getAllByTestId('start-match')[0]);
    expect(calls.setProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lin' }));
    expect(opened[0]?.mode).toBe('local');
  });
});

describe('the one-time privacy question', () => {
  const was = { ...telemetryAvailable };
  beforeAll(() => {
    Object.assign(telemetryAvailable, { analytics: true, crash: true });
  });
  afterAll(() => {
    Object.assign(telemetryAvailable, was);
  });
  beforeEach(async () => {
    await consent.load();
    consent.dispatch({ type: 'reset' });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function renderAsked(signedIn = false) {
    const send = jest.spyOn(storeServer, 'sendAnalyticsConsent').mockResolvedValue(undefined as never);
    await render(
      <FakeProviders app={{ profile: { ...DEFAULT_PROFILE, name: 'Mei' } }} auth={signedIn ? { status: 'guest', client: sessionClient('u-1'), user: { id: 'u-1' } as never } : {}}>
        <HomeScreen />
      </FakeProviders>,
    );
    await screen.findByTestId('consent-question');
    return send;
  }

  it('comes before Home, lists both services, and offers two equal answers', async () => {
    await renderAsked();
    expect(screen.queryByTestId('open-learn')).toBeNull();
    expect(screen.getByText('Usage statistics and crash reports')).toBeOnTheScreen();
    expect(screen.getByText('Usage statistics')).toBeOnTheScreen();
    expect(screen.getByText('Crash reports')).toBeOnTheScreen();
    const no = screen.getByRole('button', { name: 'No, do not send' });
    const yes = screen.getByRole('button', { name: 'Yes, send them' });
    expect(no.props.testID).toBe('consent-no');
    expect(yes.props.testID).toBe('consent-yes');
  });

  it('No turns both off, is remembered, and Home follows; the server is told when there is a session', async () => {
    const send = await renderAsked(true);
    await fireEvent.press(screen.getByRole('button', { name: 'No, do not send' }));
    await act(async () => undefined);
    expect(consent.effective).toEqual({ analytics: false, crash: false });
    expect(screen.queryByTestId('consent-question')).toBeNull();
    expect(await screen.findByTestId('open-learn')).toBeOnTheScreen();
    expect(send).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('Yes turns both on; with no session the server is not called yet', async () => {
    const send = await renderAsked(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, send them' }));
    await act(async () => undefined);
    expect(consent.effective).toEqual({ analytics: true, crash: true });
    expect(await screen.findByTestId('open-learn')).toBeOnTheScreen();
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for the age question on a fresh install, and follows it', async () => {
    await AsyncStorage.removeItem('mjm.age');
    resetAgeGateForTests();
    // A fresh install has no name yet either: Home asks the age first.
    await render(
      <FakeProviders app={{ profile: { ...DEFAULT_PROFILE, name: '' } }}>
        <HomeScreen />
      </FakeProviders>,
    );
    expect(await screen.findByTestId('age-gate')).toBeOnTheScreen();
    expect(screen.queryByTestId('consent-question')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('age-year'), '1990');
    await fireEvent.press(screen.getByTestId('age-continue'));
    expect(await screen.findByTestId('consent-question')).toBeOnTheScreen();
  });

  it('is not asked again once answered', async () => {
    consent.dispatch({ type: 'answer', agree: false, about: { analytics: true, crash: true } });
    await render(
      <FakeProviders app={{ profile: { ...DEFAULT_PROFILE, name: 'Mei' } }}>
        <HomeScreen />
      </FakeProviders>,
    );
    expect(await screen.findByTestId('open-learn')).toBeOnTheScreen();
    expect(screen.queryByTestId('consent-question')).toBeNull();
  });
});
