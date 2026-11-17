/**
 * A call-out at the table (碰, 槓, 胡 …) as a screen reader meets it: a live region on Android and the web, and an
 * announcement on iOS, which ignores live regions.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { render } from '@testing-library/react-native';
import { CallBanner } from './CallBanner';

/** Platform.OS for one test (jest-expo runs as iOS); put back after each test. */
const realOS = Platform.OS;
function setOS(os: typeof Platform.OS) {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}
afterEach(() => setOS(realOS));

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function banner(os: 'ios' | 'android') {
  jest.useFakeTimers();
  setOS(os);
  const said = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  return { said, show: () => render(<CallBanner callout={{ call: 'pong', seat: 1, key: 1 }} name="Ah Hua" onDone={() => {}} />) };
}

describe('a call-out banner', () => {
  it('is left to the live region on Android, so it is not read twice', async () => {
    const { said, show } = banner('android');
    await show();
    expect(said.mock.calls).toEqual([]);
  });

  it('is announced on iOS, naming who called what', async () => {
    const { said, show } = banner('ios');
    await show();
    expect(said).toHaveBeenCalledTimes(1);
    expect(said.mock.calls[0][0]).toMatch(/Ah Hua/);
    expect(said.mock.calls[0][0]).toMatch(/碰|Pong/);
  });
});
