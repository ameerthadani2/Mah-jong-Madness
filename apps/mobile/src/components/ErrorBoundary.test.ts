import { describe, expect, it } from 'vitest';
import { ERROR_SCREEN_ACTIONS, staysFailed } from './ErrorBoundary.logic';
import en from '../i18n/locales/en/common.json';
import zh from '../i18n/locales/zh-TW/common.json';

describe('the screen error boundary', () => {
  it('keeps the fallback while the failed screen is still the one shown', () => {
    expect(staysFailed(true, 'club:AB12', 'club:AB12')).toBe(true);
  });

  it('tries again once the player moves to another screen', () => {
    expect(staysFailed(true, 'club:AB12', 'home')).toBe(false);
    expect(staysFailed(false, 'home', 'home')).toBe(false);
  });
});

describe('what the error screen offers', () => {
  it('offers Home first, then a second action that clears the saved table', () => {
    expect(ERROR_SCREEN_ACTIONS.map((a) => a.id)).toEqual(['home', 'clear']);
    expect(ERROR_SCREEN_ACTIONS.filter((a) => a.clearsSavedTable).map((a) => a.testID)).toEqual(['screen-error-clear']);
  });

  it('names every action in both languages', () => {
    for (const locale of [en, zh]) {
      const crash = locale.crash as Record<string, string>;
      for (const action of ERROR_SCREEN_ACTIONS) expect(crash[action.label.replace('common.crash.', '')]).toBeTruthy();
      expect(crash.clearHint).toBeTruthy();
    }
    expect((en.crash as Record<string, string>).clear).toMatch(/clear/i);
  });
});
